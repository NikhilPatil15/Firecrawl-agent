import { FirecrawlTools, scrapeBash } from "firecrawl-aisdk";
import type { FirecrawlToolsConfig, Toolkit } from "./types";

const DEFAULT_INTERACT_TIMEOUT_MS = 60_000;
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_DEFAULT_WAIT_MS = 3_000;
const SESSION_RETRY_MAX = 3;
const SESSION_RETRY_WAIT_MS = 5_000;

/**
 * Extract wait time from a Firecrawl rate-limit error message.
 * Looks for "retry after Ns" pattern; falls back to default.
 */
function parseRetryWaitMs(errorMsg: string): number {
  const match = errorMsg.match(/retry after (\d+)s/i);
  if (match) return (parseInt(match[1], 10) + 1) * 1_000; // +1s buffer
  return RATE_LIMIT_DEFAULT_WAIT_MS;
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) return /rate limit/i.test(err.message);
  if (typeof err === "string") return /rate limit/i.test(err);
  if (err && typeof err === "object" && "message" in err)
    return /rate limit/i.test(String((err as { message: unknown }).message));
  return false;
}

function isRateLimitResult(result: unknown): boolean {
  if (typeof result === "string") return /Rate limit exceeded/i.test(result);
  if (result && typeof result === "object") {
    const str = JSON.stringify(result);
    return /Rate limit exceeded/i.test(str);
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Detect Firecrawl's "we don't support this site" / enterprise-upsell error.
 * Firecrawl returns this verbatim string for any domain on their no-scrape
 * list (Amazon, sometimes Flipkart/Myntra, etc.). If we let it pass through
 * to the LLM, the LLM will faithfully relay the apology + typeform URL to
 * the user as the answer. We replace it with a clean, structured signal
 * that tells the agent "this domain is unavailable, try another."
 */
const UNSUPPORTED_SITE_PATTERNS: RegExp[] = [
  /we apologi[sz]e for the inconvenience.*do(?:n['']?| not) support this site/i,
  /this (?:domain|site|url) is (?:not supported|blocked|unavailable)/i,
  /enterprise.*intake form/i,
  /typeform\.com\/to\/Ej6oydlg/i,
];

function isUnsupportedSiteString(s: string): boolean {
  return UNSUPPORTED_SITE_PATTERNS.some((p) => p.test(s));
}

function isUnsupportedSiteResult(result: unknown): boolean {
  if (typeof result === "string") return isUnsupportedSiteString(result);
  if (result && typeof result === "object") {
    // Common shapes: { error: "..." } or nested in `output`, `result`, etc.
    try {
      return isUnsupportedSiteString(JSON.stringify(result));
    } catch {
      return false;
    }
  }
  return false;
}

function isUnsupportedSiteError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return msg ? isUnsupportedSiteString(msg) : false;
}

function extractDomainFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const candidates = [obj.url, obj.urls, obj.query, obj.target];
  for (const c of candidates) {
    if (typeof c === "string") {
      try { return new URL(c).hostname.replace(/^www\./, ""); } catch { /* not a url */ }
      // search query — return as-is (might mention site:)
      const siteMatch = c.match(/site:([^\s]+)/i);
      if (siteMatch) return siteMatch[1];
    }
    if (Array.isArray(c) && typeof c[0] === "string") {
      try { return new URL(c[0]).hostname.replace(/^www\./, ""); } catch { /* not a url */ }
    }
  }
  return null;
}

/** Clean, agent-readable envelope replacing Firecrawl's apology text. */
function unsupportedSiteEnvelope(input: unknown): {
  error: string;
  unsupportedSite: true;
  domain: string | null;
  hint: string;
} {
  const domain = extractDomainFromInput(input);
  return {
    error: domain
      ? `The domain ${domain} is not accessible via automated browsing. Try a different Indian retailer (croma.com, reliancedigital.in, vijaysales.com, snapdeal.com, tatacliq.com, pepperfry.com, nykaa.com, ajio.com, meesho.com).`
      : "This domain is not accessible via automated browsing. Try a different Indian retailer.",
    unsupportedSite: true,
    domain,
    hint: "Do NOT mention this error to the end user. Silently switch to a different store and continue. If three retailers fail in a row, give the user a brief natural message without quoting any vendor error text.",
  };
}

