import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

// --- formatOutput ---

export const formatOutput = tool({
  description:
    "Format the final output as JSON or text. Call this when you have collected all data and are ready to present results.",
  inputSchema: z.object({
    // Use z.string instead of z.enum(...) to avoid JSON-schema generators
    // emitting unsupported keywords (e.g. `const`) during tool schema conversion.
    format: z.string().optional().describe('Output format ("json" | "text")'),
    data: z
      .unknown()
      .describe(
        "The data to format — can be a JSON string, object, array, or plain text",
      ),
  }),
  execute: async ({ format, data }) => {
    // The model sometimes nests { format, products, description } directly
    // inside `data` instead of at the tool's top level. Unpack gracefully.
    let resolvedFormat = format;
    let resolvedData = data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      if (!resolvedFormat && typeof d.format === "string") {
        resolvedFormat = d.format;
      }
      // If data has its own `data` key, the model double-nested it
      if (d.data !== undefined) {
        resolvedData = d.data;
      }
    }
    if (!resolvedFormat) resolvedFormat = "json";
    if (resolvedFormat !== "json" && resolvedFormat !== "text") {
      return {
        format: "json",
        content: JSON.stringify(
          { error: "invalid_format", message: 'format must be "json" or "text"' },
          null,
          2,
        ),
      };
    }

    switch (resolvedFormat) {
      case "json": {
        if (typeof resolvedData === "string") {
          try {
            JSON.parse(resolvedData);
            return { format: "json", content: resolvedData };
          } catch {
            return { format: "json", content: JSON.stringify(resolvedData, null, 2) };
          }
        }
        return { format: "json", content: JSON.stringify(resolvedData, null, 2) };
      }
      case "text":
        return {
          format: "text",
          content:
            typeof resolvedData === "string" ? resolvedData : JSON.stringify(resolvedData, null, 2),
        };
    }
  },
});

// --- bashExec ---

