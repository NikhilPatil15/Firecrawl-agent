import type { LanguageModel } from "ai";
import type { ModelConfig } from "./types";

/**
 * Recursively delete every `const` key from a JSON-Schema-ish object.
 * Gemini's generateContent API rejects `const` (it only accepts `enum`),
 * and the @ai-sdk/google converter that should rewrite it isn't reliably
 * invoked from the bundled copy, so we sanitise the FINAL tool schemas
 * just before they leave the model — at the application boundary, where
 * the fix is guaranteed to run.
 */
function stripConstDeep(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) stripConstDeep(item);
    return;
  }
  delete (node as Record<string, unknown>).const;
  for (const value of Object.values(node as Record<string, unknown>)) {
    stripConstDeep(value);
  }
}

/** Strip `const` from the tool schemas inside a generate/stream args bag. */
function sanitizeGoogleArgs(args: Record<string, unknown>): Record<string, unknown> {
  const tools = args.tools as unknown[];
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const t = tool as { inputSchema?: unknown };
      if (t.inputSchema) {
        stripConstDeep(t.inputSchema);
      }
    }
  }
  return args;
}

/**
 * Wrap a Google LanguageModel so that every generate/stream call strips
 * `const` from the outgoing tool schemas — keeping Gemini happy.
 */
function wrapGoogleModel(model: LanguageModel): LanguageModel {
  const m = model as unknown as {
    doGenerate?: (options: Record<string, unknown>) => Promise<unknown>;
    doStream?: (options: Record<string, unknown>) => Promise<unknown>;
  };
  if (m.doGenerate) {
    const orig = m.doGenerate.bind(model);
    m.doGenerate = (options) => orig(sanitizeGoogleArgs(options));
  }
  if (m.doStream) {
    const orig = m.doStream.bind(model);
    m.doStream = (options) => orig(sanitizeGoogleArgs(options));
  }
  return model;
}

/**
 * Resolve a ModelConfig to an AI SDK LanguageModel instance.
 * API keys can come from the config itself or the apiKeys map.
 * The consuming app is responsible for sourcing keys (env vars, user input, etc).
 */
export async function resolveModel(
  config: ModelConfig,
  apiKeys?: Record<string, string>,
): Promise<LanguageModel> {
  const keyFor = (provider: string) =>
    config.apiKey || apiKeys?.[provider] || undefined;

  switch (config.provider) {
    case "gateway": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const provider = createOpenAI({
        apiKey: keyFor("gateway"),
        baseURL: "https://ai-gateway.vercel.sh/v1",
      });
      return provider.chat(config.model);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: keyFor("anthropic") })(config.model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: keyFor("openai") })(config.model);
    }
    case "custom-openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const baseURL = config.baseURL || apiKeys?.["custom-openai:baseURL"];
      if (!baseURL) {
        throw new Error("CUSTOM_OPENAI_BASE_URL is not configured for the custom-openai provider");
      }
      return createOpenAI({
        apiKey: keyFor("custom-openai"),
        baseURL,
      })(config.model);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return wrapGoogleModel(
        createGoogleGenerativeAI({ apiKey: keyFor("google") })(config.model) as unknown as LanguageModel,
      );
    }
    default: {
      // Catch the common "forgot the provider prefix" mistake.
      // If the "provider" looks like a model ID (contains a hyphen or dot),
      // the user probably set MODEL=my-model instead of MODEL=provider:my-model.
      const looksLikeModelId = /[-.]/.test(config.provider);
      const hint = looksLikeModelId
        ? `. Did you mean MODEL="anthropic:${config.provider}" or similar? Format is "provider:model-id"`
        : `. Supported: anthropic, openai, google, gateway, custom-openai`;
      throw new Error(`Unsupported provider: "${config.provider}"${hint}`);
    }
  }
}