/**
 * Wrap every Firecrawl tool's `execute` so any "unsupported site" response
 * (string or object) is replaced with a clean envelope before the LLM sees it.
 * The LLM literally cannot relay verbatim text it never received.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapWithUnsupportedSiteScrubber<T extends { execute?: (...args: any[]) => any }>(
  tool: T | undefined,
): T | undefined {
  if (!tool?.execute) return tool;
  const original = (tool.execute as (input: unknown, opts?: unknown) => unknown).bind(tool);

  const wrapped = async (input: unknown, opts?: unknown) => {
    try {
      const result = await original(input, opts);
      if (isUnsupportedSiteResult(result)) {
        console.log("[firecrawl] unsupported-site response intercepted; replacing with clean envelope");
        return unsupportedSiteEnvelope(input);
      }
      return result;
    } catch (err) {
      if (isUnsupportedSiteError(err)) {
        console.log("[firecrawl] unsupported-site error intercepted; replacing with clean envelope");
        return unsupportedSiteEnvelope(input);
      }
      throw err;
    }
  };

  return { ...tool, execute: wrapped } as T;
}

function applyUnsupportedSiteScrub<T extends Record<string, unknown>>(tools: T): T {
  const wrapped = { ...tools };
  for (const key of Object.keys(wrapped)) {
    if (wrapped[key] && typeof wrapped[key] === "object" && "execute" in (wrapped[key] as object)) {
      (wrapped as Record<string, unknown>)[key] = wrapWithUnsupportedSiteScrubber(wrapped[key] as never);
    }
  }
  return wrapped;
}

/**
 * Deterministic guard against stale-year search queries. Models (especially
 * Haiku) habitually append a past year like "2024"/"2025" out of training
 * bias, which returns discontinued products and dead coupons. We rewrite any
 * past year in a tool's `query` to the CURRENT year before the call runs — so
 * it doesn't matter what the model typed.
 */
const CURRENT_YEAR = new Date().getFullYear();
function fixStaleYears(query: string): string {
  return query.replace(/\b20\d{2}\b/g, (m) => {
    const n = parseInt(m, 10);
    // 2000-2009 are prices, not years — never rewrite
    if (n >= 2000 && n <= 2009) return m;
    return n < CURRENT_YEAR ? String(CURRENT_YEAR) : m;
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapWithYearFix<T extends { execute?: (...args: any[]) => any }>(
  tool: T | undefined,
): T | undefined {
  if (!tool?.execute) return tool;
  const original = (tool.execute as (input: unknown, opts?: unknown) => unknown).bind(tool);
  const wrapped = async (input: unknown, opts?: unknown) => {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const obj = input as Record<string, unknown>;
      if (typeof obj.query === "string") {
        const fixed = fixStaleYears(obj.query);
        if (fixed !== obj.query) {
          console.log(`[firecrawl] year-fix query: "${obj.query}" -> "${fixed}"`);
          input = { ...obj, query: fixed };
        }
      }
    }
    return original(input, opts);
  };
  return { ...tool, execute: wrapped } as T;
}
function applyQueryYearFix<T extends Record<string, unknown>>(tools: T): T {
  const wrapped = { ...tools };
  for (const key of Object.keys(wrapped)) {
    if (wrapped[key] && typeof wrapped[key] === "object" && "execute" in (wrapped[key] as object)) {
      (wrapped as Record<string, unknown>)[key] = wrapWithYearFix(wrapped[key] as never);
    }
  }
  return wrapped;
}

/**
 * Detect Firecrawl concurrent browser session errors.
 * These occur when the previous interact session hasn't fully closed
 * (e.g. after a timeout or when back-to-back calls happen).
 */
const SESSION_ERROR_PATTERNS = [
  /concurrent/i,
  /active.?session/i,
  /session.?limit/i,
  /too many.?session/i,
  /browser.?(?:limit|busy|unavailable|in use)/i,
  /maximum.*(?:session|browser)/i,
  /already.*(?:active|running|in use)/i,
  /using \d+ of \d+/i,
];

function isSessionLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return SESSION_ERROR_PATTERNS.some((p) => p.test(msg));
}

function isSessionLimitResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const obj = result as Record<string, unknown>;
  const errorStr = typeof obj.error === "string" ? obj.error : "";
  return SESSION_ERROR_PATTERNS.some((p) => p.test(errorStr));
}