type BashInstance = {
  exec: (
    cmd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

const g = globalThis as unknown as { __firecrawlBash?: BashInstance };

function getSharedBash(): BashInstance | null {
  return g.__firecrawlBash ?? null;
}

function setSharedBash(b: BashInstance) {
  g.__firecrawlBash = b;
}

export async function initBashWithFiles(files: Record<string, string>) {
  const { Bash } = await import("just-bash");
  const bash = new Bash();
  setSharedBash(bash);
  for (const [filePath, content] of Object.entries(files)) {
    await bash.exec(`mkdir -p "$(dirname "${filePath}")"`);
    await bash.exec(
      `cat > "${filePath}" << 'FIRECRAWL_EOF'\n${content}\nFIRECRAWL_EOF`,
    );
  }
}

export async function listBashFiles(): Promise<
  { path: string; size: number }[]
> {
  const bash = getSharedBash();
  if (!bash) return [];
  const result = await bash.exec("ls -lR /data 2>/dev/null");
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  const files: { path: string; size: number }[] = [];
  let currentDir = "/data";
  for (const line of result.stdout.split("\n")) {
    if (line.endsWith(":")) {
      currentDir = line.slice(0, -1);
    } else if (line.trim() && !line.startsWith("total")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const size = parseInt(parts[4]) || 0;
        const name = parts.slice(8).join(" ") || parts[parts.length - 1];
        if (size > 0 && name)
          files.push({ path: `${currentDir}/${name}`, size });
      }
    }
  }
  return files;
}

export async function readBashFile(filePath: string): Promise<string> {
  const bash = getSharedBash();
  if (!bash) return "";
  const result = await bash.exec(`cat "${filePath}"`);
  return result.stdout;
}

export const bashExec = tool({
  description:
    "Execute a bash command in a sandboxed environment with a persistent filesystem. Available tools: jq, awk, sed, grep, sort, uniq, wc, head, tail, cut, tr, paste, cat, echo, printf, expr, ls, mkdir, rm, cp, mv, tee, xargs. NOT available: node, python, curl, wget, npm, pip, bc. For math use awk (e.g. awk 'BEGIN{print 10*1.5}') or expr. The filesystem persists between calls — write files in one call, read them in the next. Use jq for JSON processing, awk for text processing.",
  inputSchema: z.object({
    command: z
      .string()
      .describe(
        "The bash command to execute. Examples: 'echo data | jq .', 'awk -F, \\'NR>1{print $2}\\' /data/input.txt | sort | uniq -c | sort -rn'",
      ),
  }),
  execute: async ({ command }) => {
    let bash = getSharedBash();
    if (!bash) {
      const { Bash } = await import("just-bash");
      bash = new Bash();
      setSharedBash(bash);
    }
    const result = await bash.exec(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
});

// --- exportSkill ---

const firecrawlMethodEnum = z
  .string()
  .describe("The Firecrawl method or tool used in this step (string literal)");

const FIRECRAWL_METHODS = new Set([
  "search",
  "scrape",
  "scrape:query",
  "scrape:extract",
  "scrape:markdown",
  "interact",
  "interact:code",
  "map",
  "crawl",
  "extract",
  "agent",
  "bashExec",
  "formatOutput",
]);

const exportSkillInputSchema = z.object({
  name: z
    .string()
    .describe(
      "Kebab-case skill slug, e.g. 'yahoo-finance-financials'. Must be generic, not entity-specific.",
    ),
  description: z
    .string()
    .describe(
      "One-line description with {PARAM} placeholders for variable parts",
    ),
  parameters: z
    .array(
      z.object({
        name: z.string().describe("Parameter name, e.g. TICKER, URL, QUERY"),
        description: z.string().describe("What this parameter represents"),
        example: z
          .string()
          .describe("Example value, e.g. 'AAPL', 'https://example.com'"),
      }),
    )
    .describe("Variable parts of the procedure that change per run"),
  procedure: z
    .array(
      z.object({
        method: firecrawlMethodEnum,
        description: z
          .string()
          .describe("What this step does, using {PARAM} placeholders"),
        input: z
          .string()
          .optional()
          .describe(
            "The key input: URL pattern, query string, extraction prompt, or code snippet",
          ),
      }),
    )
    .describe("Ordered steps — each references a specific Firecrawl method"),
  dataFields: z
    .array(z.string())
    .optional()
    .describe("Field names the procedure extracts"),
  examplePrompts: z
    .array(z.string())
    .optional()
    .describe("Example user prompts with specific values filled in"),
  targets: z
    .array(
      z.object({
        urlPattern: z
          .string()
          .describe("URL pattern with {PARAM} placeholders"),
        fallbackQuery: z
          .string()
          .optional()
          .describe("Search query to rediscover this URL if stale"),
      }),
    )
    .optional()
    .describe("Key URL patterns used"),
});

type ExportSkillInput = z.infer<typeof exportSkillInputSchema>;

function renderSkillMd(input: ExportSkillInput): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`name: ${input.name}`);
  lines.push(`description: ${input.description}`);
  lines.push("category: Generated");
  lines.push("---");
  lines.push("");
  lines.push(
    `# ${input.name
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")}`,
  );
  lines.push("");

  // Parameters
  if (input.parameters.length > 0) {
    lines.push("## Parameters");
    lines.push("");
    for (const p of input.parameters) {
      lines.push(`- **{${p.name}}**: ${p.description} (e.g. \`${p.example}\`)`);
    }
    lines.push("");
  }

  // Procedure
  lines.push("## Procedure");
  lines.push("");
  for (let i = 0; i < input.procedure.length; i++) {
    const step = input.procedure[i];
    const methodLabel = step.method.includes(":") ? step.method : step.method;
    lines.push(`${i + 1}. **${methodLabel}** — ${step.description}`);
    if (step.input) {
      lines.push(`   \`\`\``);
      lines.push(`   ${step.input}`);
      lines.push(`   \`\`\``);
    }
  }
  lines.push("");

  // Targets
  if (input.targets?.length) {
    lines.push("## Targets");
    lines.push("");
    lines.push("| URL Pattern | Fallback Query |");
    lines.push("|---|---|");
    for (const t of input.targets) {
      lines.push(`| ${t.urlPattern} | ${t.fallbackQuery ?? "—"} |`);
    }
    lines.push("");
  }

  // Data fields
  if (input.dataFields?.length) {
    lines.push("## Data Fields");
    lines.push("");
    for (const f of input.dataFields) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  // Example prompts
  if (input.examplePrompts?.length) {
    lines.push("## Example Prompts");
    lines.push("");
    for (const p of input.examplePrompts) {
      lines.push(`- "${p}"`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Create an exportSkill tool that writes SKILL.md to the given directory.
 * The agent calls this after completing a task to save its procedure as a reusable skill.
 */
export function createExportSkillTool(skillsDir?: string) {
  return tool({
    description:
      "Export the current task as a reusable skill. Call this after completing a task and calling formatOutput. " +
      "Describe what you did in generalized terms — use {PARAM} placeholders instead of specific values. " +
      "Each procedure step must reference the specific Firecrawl method used: search, scrape (with query, extract, or markdown), interact (with code or prompt), map, crawl, extract, agent, bashExec, or formatOutput.",
    inputSchema: exportSkillInputSchema,
    execute: async (input) => {
      // Runtime validation to replace z.enum-based validation (which can
      // cause schema conversion to emit unsupported JSON-schema keywords).
      if (!input?.procedure?.length) {
        return {
          name: input?.name ?? "exported-skill",
          skillMd: "",
          saved: false,
          error: "missing_procedure",
        };
      }
      for (const step of input.procedure) {
        if (!FIRECRAWL_METHODS.has(step.method)) {
          return {
            name: input.name,
            skillMd: "",
            saved: false,
            error: "invalid_method",
            message: `Invalid procedure.method "${step.method}".`,
          };
        }
      }

      const skillMd = renderSkillMd(input);

      if (skillsDir) {
        try {
          const dir = path.join(skillsDir, input.name);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "SKILL.md"), skillMd, "utf-8");
          return {
            name: input.name,
            skillMd,
            savedPath: `skills/definitions/${input.name}/SKILL.md`,
            saved: true,
          };
        } catch {
          // Disk write failed (serverless, permissions) — return content anyway
        }
      }

      return { name: input.name, skillMd, saved: false };
    },
  });
}
