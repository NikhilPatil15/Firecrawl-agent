import { ToolLoopAgent, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import type { AgentConfig, ModelConfig, Toolkit } from "../types";
import { resolveModel } from "../resolve-model";
import { createSkillTools } from "../skills/tools";
import { createSubAgentTools } from "./sub-agents";
import { createWorkerTool } from "../worker";
import { formatOutput, bashExec, initBashWithFiles, createExportSkillTool } from "../tools";
import { discoverSkills } from "../skills/discovery";
import { loadOrchestratorPrompt, loadPromptFile } from "./loader";
import { createPrepareStepWithCompaction } from "./compaction";
import { extractFieldPaths } from "../schema-validate";

// --- Helpers ---

function buildSchemaBlock(schema?: Record<string, unknown>): string {
  if (!schema) return "";
  return `<required_schema>
CRITICAL: You MUST populate EXACTLY these fields and ONLY these fields. Do not add extra fields. Do not omit fields. Every field below must have a value scraped from a real source.
\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`
</required_schema>`;
}

function buildFieldChecklist(schema?: Record<string, unknown>): string {
  if (!schema) return "";
  const fields = extractFieldPaths(schema);
  if (fields.length === 0) return "";
  return `<field_checklist>
Before calling formatOutput, verify EVERY field below is populated. If a field is missing, go back and scrape for it. Do not submit partial data.
${fields.map((f) => `- [ ] ${f}`).join("\n")}
</field_checklist>`;
}

function buildColumnsBlock(columns?: string[]): string {
  if (!columns?.length) return "";
  return `Required columns (each is a data point to collect):\n${columns.map((c) => `- ${c}`).join("\n")}`;
}

function buildFormatInstructions(schema?: Record<string, unknown>, columns?: string[]): string {
  if (schema) {
    return `When finished, call formatOutput with format "json" and data that EXACTLY matches the required_schema. Every field must be present. No extra fields.`;
  }
  if (columns?.length) {
    return `When finished, call formatOutput with format "json" and include data with these columns: ${JSON.stringify(columns)}.`;
  }
  return "";
}

// --- Orchestrator factory ---

export interface OrchestratorOptions {
  config: AgentConfig;
  toolkit: Toolkit;
  apiKeys?: Record<string, string>;
  skillsDir?: string;
  maxWorkers?: number;
  workerMaxSteps?: number;
  compactionModel?: ModelConfig;
  /** App-specific prompt sections appended after the core system prompt */
  appSections?: string[];
}

export async function createOrchestrator(options: OrchestratorOptions) {
  const {
    config,
    toolkit,
    apiKeys,
    skillsDir,
    maxWorkers = 6,
    workerMaxSteps = 10,
    compactionModel,
  } = options;

  // 1. Resolve models
  const model = await resolveModel(config.model, apiKeys);
  const subAgentModel = config.subAgentModel
    ? await resolveModel(config.subAgentModel, apiKeys)
    : model;

  // 2. Discover skills
  const skills = await discoverSkills(skillsDir);

  // 3. Build tools
  const skillTools = createSkillTools(skills, config.skillInstructions);
  const subAgentTools = await createSubAgentTools(
    config.subAgents ?? [],
    toolkit,
    skills,
    subAgentModel,
    config.skillInstructions,
    apiKeys,
    { maxWorkers, workerMaxSteps },
  );
  const spawnAgents = createWorkerTool(model, toolkit, skills, {
    maxWorkers,
    workerMaxSteps,
  });
  const exportSkill = createExportSkillTool(skillsDir);

  // 4. Pre-seed bash filesystem with uploads
  const uploadedFiles: Record<string, string> = {};
  const uploadDescriptions: string[] = [];

  if (config.uploads?.length) {
    for (const upload of config.uploads) {
      const isText =
        upload.type.startsWith("text/") ||
        /\.(csv|tsv|json|md|txt|xml|yaml|yml|toml|ini|log|sql|html|css|js|ts|py|rb|sh)$/i.test(upload.name);
      const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = `/data/${safeName}`;
      uploadedFiles[isText ? filePath : filePath + ".b64"] = upload.content;
      uploadDescriptions.push(`${filePath} (${upload.type || upload.name.split(".").pop()})`);
    }
  }

  if (Object.keys(uploadedFiles).length > 0) {
    await initBashWithFiles(uploadedFiles);
  }

  // 5. Load and assemble prompt from prompt files
  const hasStructuredOutput = !!(config.schema || config.columns);
  const skillCatalog = skills.length
    ? `\n\nAvailable skills (use load_skill to activate):\n${skills.map((s) => `- ${s.name}: ${s.description.slice(0, 100)}`).join("\n")}`
    : "";

  // Context hints (URLs, uploads) — these are core because they're data, not policy
  const contextSections: string[] = [];
  if (config.urls?.length) {
    contextSections.push(`<user_urls>\nStart with these URLs: ${config.urls.join(", ")}\n</user_urls>`);
  }
  if (uploadDescriptions.length > 0) {
    contextSections.push(`<uploaded_files>\nThe user uploaded files to the bash filesystem:\n${uploadDescriptions.map((d) => `- ${d}`).join("\n")}\nUse bashExec to explore them: 'head -5 /data/file.txt', 'cat /data/file.json | jq .', 'wc -l /data/file.txt', etc.\n</uploaded_files>`);
  }

  // Export skill prompt (loaded when agent should save its procedure)
  if (config.exportSkill) {
    const exportPrompt = await loadPromptFile("export-skill.md");
    contextSections.push(exportPrompt);
  }

  const instructions = await loadOrchestratorPrompt(
    {
      TODAY: new Date().toISOString().split("T")[0],
      CURRENT_YEAR: String(new Date().getFullYear()),
      FIRECRAWL_SYSTEM_PROMPT: toolkit.systemPrompt ?? "",
      RESEARCH_PLAN: hasStructuredOutput
        ? `\n${buildSchemaBlock(config.schema)}\n${buildFieldChecklist(config.schema)}\n${buildColumnsBlock(config.columns)}`
        : "",
      WORKFLOW_STEPS: `
When handling a shopping request:
1. Determine what the user wants: product search, comparison, deals, coupons, or checkout assist.
2. If URLs are provided, call lookup_site_playbook for site-specific navigation.
3. Execute INLINE and FAST — search 2-3 Indian stores (plus one official brand store when relevant), and do ONE targeted scrape per store for the top few products (INCLUDING the imageUrl). Do NOT paginate. Do NOT spawnAgents for routine shopping. Gather 4-6 good candidates total, then stop — see the speed_policy.
4. For each product candidate, make sure you have: name, price (number, INR), imageUrl, source store, sourceUrl. If imageUrl is missing from the search/listing page, scrape the individual product page to get it — it is critical for the UI.
5. Write a SHORT text message (1-3 sentences) summarising your picks and explaining the Best Pick.
6. Call formatOutput with format="json" and a JSON array of product objects matching the exact schema in the output_contract. THE TASK IS NOT DONE UNTIL formatOutput IS CALLED — text-only answers will not show product cards to the user.`,
      SKILL_CATALOG: skillCatalog,
      SCHEMA_BLOCK: buildSchemaBlock(config.schema),
      FIELD_CHECKLIST: buildFieldChecklist(config.schema),
      COLUMNS_BLOCK: buildColumnsBlock(config.columns),
    },
    [...contextSections, ...(options.appSections ?? [])],
  );

  // 6. Context compaction
  const resolvedCompactionModel: LanguageModel = compactionModel
    ? await resolveModel(compactionModel, apiKeys)
    : model;
  const compaction = createPrepareStepWithCompaction(
    config.model.model,
    resolvedCompactionModel,
  );

  // 7. Create the AI SDK ToolLoopAgent
  return new ToolLoopAgent({
    model,
    instructions,
    tools: {
      ...toolkit.tools,
      ...skillTools,
      ...subAgentTools,
      spawnAgents,
      formatOutput,
      bashExec,
      ...(config.exportSkill ? { exportSkill } : {}),
    } as ToolSet,
    stopWhen: stepCountIs(config.maxSteps ?? 50),
    prepareStep: compaction.prepareStep,
    experimental_repairToolCall: async ({ toolCall, inputSchema }) => {
      try {
        const schema = await inputSchema({ toolName: toolCall.toolName });
        const allowedKeys = Object.keys(
          (schema as { properties?: Record<string, unknown> }).properties ?? {},
        );
        const parsed = JSON.parse(toolCall.input);
        const cleaned: Record<string, unknown> = {};
        for (const key of allowedKeys) {
          if (key in parsed) cleaned[key] = parsed[key];
        }
        return { ...toolCall, input: JSON.stringify(cleaned) };
      } catch {
        return toolCall;
      }
    },
  });
}