/**
 * Wrap the interact tool to auto-retry on concurrent session limit errors.
 * When Firecrawl rejects because a previous session is still alive (common
 * after timeouts), we wait and retry instead of failing immediately.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapWithSessionRetry<T extends { execute?: (...args: any[]) => any }>(
  tool: T | undefined,
): T | undefined {
  if (!tool?.execute) return tool;
  const original = (tool.execute as (input: unknown, opts?: unknown) => unknown).bind(tool);

  const wrapped = async (input: unknown, opts?: unknown) => {
    for (let attempt = 0; attempt <= SESSION_RETRY_MAX; attempt++) {
      try {
        const result = await original(input, opts);
        if (isSessionLimitResult(result) && attempt < SESSION_RETRY_MAX) {
          console.log(`[interact] session limit hit (attempt ${attempt + 1}/${SESSION_RETRY_MAX}), retrying in ${SESSION_RETRY_WAIT_MS}ms...`);
          await sleep(SESSION_RETRY_WAIT_MS);
          continue;
        }
        return result;
      } catch (err) {
        if (isSessionLimitError(err) && attempt < SESSION_RETRY_MAX) {
          console.log(`[interact] session limit error (attempt ${attempt + 1}/${SESSION_RETRY_MAX}): ${err instanceof Error ? err.message : err}, retrying in ${SESSION_RETRY_WAIT_MS}ms...`);
          await sleep(SESSION_RETRY_WAIT_MS);
          continue;
        }
        throw err;
      }
    }
  };

  return { ...tool, execute: wrapped } as T;
}

/**
 * Wrap a tool's execute to auto-retry on Firecrawl rate-limit errors.
 * Retries up to RATE_LIMIT_MAX_RETRIES times with the delay from the error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapWithRateLimitRetry<T extends { execute?: (...args: any[]) => any }>(
  tool: T | undefined,
): T | undefined {
  if (!tool?.execute) return tool;
  const original = (tool.execute as (input: unknown, opts?: unknown) => unknown).bind(tool);

  const wrapped = async (input: unknown, opts?: unknown) => {
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        const result = await original(input, opts);
        // Some SDKs return the error as a result rather than throwing
        if (isRateLimitResult(result) && attempt < RATE_LIMIT_MAX_RETRIES) {
          const waitMs = parseRetryWaitMs(JSON.stringify(result));
          await sleep(waitMs);
          continue;
        }
        return result;
      } catch (err) {
        if (isRateLimitError(err) && attempt < RATE_LIMIT_MAX_RETRIES) {
          const waitMs = parseRetryWaitMs(err instanceof Error ? err.message : String(err));
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
    }
  };

  return { ...tool, execute: wrapped } as T;
}

/**
 * Apply rate-limit retry to all tools in a tools object.
 */
function applyRateLimitRetry<T extends Record<string, unknown>>(tools: T): T {
  const wrapped = { ...tools };
  for (const key of Object.keys(wrapped)) {
    if (wrapped[key] && typeof wrapped[key] === "object" && "execute" in (wrapped[key] as object)) {
      (wrapped as Record<string, unknown>)[key] = wrapWithRateLimitRetry(wrapped[key] as never);
    }
  }
  return wrapped;
}

/**
 * Strip top-level null/undefined/empty-string fields from an interact tool
 * result so the LLM doesn't echo them.
 *
 * Firecrawl's /interact endpoint always returns the full response shape
 * — `{ output, result, stdout, stderr, exitCode, killed, … }` — populating
 * only the fields that apply to the mode used. In `prompt` mode, `output`
 * carries the natural-language answer and `result`/`stdout`/`stderr`/
 * `exitCode` all come back null or "". The LLM, when it composes its
 * reply, often echoes those null fields verbatim ("```\nnull\n```"), which
 * the Streamdown renderer then shows to the user as a bare "null" block.
 *
 * Cleaning the response at the tool layer stops the problem at its source
 * and keeps the model's context focused on the fields that carry data.
 * Empty arrays/objects are preserved — those can be meaningful signals
 * (e.g., `links: []` = "no links found").
 *
 * Exported for testing.
 */
export function stripInteractNulls(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Wrap a tool's `execute` so it races against a hard timeout AND strips
 * empty fields from the happy-path result. On timeout we abort the upstream
 * call via an `AbortController` and resolve with a structured error envelope
 * the UI / orchestrator can surface — instead of letting a stuck browser
 * session hang the whole agent loop. The envelope is returned as-is (not
 * stripped) so its signal fields (`timedOut`, `error`) survive.
 *
 * When `timeoutMs <= 0` the timeout is disabled but we still strip nulls,
 * so integrators who opt out of the deadline don't regress the UI fix.
 *
 * Exported for unit testing; `buildFirecrawlToolkit` is the only production
 * caller.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapInteractWithTimeout<T extends { execute?: (...args: any[]) => any }>(
  interactTool: T | undefined,
  timeoutMs: number,
): T | undefined {
  if (!interactTool?.execute) return interactTool;
  const original = (interactTool.execute as (input: unknown, opts?: unknown) => unknown).bind(interactTool);

  // No timeout requested — still wrap to strip nulls, otherwise the model
  // keeps echoing "null" code fences in prompt-mode replies.
  if (timeoutMs <= 0) {
    const stripOnly = async (input: unknown, opts?: unknown) =>
      stripInteractNulls(await original(input, opts));
    return { ...interactTool, execute: stripOnly } as T;
  }

  const wrapped = (input: unknown, opts?: unknown) => {
    const controller = new AbortController();
    const optsObj = (opts ?? {}) as { abortSignal?: AbortSignal };
    const upstream = optsObj.abortSignal;
    if (upstream) {
      if (upstream.aborted) controller.abort();
      else upstream.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const inputObj = (input ?? {}) as { url?: unknown; prompt?: unknown };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<unknown>((resolve) => {
      timer = setTimeout(() => {
        // Resolve the envelope BEFORE aborting so Promise.race sees our
        // timeout winner first. If we aborted first, an upstream `execute`
        // that resolves synchronously from its own abort listener could
        // beat us to the race.
        resolve({
          error: `Interact timed out after ${timeoutMs}ms. The browser session did not return within the limit — try a simpler prompt, break the task up, or fall back to scrape.`,
          timedOut: true,
          url: typeof inputObj.url === "string" ? inputObj.url : undefined,
          prompt: typeof inputObj.prompt === "string" ? inputObj.prompt : undefined,
        });
        controller.abort();
      }, timeoutMs);
    });

    const forwarded = { ...optsObj, abortSignal: controller.signal };
    // Strip nulls on the happy path only — the timeout envelope is a
    // structured error we want to preserve verbatim.
    const happyPath = Promise.resolve(original(input, forwarded)).then(stripInteractNulls);
    return Promise.race([happyPath, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };
  return { ...interactTool, execute: wrapped } as T;
}

/**
 * Build a Toolkit from a Firecrawl API key. This is the single place where
 * agent-core meets the Firecrawl SDK — all routes share this helper.
 *
 * When `bash: true`, replaces `scrape` with `scrapeBash` — a single tool
 * that loads pages into a WASM sandbox and queries them with rg/grep/sed.
 * The full markdown never enters the LLM context.
 *
 * When `onInteractSessionStart` is provided, it's forwarded to the interact
 * tool (plus `autoStart` if `interactAutoStart: true`) so integrators can
 * stream `liveViewUrl` to the UI the moment a browser session attaches.
 */
export function buildFirecrawlToolkit(
  firecrawlApiKey: string,
  config?: FirecrawlToolsConfig,
): Toolkit {
  const bashMode = config?.bash ?? false;
  const onInteractSessionStart = config?.onInteractSessionStart;
  const interactAutoStart = config?.interactAutoStart ?? false;
  const interactTimeoutMs = config?.interactTimeoutMs ?? DEFAULT_INTERACT_TIMEOUT_MS;

  // Strip our non-FirecrawlTools options before forwarding — they're
  // integrator-facing, not SDK-facing.
  const {
    bash: _bash,
    onInteractSessionStart: _oiss,
    interactAutoStart: _ias,
    interactTimeoutMs: _itms,
    interact: interactConfig,
    ...fcConfig
  } = (config ?? {}) as FirecrawlToolsConfig & {
    interact?: Record<string, unknown> | false;
  };

  // Merge caller-provided interact defaults with our autoStart / callback.
  const interactOpts =
    interactConfig === false
      ? false
      : {
          ...(interactConfig ?? {}),
          ...(interactAutoStart ? { autoStart: true } : {}),
          ...(onInteractSessionStart ? { onSessionStart: onInteractSessionStart } : {}),
        };

  const { systemPrompt, ...tools } = FirecrawlTools({
    apiKey: firecrawlApiKey,
    ...fcConfig,
    interact: interactOpts as never,
  });

  if (tools.interact) {
    tools.interact = wrapWithSessionRetry(
      wrapInteractWithTimeout(tools.interact, interactTimeoutMs),
    ) as typeof tools.interact;
  }

  // Apply rate-limit retry, then the unsupported-site scrubber on top so
  // Firecrawl's enterprise-upsell text never reaches the LLM's context.
  const retriedTools = applyQueryYearFix(applyUnsupportedSiteScrub(applyRateLimitRetry(tools)));

  if (bashMode) {
    const { scrape: _scrape, ...rest } = retriedTools;
    const bashTools = applyQueryYearFix({
      ...rest,
      scrapeBash: wrapWithUnsupportedSiteScrubber(wrapWithRateLimitRetry(scrapeBash) ?? scrapeBash),
    });

    return {
      tools: bashTools as never,
      systemPrompt: systemPrompt ?? undefined,
      createFiltered: (enabled) => {
        const opts: Record<string, unknown> = {
          apiKey: firecrawlApiKey,
          ...fcConfig,
          interact: interactOpts,
        };
        if (enabled) {
          if (!enabled.includes("search")) opts.search = false;
          if (!enabled.includes("scrape") && !enabled.includes("scrapeBash")) opts.scrape = false;
          if (!enabled.includes("interact")) opts.interact = false;
        }
        const { systemPrompt: _, scrape: _s, ...filtered } = FirecrawlTools(opts);
        if (filtered.interact) {
          filtered.interact = wrapInteractWithTimeout(filtered.interact, interactTimeoutMs) as typeof filtered.interact;
        }
        return applyQueryYearFix(applyUnsupportedSiteScrub(applyRateLimitRetry({ ...filtered, scrapeBash })));
      },
    };
  }

  return {
    tools: retriedTools as never,
    systemPrompt: systemPrompt ?? undefined,
    createFiltered: (enabled) => {
      const opts: Record<string, unknown> = {
        apiKey: firecrawlApiKey,
        ...fcConfig,
        interact: interactOpts,
      };
      if (enabled) {
        if (!enabled.includes("search")) opts.search = false;
        if (!enabled.includes("scrape")) opts.scrape = false;
        if (!enabled.includes("interact")) opts.interact = false;
      }
      const { systemPrompt: _, ...filtered } = FirecrawlTools(opts);
      if (filtered.interact) {
        filtered.interact = wrapInteractWithTimeout(filtered.interact, interactTimeoutMs) as typeof filtered.interact;
      }
      return applyQueryYearFix(applyUnsupportedSiteScrub(applyRateLimitRetry(filtered)));
    },
  };
}
