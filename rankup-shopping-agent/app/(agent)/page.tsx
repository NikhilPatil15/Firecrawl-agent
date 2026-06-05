"use client";

import {
  use,
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from "react";
import { useSession } from "next-auth/react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { AgentConfig, ModelConfig } from "@/agent-core-types";
import { AVAILABLE_MODELS, PROVIDER_META, type Provider } from "@agent/_lib/config/models";
import { useACPChat } from "./_hooks/use-acp-chat";
import ProviderModelIcon from "./_components/provider-icon";
import AgentInput from "./_components/agent-input";
import SettingsPanel from "./_components/settings-panel";
import UserMenu from "./_components/user-menu";
import { ThemeToggle } from "./_components/theme";
import HistoryPanel, { type ConversationRow } from "./_components/history-panel";
import MicButton, { type MicState } from "./_components/mic-button";
import type { UploadedFile } from "@/agent-core-types";

import StreamdownBlock from "@/components/shared/streamdown-block";
import ArtifactPanel, { JsonViewer } from "./_components/artifact-panel";
import { isProductData, ProductCards, type ProductPick } from "./_components/product-cards";
import { extractMessageFormatted, isToolPart, synthesizeFallbackProducts } from "./_lib/extract-formatted-output";
import SymbolColored from "@/components/shared/icons/symbol-colored";
import { cn } from "@/utils/cn";

function HistoryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Chat history"
      title="Your chats"
      className="flex items-center gap-7 pl-11 pr-13 py-8 rounded-10 text-label-small text-black-alpha-56 bg-black-alpha-4 hover:bg-black-alpha-8 hover:text-accent-black transition-all"
    >
      <svg fill="none" height="18" viewBox="0 0 24 24" width="18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-8 5M3 4v4h4" />
        <path d="M12 8v4l3 2" />
      </svg>
      <span className="hidden sm:inline">History</span>
    </button>
  );
}

function NewChatButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="New chat"
      title="New chat"
      className="flex items-center gap-7 pl-11 pr-13 py-8 rounded-10 text-label-small text-black-alpha-56 bg-black-alpha-4 hover:bg-black-alpha-8 hover:text-accent-black transition-all"
    >
      <svg fill="none" height="18" viewBox="0 0 24 24" width="18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <span className="hidden sm:inline">New chat</span>
    </button>
  );
}

function HeaderLinks() {
  return (
    <div className="flex items-center gap-8">
      <ThemeToggle />
      <UserMenu />
    </div>
  );
}

import { getOrchestratorModel, getExperimentalFeatures } from "@agent/_config";

const defaultModel: ModelConfig = getOrchestratorModel();
const experimentalFeatures = getExperimentalFeatures();
const MODEL_PREFERENCE_STORAGE_KEY = "shopsmart:last-model";

type CachedModelPreference = Pick<ModelConfig, "provider" | "model" | "baseURL" | "bin">;

const PROVIDER_KEY_IDS: Partial<Record<ModelConfig["provider"], string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  gateway: "gateway",
  "custom-openai": "customOpenAI",
};

function sanitizeModelPreference(model: ModelConfig): CachedModelPreference {
  return {
    provider: model.provider,
    model: model.model,
    ...(model.baseURL ? { baseURL: model.baseURL } : {}),
    ...(model.bin ? { bin: model.bin } : {}),
  };
}

function restoreModelPreference(raw: string | null): ModelConfig | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<CachedModelPreference>;
    if (typeof parsed.provider !== "string" || typeof parsed.model !== "string") {
      return null;
    }

    const provider = parsed.provider as ModelConfig["provider"];
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_META, provider)) {
      return null;
    }

    const knownModels = AVAILABLE_MODELS[provider as Provider] ?? [];
    const normalizedModel =
      provider === "custom-openai" || (provider as string) === "acp"
        ? parsed.model.trim()
        : (knownModels.some((entry) => entry.id === parsed.model)
            ? parsed.model
            : (knownModels[0]?.id ?? parsed.model)).trim();

    if (!normalizedModel) return null;

    return {
      provider,
      model: normalizedModel,
      ...(typeof parsed.baseURL === "string" && parsed.baseURL.trim()
        ? { baseURL: parsed.baseURL.trim() }
        : {}),
      ...(typeof parsed.bin === "string" && parsed.bin.trim()
        ? { bin: parsed.bin.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

function isPreferredModelUsable(
  model: ModelConfig,
  configuredProviders: Set<string>,
  acpAgents: { bin: string }[],
): boolean {
  if ((model.provider as string) === "acp") {
    return model.bin
      ? acpAgents.some((agent) => agent.bin === model.bin)
      : acpAgents.length > 0;
  }

  const providerKeyId = PROVIDER_KEY_IDS[model.provider];
  return providerKeyId ? configuredProviders.has(providerKeyId) : false;
}

function resolveInitialModel(
  preferredModel: ModelConfig | null,
  configuredProviders: Set<string>,
  acpAgents: { bin: string }[],
): ModelConfig {
  if (preferredModel && isPreferredModelUsable(preferredModel, configuredProviders, acpAgents)) {
    return preferredModel;
  }

  return defaultModel;
}

const defaultConfig: AgentConfig = {
  prompt: "",
  urls: [],
  schema: undefined,
  model: defaultModel,
  skills: ["e-commerce"],
  subAgents: [],
  // Tight enough to stay fast, with headroom for checkout flows (several
  // interact steps). The speed_policy keeps most search/compare runs well under.
  maxSteps: 36,
};

const PLACEHOLDER_PHRASES = [
  "Find me the best student deals in India...",
  "Coupon codes for Flipkart and Myntra...",
  "Compare textbook prices on Amazon.in and Flipkart...",
  "Cheapest laptop under ₹50,000 for college...",
  "Add a 65W charger to my cart and check out...",
];

// Build a plain-text transcript of an assistant turn to feed the deterministic
// /api/format-products extractor. The assistant's SUMMARY text goes first and is
// flagged as authoritative — the extractor must reproduce exactly the products
// the assistant recommended (not raw scrape leftovers). Tool outputs follow as
// supporting data to fill in price / link / image / reviews per product.
function buildTurnTranscript(msgs: { parts: Array<{ type: string }> }[]): string {
  const texts: string[] = [];
  const toolData: string[] = [];
  for (const m of msgs) {
    for (const part of m.parts as Array<Record<string, unknown> & { type: string }>) {
      if (part.type === "text" && typeof part.text === "string") {
        if (part.text.trim()) texts.push(part.text.trim());
      } else if (isToolPart(part)) {
        const output = part.output ?? part.result;
        if (output != null) {
          let s = "";
          try { s = typeof output === "string" ? output : JSON.stringify(output); } catch { s = ""; }
          if (s) toolData.push(s.slice(0, 4000));
        }
      } else if (part.type === "data-tool-output" && part.data) {
        const output = (part.data as { output?: unknown }).output;
        if (output != null) {
          let s = "";
          try { s = typeof output === "string" ? output : JSON.stringify(output); } catch { s = ""; }
          if (s) toolData.push(s.slice(0, 4000));
        }
      }
    }
  }
  const summary = texts.join("\n").slice(0, 8000);
  const tools = toolData.join("\n").slice(0, 11000);
  let out = "";
  if (summary.trim()) {
    out += `=== ASSISTANT SUMMARY — extract EXACTLY these recommended products, no others ===\n${summary}\n\n`;
  }
  if (tools.trim()) {
    out += `=== SUPPORTING SCRAPE/SEARCH DATA — use to fill each product's price, sourceUrl, imageUrl, rating, sentiment, reviewSummary ===\n${tools}`;
  }
  return out.slice(0, 20000);
}

// Persist which conversation is open so a page refresh restores it.
const ACTIVE_CONV_KEY = "shopsmart:active-conversation";

function firstUrlIn(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s)]+/);
  return m ? m[0].replace(/[.,)]+$/, "") : undefined;
}

function isFormatOutputPart(p: { type: string; toolName?: string }): boolean {
  if (p.type === "tool-formatOutput") return true;
  if (p.type === "dynamic-tool" && p.toolName === "formatOutput") return true;
  return false;
}

function useTypewriter(phrases: string[], typingSpeed = 50, pauseMs = 2000, deleteSpeed = 30) {
  const [display, setDisplay] = useState("");
  const idx = useRef(0);
  const charIdx = useRef(0);
  const deleting = useRef(false);
  const paused = useRef(false);

  useEffect(() => {
    const tick = () => {
      const phrase = phrases[idx.current];
      if (paused.current) return;

      if (!deleting.current) {
        charIdx.current++;
        setDisplay(phrase.slice(0, charIdx.current));
        if (charIdx.current === phrase.length) {
          paused.current = true;
          setTimeout(() => {
            paused.current = false;
            deleting.current = true;
          }, pauseMs);
        }
      } else {
        charIdx.current--;
        setDisplay(phrase.slice(0, charIdx.current));
        if (charIdx.current === 0) {
          deleting.current = false;
          idx.current = (idx.current + 1) % phrases.length;
        }
      }
    };

    const interval = setInterval(tick, deleting.current ? deleteSpeed : typingSpeed);
    return () => clearInterval(interval);
  }, [phrases, typingSpeed, pauseMs, deleteSpeed]);

  return display;
}

/** Morphing typewriter: types toward `target`, deleting the mismatched tail
 *  first so the label transitions smoothly when the action changes. */
function useTypewriterValue(target: string, speed = 34) {
  const [display, setDisplay] = useState("");
  useEffect(() => {
    const id = setInterval(() => {
      setDisplay((cur) => {
        if (cur === target) return cur;
        let i = 0;
        while (i < cur.length && i < target.length && cur[i] === target[i]) i++;
        // Delete down to the common prefix, then type the new tail.
        return cur.length > i ? cur.slice(0, -1) : target.slice(0, cur.length + 1);
      });
    }, speed);
    return () => clearInterval(id);
  }, [target, speed]);
  return display;
}

/** Animated activity glyph — a Claude-style sunburst spinner: twelve tapered
 *  rays with an opacity cascade, spinning smoothly like a comet trail, with a
 *  gentle breathe and a green glow. */
function ActivityOrb() {
  const rays = Array.from({ length: 12 });
  return (
    <span className="loader-glow relative inline-flex h-18 w-18 flex-shrink-0 items-center justify-center">
      <svg viewBox="0 0 28 28" width="18" height="18" className="loader-breathe overflow-visible">
        <g className="loader-spin">
          {rays.map((_, i) => (
            <line
              key={i}
              x1="14"
              y1="4.2"
              x2="14"
              y2="8.8"
              stroke="var(--heat-100)"
              strokeWidth="2.4"
              strokeLinecap="round"
              transform={`rotate(${i * 30} 14 14)`}
              opacity={0.16 + (i / (rays.length - 1)) * 0.84}
            />
          ))}
        </g>
      </svg>
    </span>
  );
}

type ActivityMessage = { role: string; parts: Array<Record<string, unknown> & { type: string }> };

const ACTIVITY_PHRASES: Record<string, string[]> = {
  search: ["Finding the best options", "Searching across stores", "Looking up prices", "Hunting for deals", "Checking availability", "Scanning for offers"],
  scrape: ["Checking prices", "Reading product details", "Fetching the latest deals", "Gathering product info", "Looking at store listings", "Pulling up product details"],
  interact: ["Browsing the store", "Navigating to checkout", "Adding to cart", "Filling in your details", "Proceeding to checkout", "Opening the page"],
  map: ["Exploring the store", "Mapping out options"],
  crawl: ["Browsing through results", "Going through listings"],
  formatOutput: ["Putting it all together", "Getting your results ready", "Preparing your picks"],
  spawnAgents: ["Comparing across stores", "Checking multiple stores at once", "Running price comparisons"],
  bashExec: ["Crunching the numbers", "Processing results", "Analysing the data"],
};

/** The live "what the agent is doing right now" line — animated orb + a
 *  typewriter label that morphs as the current tool changes. */
function ActivityIndicator({ messages }: { messages: ActivityMessage[] }) {
  type Activity = { label: string; detail: string | null };
  const hostOf = (u: string) => {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; }
  };
  const pickPhrase = (tool: string, idx: number): string => {
    const pool = ACTIVITY_PHRASES[tool];
    return pool ? pool[idx % pool.length] : "Finding your best options";
  };

  const activities: Activity[] = [];
  const seen = new Set<string>();

  let latestAssistant: ActivityMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") { latestAssistant = messages[i]; break; }
  }

  if (latestAssistant) {
    for (const part of latestAssistant.parts) {
      if (!isToolPart(part)) continue;
      const p = part as Record<string, unknown>;
      const toolName = (p.toolName ?? (p.type as string).replace("tool-", "")) as string;
      const input = (p.input ?? p.args ?? {}) as Record<string, unknown>;
      const callId = String(p.toolCallId ?? p.id ?? `${toolName}-${activities.length}`);

      let detail: string | null = null;
      if (toolName === "scrape" || toolName === "map" || toolName === "crawl") {
        const url = typeof input.url === "string" ? input.url
          : Array.isArray(input.urls) && typeof input.urls[0] === "string" ? input.urls[0] as string
          : null;
        detail = url ? hostOf(url) : null;
      } else if (toolName === "interact") {
        detail = typeof input.url === "string" ? hostOf(input.url) : null;
      } else if (toolName === "spawnAgents") {
        const count = Array.isArray(input.tasks) ? input.tasks.length : null;
        detail = count ? `${count} stores` : null;
      }

      const key = `${callId}:${toolName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      activities.push({ label: pickPhrase(toolName, activities.length), detail });
    }
  }

  const active = activities[activities.length - 1];
  const typed = useTypewriterValue(active?.label ?? "Working");

  return (
    <div className="flex items-center gap-x-12 gap-y-2 mb-28 flex-wrap">
      <ActivityOrb />
      <span className="text-label-large text-accent-black/75 font-medium tracking-tight">{typed}</span>
      {active?.detail && (
        <span className="text-black-alpha-40 truncate max-w-full font-mono text-mono-small">{active.detail}</span>
      )}
    </div>
  );
}

interface SkillInfo {
  name: string;
  description: string;
  category?: string;
}

function SkillsIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function PlusMenu({
  skills,
  selectedSkills,
  onSkillsChange,
  onUploadClick,
  uploads,
  onRemoveUpload,
  onClose,
  schema,
  onSchemaChange,
}: {
  skills: SkillInfo[] | null;
  selectedSkills: string[];
  onSkillsChange: (skills: string[]) => void;
  onUploadClick: () => void;
  uploads: UploadedFile[];
  onRemoveUpload: (i: number) => void;
  onClose: () => void;
  schema: Record<string, unknown> | undefined;
  onSchemaChange: (schema: Record<string, unknown> | undefined) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [activePanel, setActivePanel] = useState<"upload" | "schema" | "skills" | null>(null);
  const [schemaMode, setSchemaMode] = useState<"describe" | "paste">("describe");
  const [schemaDesc, setSchemaDesc] = useState("");
  const [schemaPaste, setSchemaPaste] = useState("");
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [maxH, setMaxH] = useState(400);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    // Walk up to find the input card container (max-w-640 rounded-16)
    let card = ref.current.parentElement;
    while (card && !card.classList.contains("max-w-640")) {
      card = card.parentElement;
    }
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    setPos({
      left: cardRect.left,
      bottom: window.innerHeight - cardRect.top + 6,
      width: cardRect.width,
    });
    const available = cardRect.top - 12;
    setMaxH(Math.max(200, Math.min(420, available)));
  }, [activePanel]);

  const visibleSkills = (skills ?? []).filter((s) => s.category !== "Export");

  const menuItems: { id: "schema" | "skills"; label: string; icon: React.ReactNode; badge?: string }[] = [
    {
      id: "schema", label: "Schema", badge: schema ? "set" : undefined,
      icon: <svg fill="none" height="16" viewBox="0 0 24 24" width="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H7a2 2 0 00-2 2v5a2 2 0 01-2 2 2 2 0 012 2v5a2 2 0 002 2h1M16 3h1a2 2 0 012 2v5a2 2 0 002 2 2 2 0 00-2 2v5a2 2 0 01-2 2h-1" /></svg>,
    },
    {
      id: "skills", label: "Skills", badge: selectedSkills.length > 0 ? String(selectedSkills.length) : undefined,
      icon: <svg fill="none" height="16" viewBox="0 0 24 24" width="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>,
    },
  ];

  return (
    <>
    <div className="fixed inset-0 bg-black/10 z-40" onClick={onClose} />
    <div
      ref={ref}
      className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-accent-white rounded-16 border border-border-muted overflow-hidden flex w-[960px] max-w-[92vw]"
      style={{
        boxShadow: "0px 24px 48px -12px rgba(0,0,0,0.12), 0px 8px 16px -4px rgba(0,0,0,0.06)",
        maxHeight: "min(800px, 90vh)",
      }}
    >
      {/* Left nav */}
      <div className="w-120 sm:w-160 flex-shrink-0 py-8 px-6 flex flex-col gap-1 border-r border-border-faint bg-black-alpha-2">
        {menuItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={cn(
              "w-full flex items-center gap-8 px-10 py-8 rounded-8 text-left transition-all",
              activePanel === item.id ? "bg-black-alpha-4" : "hover:bg-black-alpha-2",
            )}
            onClick={() => setActivePanel(activePanel === item.id ? null : item.id)}
          >
            <span className={cn("flex-shrink-0", activePanel === item.id || item.badge ? "text-accent-black" : "text-black-alpha-40")}>{item.icon}</span>
            <span className={cn("text-label-small flex-1", activePanel === item.id ? "text-accent-black" : item.badge ? "text-accent-black" : "text-accent-black")}>{item.label}</span>
            {item.badge && (
              <span className="text-mono-x-small text-black-alpha-48 bg-black-alpha-4 px-4 py-1 rounded-4">{item.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* Right panel */}
      {activePanel && (
        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          {/* Upload */}
          {activePanel === "upload" && (
            <div className="p-14 flex flex-col gap-8">
              <div className="text-label-medium text-accent-black">Upload files</div>
              <div className="text-body-small text-black-alpha-48">Attach CSV, JSON, or text files. They will be available to the agent via bash.</div>
              <button
                type="button"
                className="w-full py-8 rounded-8 text-label-small bg-black-alpha-4 text-accent-black hover:bg-black-alpha-8 transition-all"
                onClick={() => { onUploadClick(); }}
              >
                Choose file
              </button>
              {uploads.length > 0 && (
                <div className="flex flex-col gap-4 pt-4">
                  {uploads.map((f, i) => (
                    <div key={i} className="flex items-center gap-6 px-8 py-6 rounded-8 bg-black-alpha-2">
                      <svg fill="none" height="14" viewBox="0 0 24 24" width="14" className="text-black-alpha-32 flex-shrink-0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" /><path d="M14 2v6h6" />
                      </svg>
                      <span className="text-body-small text-accent-black flex-1 truncate">{f.name}</span>
                      <button
                        type="button"
                        className="text-black-alpha-24 hover:text-accent-crimson transition-colors flex-shrink-0"
                        onClick={() => onRemoveUpload(i)}
                      >
                        <svg fill="none" height="10" viewBox="0 0 24 24" width="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Schema */}
          {activePanel === "schema" && (
            <div className="p-14 flex flex-col gap-8">
              <div className="flex items-center justify-between">
                <div className="text-label-medium text-accent-black">Schema</div>
                {schema && (
                  <button
                    type="button"
                    className="text-mono-x-small text-black-alpha-32 hover:text-accent-crimson transition-colors"
                    onClick={() => { onSchemaChange(undefined); setSchemaDesc(""); setSchemaPaste(""); }}
                  >Clear</button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={cn("px-10 py-4 rounded-6 text-label-small transition-all", schemaMode === "describe" ? "bg-black-alpha-8 text-accent-black" : "text-black-alpha-32 hover:text-black-alpha-48")}
                  onClick={() => setSchemaMode("describe")}
                >Describe</button>
                <button
                  type="button"
                  className={cn("px-10 py-4 rounded-6 text-label-small transition-all", schemaMode === "paste" ? "bg-black-alpha-8 text-accent-black" : "text-black-alpha-32 hover:text-black-alpha-48")}
                  onClick={() => setSchemaMode("paste")}
                >Paste JSON</button>
              </div>
              {schemaMode === "describe" ? (
                <>
                  <textarea
                    className="w-full bg-black-alpha-4 rounded-8 px-10 py-8 text-body-small text-accent-black placeholder:text-black-alpha-32 focus:outline-none resize-none"
                    rows={3}
                    placeholder="e.g. company name, funding amount, list of investors, website"
                    value={schemaDesc}
                    onChange={(e) => setSchemaDesc(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (!schemaDesc.trim() || schemaLoading) return;
                        setSchemaLoading(true);
                        try {
                          const resp = await fetch("/api/schema/generate", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ description: schemaDesc }),
                          });
                          const data = await resp.json();
                          if (data.schema) onSchemaChange(data.schema);
                        } catch { /* ignore */ }
                        setSchemaLoading(false);
                      }
                    }}
                  />
                  <div className="text-mono-x-small text-black-alpha-32">
                    {schemaLoading ? "Generating..." : "Enter to generate"}
                  </div>
                </>
              ) : (
                <>
                  <textarea
                    className="w-full bg-black-alpha-4 rounded-8 px-10 py-8 text-mono-x-small text-accent-black placeholder:text-black-alpha-32 focus:outline-none resize-none"
                    rows={5}
                    placeholder='{"type":"object","properties":{"name":{"type":"string"}}}'
                    value={schemaPaste}
                    onChange={(e) => setSchemaPaste(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        try {
                          const parsed = JSON.parse(schemaPaste);
                          onSchemaChange(parsed);
                        } catch { /* ignore */ }
                      }
                    }}
                  />
                  <div className="text-mono-x-small text-black-alpha-32">Enter to apply</div>
                </>
              )}
              {schema && (
                <div className="bg-black-alpha-2 px-10 py-6 max-h-[180px] overflow-auto" style={{ scrollbarWidth: "thin" }}>
                  <JsonViewer data={JSON.stringify(schema)} />
                </div>
              )}
            </div>
          )}

          {/* Skills */}
          {activePanel === "skills" && (
            <div className="py-6 px-6 flex flex-col gap-1">
              {visibleSkills.map((skill) => {
                const active = selectedSkills.includes(skill.name);
                return (
                  <button
                    key={skill.name}
                    type="button"
                    className={cn(
                      "w-full text-left px-10 py-6 rounded-8 transition-all",
                      active ? "bg-heat-8" : "hover:bg-black-alpha-2",
                    )}
                    onClick={() =>
                      onSkillsChange(active ? selectedSkills.filter((s) => s !== skill.name) : [...selectedSkills, skill.name])
                    }
                  >
                    <div className="flex items-center gap-8">
                      <div className={cn(
                        "w-14 h-14 rounded-4 border-2 flex-shrink-0 flex items-center justify-center transition-all",
                        active ? "bg-heat-100 border-heat-100" : "border-black-alpha-16",
                      )}>
                        {active && (
                          <svg viewBox="0 0 16 16" className="text-white w-10 h-10">
                            <path d="M6.5 11.5L3 8l1-1 2.5 2.5L11 5l1 1-5.5 5.5z" fill="currentColor" />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-label-small text-accent-black">{skill.name}</div>
                        <div className="text-body-small text-black-alpha-48 truncate">{skill.description}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
    </>
  );
}

/** Next.js 16 passes `params` / `searchParams` as Promises; unwrap so DevTools / runtime don't enumerate Promises (sync-dynamic-apis). */
type AgentPageProps = {
  params: Promise<Record<string, string | string[]>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function AgentPage(props: AgentPageProps) {
  use(props.params);
  use(props.searchParams);

  const { status: sessionStatus } = useSession();
  const [config, setConfig] = useState<AgentConfig>(defaultConfig);
  const modelPreferenceLoaded = true; // Model always comes from _config.ts, no localStorage
  const typingPlaceholder = useTypewriter(PLACEHOLDER_PHRASES);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [followUpMentionQuery, setFollowUpMentionQuery] = useState<string | null>(null);
  const [followUpMentionStart, setFollowUpMentionStart] = useState(0);
  const [showPlus, setShowPlus] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);

  const [docGeneratorKind, setDocGeneratorKind] = useState<"skill" | "workflow" | null>(null);
  const [docName, setDocName] = useState("");
  const [generatingDoc, setGeneratingDoc] = useState(false);
  const [generatedDocPath, setGeneratedDocPath] = useState<string | null>(null);
  const [generatedDocContent, setGeneratedDocContent] = useState<string | null>(null);
  const [generatedDocLabel, setGeneratedDocLabel] = useState<string | null>(null);
  const [artifactOpen, setArtifactOpen] = useState(false);
  // Deterministic card-recovery: extracted product JSON keyed by assistant
  // message id, plus an in-flight flag for the "Formatting results…" state.
  const [recovered, setRecovered] = useState<Record<string, string>>({});
  const [recovering, setRecovering] = useState<Record<string, boolean>>({});

  // Chat history (Supabase).
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [historyConfigured, setHistoryConfigured] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [voiceState, setVoiceState] = useState<MicState>("idle");
  const [artifactSkillMode, setArtifactSkillMode] = useState(false);
  const [acpAgents, setAcpAgents] = useState<{ name: string; bin: string; displayName: string; available: boolean }[]>([]);
  const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(new Set());
  const [providerConfigLoaded, setProviderConfigLoaded] = useState(false);
  const [acpAvailabilityLoaded, setAcpAvailabilityLoaded] = useState(false);

  // Model defaults from _config.ts, no localStorage persistence to avoid hydration mismatches
  const [sparkMode, setSparkMode] = useState(false);
  const [sparkResult, setSparkResult] = useState<{ data: unknown; status: string; creditsUsed?: number } | null>(null);
  const [sparkLoading, setSparkLoading] = useState(false);
  const [sparkError, setSparkError] = useState<string | null>(null);


  const refreshConversations = useCallback(() => {
    fetch("/api/conversations")
      .then((r) => (r.ok ? r.json() : { conversations: [], configured: false }))
      .then((d: { conversations?: ConversationRow[]; configured?: boolean }) => {
        setConversations(d.conversations ?? []);
        setHistoryConfigured(!!d.configured);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (sessionStatus === "authenticated") refreshConversations();
  }, [sessionStatus, refreshConversations]);

  useEffect(() => {
    fetch("/api/skills")
      .then((r) => r.json())
      .then((data) => setSkills(data))
      .catch(() => setSkills([]));
    fetch("/api/acp/agents")
      .then((r) => r.json())
      .then((agents) => setAcpAgents(agents.filter((a: { available: boolean }) => a.available)))
      .catch(() => setAcpAgents([]))
      .finally(() => setAcpAvailabilityLoaded(true));
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: { keys: Record<string, { configured: boolean }> }) => {
        const configured = new Set<string>();
        for (const [id, status] of Object.entries(data.keys)) {
          if (status.configured) configured.add(id);
        }
        setConfiguredProviders(configured);
      })
      .catch(() => {})
      .finally(() => setProviderConfigLoaded(true));
  }, []);

  const handleFileUpload = (file: File) => {
    const reader = new FileReader();
    const isText = file.type.startsWith("text/") ||
      /\.(csv|tsv|json|md|txt|xml|yaml|yml|toml|ini|log|sql|html|css|js|ts|py|rb|sh)$/i.test(file.name);
    const onLoad = (content: string) => {
      const uploaded: UploadedFile = { name: file.name, type: file.type || "text/plain", content };
      setConfig((prev) => ({ ...prev, uploads: [...(prev.uploads ?? []), uploaded] }));
    };
    if (isText) {
      reader.onload = () => onLoad(reader.result as string);
      reader.readAsText(file);
    } else {
      reader.onload = () => onLoad((reader.result as string).split(",")[1]);
      reader.readAsDataURL(file);
    }
  };

  const isACP = (config.model.provider as string) === "acp";

  const configRef = useRef(config);
  configRef.current = config;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent",
        body: () => ({ config: configRef.current }),
      }),
    [],
  );

  const sdkChat = useChat({ transport });
  const acpChat = useACPChat();

  const messages = isACP ? acpChat.messages : sdkChat.messages;
  const status = isACP ? acpChat.status : sdkChat.status;
  const stop = isACP ? acpChat.stop : sdkChat.stop;
  const chatError = isACP ? null : sdkChat.error;
  const clearMessages = () => { sdkChat.setMessages([]); sdkChat.clearError?.(); };

  const sendMessage = useCallback((opts: { text: string }) => {
    if (isACP) {
      acpChat.sendMessage({
        text: opts.text,
        bin: config.model.bin ?? config.model.model,
      });
    } else {
      sdkChat.clearError?.();
      sdkChat.sendMessage(opts).catch((err) => {
        console.error("sendMessage failed:", err);
      });
    }
  }, [isACP, config.model, acpChat, sdkChat]);

  const isRunning = status === "streaming" || status === "submitted";

  // Refs so the save effect always reads the current conversation id / config.
  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;
  const historyConfiguredRef = useRef(false);
  historyConfiguredRef.current = historyConfigured;
  const recoveredRef = useRef<Record<string, string>>({});
  recoveredRef.current = recovered;

  // Persist the full transcript to Supabase (creates the conversation lazily).
  const saveTranscript = useCallback(
    async (msgs: typeof messages) => {
      if (isACP || !historyConfiguredRef.current || msgs.length === 0) return;
      const firstUser = msgs.find((m) => m.role === "user");
      const title = firstUser
        ? firstUser.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join(" ")
            .trim()
            .slice(0, 80) || "New chat"
        : "New chat";
      // Store only what we need to re-render on restore: text + the formatOutput
      // card data, plus any deterministic-recovery cards baked in as a
      // `data-cards` part. Dropping bulky raw tool outputs keeps the row small
      // and restore fast.
      const stored = msgs.map((m) => {
        const parts = (m.parts as Array<Record<string, unknown> & { type: string; toolName?: string }>)
          .filter((p) => p.type === "text" || isFormatOutputPart(p))
          .map((p) => p as unknown);
        const rec = recoveredRef.current[m.id];
        if (rec) parts.push({ type: "data-cards", data: { content: rec } });
        return { role: m.role, parts };
      });
      try {
        let cid = conversationIdRef.current;
        if (!cid) {
          const res = await fetch("/api/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          });
          const d = await res.json();
          if (!d.id) return;
          cid = d.id;
          conversationIdRef.current = cid;
          setConversationId(cid);
          try { localStorage.setItem(ACTIVE_CONV_KEY, cid!); } catch { /* ignore */ }
        }
        await fetch(`/api/conversations/${cid}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: stored, title }),
        });
        refreshConversations();
      } catch {
        /* best-effort */
      }
    },
    [isACP, refreshConversations],
  );

  const loadConversation = async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) {
        try { localStorage.removeItem(ACTIVE_CONV_KEY); } catch { /* ignore */ }
        setHasSubmitted(false); // restore failed → fall back to the landing
        return;
      }
      const d = (await res.json()) as { messages?: { id?: string; role: string; parts: unknown }[] };
      const msgs = (d.messages ?? []).map((m) => ({
        id: m.id ?? crypto.randomUUID(),
        role: m.role as "user" | "assistant" | "system",
        parts: (m.parts ?? []) as never,
      }));
      sdkChat.setMessages(msgs as never);
      setConversationId(id);
      try { localStorage.setItem(ACTIVE_CONV_KEY, id); } catch { /* ignore */ }
      setHasSubmitted(true);
      setSparkMode(false);
      // Re-hydrate recovery cards baked into the transcript as data-cards parts.
      const recMap: Record<string, string> = {};
      for (const m of msgs) {
        for (const p of m.parts as Array<{ type?: string; data?: { content?: string } }>) {
          if (p?.type === "data-cards" && p.data?.content) recMap[m.id] = p.data.content;
        }
      }
      setRecovered(recMap);
      setRecovering({});

      // Old chats (saved before cards were baked in) have neither a stored
      // formatOutput nor data-cards — regenerate cards from the transcript so
      // they appear on restore too. New chats already carry data-cards and skip.
      const convUrl = (() => {
        for (const m of msgs) {
          if (m.role !== "user") continue;
          const t = (m.parts as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ");
          const u = firstUrlIn(t);
          if (u) return u;
        }
        return undefined;
      })();
      for (const m of msgs) {
        if (m.role !== "assistant" || recMap[m.id]) continue;
        const parts = m.parts as Array<Record<string, unknown> & { type: string; output?: { format?: string; content?: string } }>;
        const hasFmt = parts.some((p) => isFormatOutputPart(p) && p.output?.format && p.output?.content);
        if (hasFmt) continue;
        const transcript = buildTurnTranscript([m]);
        if (transcript.trim().length < 40 && !convUrl) continue;
        setRecovering((s) => ({ ...s, [m.id]: true }));
        fetch("/api/format-products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: transcript, url: convUrl }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (Array.isArray(d.items) && d.items.length > 0) {
              setRecovered((s) => ({ ...s, [m.id]: JSON.stringify(d.items) }));
            }
          })
          .catch(() => {})
          .finally(() => setRecovering((s) => { const n = { ...s }; delete n[m.id]; return n; }));
      }
      recoveredForUser.current = null;
    } catch {
      /* ignore */
    }
  };

  const newChat = () => {
    clearMessages();
    setConversationId(null);
    conversationIdRef.current = null;
    try { localStorage.removeItem(ACTIVE_CONV_KEY); } catch { /* ignore */ }
    setHasSubmitted(false);
    setConfig(defaultConfig);
    setSuggestions([]);
    setRecovered({});
    setRecovering({});
    recoveredForUser.current = null;
    setSparkMode(false);
  };

  // Clicking a product card sends a "buy this one" follow-up to the agent.
  const buyProduct = (pick: ProductPick) => {
    let line = `Buy me the ${pick.name}`;
    if (pick.priceLabel) line += ` (${pick.priceLabel})`;
    if (pick.source) line += ` from ${pick.source}`;
    const text = `${line}. Add it to my cart and take me to checkout.`;
    setSuggestions([]);
    setFollowUp("");
    if (!isRunning) sendMessage({ text });
  };

  const deleteConversation = async (id: string) => {
    try {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
    if (id === conversationId) newChat();
    refreshConversations();
  };

  // Restore the active conversation on page load so a refresh keeps the chat.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let stored: string | null = null;
    try { stored = localStorage.getItem(ACTIVE_CONV_KEY); } catch { /* ignore */ }
    if (stored) {
      setHasSubmitted(true); // show the chat shell immediately — no landing flash
      setRestoring(true);
      loadConversation(stored).finally(() => setRestoring(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to bottom when streaming
  useEffect(() => {
    if (!isRunning || !scrollRef.current) return;
    const el = scrollRef.current;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (isNearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isRunning]);

  // Compute session stats from messages
  const sessionStats = useMemo(() => {
    const fc = { total: 0, search: { count: 0, credits: 0 }, scrape: { count: 0, credits: 0 }, map: { count: 0, credits: 0 }, crawl: { count: 0, credits: 0 }, interact: { count: 0, credits: 0 } };
    let toolCalls = 0;
    let agentTurns = 0;
    let llmCalls = 0;
    let totalChars = 0;
    let workerInputTokens = 0;
    let workerOutputTokens = 0;

    for (const msg of messages) {
      if (msg.role === "assistant") {
        agentTurns++;
        llmCalls++;
      }
      for (const part of msg.parts) {
        if (part.type === "text") {
          totalChars += part.text.length;
        }
        const p = part as Record<string, unknown>;
        if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
          toolCalls++;
          const toolName = (p.toolName ?? (part.type as string).replace("tool-", "")) as string;
          const input = p.input ?? p.args;
          if (input) totalChars += JSON.stringify(input).length;
          const output = (p.output ?? p.result) as Record<string, unknown> | undefined;
          if (output && typeof output === "object") {
            const credits = typeof output.creditsUsed === "number" ? output.creditsUsed as number : 0;
            if (credits > 0) {
              fc.total += credits;
              const bucket = fc[toolName as keyof typeof fc];
              if (bucket && typeof bucket === "object") {
                (bucket as { count: number; credits: number }).count++;
                (bucket as { count: number; credits: number }).credits += credits;
              }
            }
            const contentKeys = ["markdown", "content", "answer", "text", "json", "extract", "data", "output", "web"];
            let contentSize = 0;
            for (const k of contentKeys) {
              if (output[k] !== undefined) contentSize += JSON.stringify(output[k]).length;
            }
            totalChars += contentSize || Math.min(JSON.stringify(output).length, 500);
            if (toolName === "spawnAgents" && Array.isArray(output.results)) {
              for (const wr of output.results as { tokens?: number; inputTokens?: number; outputTokens?: number }[]) {
                workerInputTokens += wr.inputTokens ?? 0;
                workerOutputTokens += wr.outputTokens ?? 0;
              }
            }
          }
        }
      }
    }

    const orchestratorTokens = Math.round(totalChars / 4);
    const orchestratorIn = Math.round(orchestratorTokens * 0.8);
    const orchestratorOut = orchestratorTokens - orchestratorIn;

    llmCalls += toolCalls;

    return { fc, toolCalls, agentTurns, llmCalls, orchestratorIn, orchestratorOut, workerInputTokens, workerOutputTokens };
  }, [messages]);

  // Only the LAST assistant message of each turn shows its text — the
  // intermediate "Now let me scrape…" narration is hidden so the feed stays
  // clean (the live activity log covers in-progress steps and vanishes on done).
  const finalAssistantIds = useMemo(() => {
    const set = new Set<string>();
    let lastAssistant: string | null = null;
    for (const m of messages) {
      if (m.role === "user") {
        if (lastAssistant) set.add(lastAssistant);
        lastAssistant = null;
      } else if (m.role === "assistant") {
        lastAssistant = m.id;
      }
    }
    if (lastAssistant) set.add(lastAssistant);
    return set;
  }, [messages]);

  // Live interact browser sessions (the "watch the agent browse" screens),
  // emitted by the route as data-interact-liveview parts, keyed by scrapeId.
  const liveViews = useMemo(() => {
    const map = new Map<string, { liveViewUrl: string; interactiveLiveViewUrl: string | null; url: string }>();
    for (const m of messages) {
      for (const part of m.parts as Array<{ type?: string; data?: Record<string, unknown> }>) {
        if (part.type === "data-interact-liveview" && part.data) {
          const d = part.data as { scrapeId?: string; liveViewUrl?: string; interactiveLiveViewUrl?: string | null; url?: string };
          if (d.scrapeId && d.liveViewUrl) {
            map.set(d.scrapeId, {
              liveViewUrl: d.liveViewUrl,
              interactiveLiveViewUrl: d.interactiveLiveViewUrl ?? null,
              url: d.url ?? "",
            });
          }
        }
      }
    }
    return Array.from(map.values());
  }, [messages]);

  const prevIsRunning = useRef(false);
  const recoveredForUser = useRef<string | null>(null);

  useEffect(() => {
    if (prevIsRunning.current && !isRunning && messages.length > 0) {
      // Find the start of the current turn (last user message).
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { lastUserIdx = i; break; }
      }
      const lastUserId = lastUserIdx >= 0 ? messages[lastUserIdx].id : null;

      // Deterministic card recovery: the turn did real work but produced NO
      // cards (no formatOutput, fallback couldn't parse). Rather than nudging
      // the model (which may re-scrape or refuse), extract products ourselves
      // via the forced-structured-output endpoint. Fires once per user turn.
      const turnAssistants = messages
        .slice(lastUserIdx + 1)
        .filter((m) => m.role === "assistant");
      const didToolWork = turnAssistants.some((m) => m.parts.some(isToolPart));
      const producedCards = turnAssistants.some((m) => {
        const f = extractMessageFormatted(m) ?? synthesizeFallbackProducts(m);
        return !!f && !f.streaming && f.format === "json" && isProductData(f.content);
      });
      const transcript = buildTurnTranscript(turnAssistants);
      // Always normalize shopping turns through the deterministic extractor so
      // cards match the assistant's summary and carry links + reviews — not just
      // when the agent produced no cards. Gate to product-ish turns to avoid
      // wasting a call on pure-research turns.
      const looksShopping = producedCards || /₹|\bRs\.?\s?\d|\bprice\b|\binr\b/i.test(transcript);
      if (
        turnAssistants.length > 0 && didToolWork && looksShopping &&
        recoveredForUser.current !== lastUserId
      ) {
        recoveredForUser.current = lastUserId;
        const last = turnAssistants[turnAssistants.length - 1];
        const userUrl = lastUserIdx >= 0
          ? firstUrlIn(messages[lastUserIdx].parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" "))
          : undefined;
        if (transcript.length > 40 || userUrl) {
          setRecovering((s) => ({ ...s, [last.id]: true }));
          fetch("/api/format-products", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: transcript, url: userUrl }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (Array.isArray(d.items) && d.items.length > 0) {
                setRecovered((s) => ({ ...s, [last.id]: JSON.stringify(d.items) }));
              }
            })
            .catch(() => {})
            .finally(() => setRecovering((s) => { const n = { ...s }; delete n[last.id]; return n; }));
        }
      }

      // Persist the transcript to chat history (best-effort, fire-and-forget).
      saveTranscript(messages);

      // Agent just finished -- fetch contextual suggestions
      const lastTexts = messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text))
        .slice(-3)
        .join("\n");
      const summary = lastTexts.slice(0, 1000);

      fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: config.prompt, summary }),
      })
        .then((r) => r.json())
        .then((d) => setSuggestions(d.suggestions ?? []))
        .catch(() => setSuggestions([]));

      // Products now show inline — no auto-open of artifact panel
    }
    prevIsRunning.current = isRunning;
  }, [isRunning, messages, config.prompt]);

  const handleGenerateDoc = async (kind: "skill" | "workflow") => {
    if (!docName.trim() || generatingDoc) return;
    setGeneratingDoc(true);

    // Extract a flat list of messages for the API
    const flatMessages = messages.flatMap((msg) =>
      msg.parts.map((part) => {
        if (part.type === "text") {
          return { role: msg.role, text: part.text };
        }
        const p = part as Record<string, unknown>;
        if (p.toolName) {
          return {
            role: msg.role,
            toolName: String(p.toolName),
            input: p.input ?? p.args,
            output: p.output,
          };
        }
        return null;
      }).filter(Boolean),
    );

    try {
      const res = await fetch(kind === "skill" ? "/api/skills/generate" : "/api/workflows/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: docName.trim(),
          messages: flatMessages,
          prompt: config.prompt,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `Server error (${res.status})`;
        try { msg = JSON.parse(text).error ?? msg; } catch { /* use default */ }
        throw new Error(msg);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGeneratedDocPath(data.path);
      setGeneratedDocContent(data.content ?? null);
      setGeneratedDocLabel("SKILL.md");
      setDocGeneratorKind(null);
      setDocName("");
    } catch (err) {
      alert(`Failed to generate SKILL.md: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setGeneratingDoc(false);
    }
  };

  const onRun = () => {
    if (!config.prompt.trim()) return;
    // Firecrawl Spark models: use /agent API directly
    if ((config.model.provider as string) === "firecrawl") {
      setSparkMode(true);
      setSparkLoading(true);
      setSparkError(null);
      setSparkResult(null);
      setHasSubmitted(true);
      fetch("/api/firecrawl-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: config.prompt,
          model: config.model.model,
          schema: config.schema,
          urls: config.urls,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.error) {
            setSparkError(data.error);
          } else {
            setSparkResult({ data: data.data, status: data.status, creditsUsed: data.creditsUsed });
          }
          setSparkLoading(false);
        })
        .catch((err) => {
          setSparkError(err instanceof Error ? err.message : String(err));
          setSparkLoading(false);
        });
      return;
    }

    setHasSubmitted(true);
    sendMessage({ text: config.prompt });
  };

  const mentionSkills = useMemo(() => {
    if (mentionQuery === null || !skills) return [];
    const q = mentionQuery.toLowerCase();
    return skills
      .filter((s) => s.category !== "Export")
      .filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, skills]);

  const followUpMentionSkills = useMemo(() => {
    if (followUpMentionQuery === null || !skills) return [];
    const q = followUpMentionQuery.toLowerCase();
    return skills
      .filter((s) => s.category !== "Export")
      .filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .slice(0, 6);
  }, [followUpMentionQuery, skills]);


  // First screen: editorial landing — display headline, refined input, suggestion list
  if (!hasSubmitted) {
    return (
      <div className="min-h-[100dvh] bg-background-base relative overflow-hidden flex flex-col">
        <HistoryPanel
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          conversations={conversations}
          activeId={conversationId}
          configured={historyConfigured}
          onSelect={loadConversation}
          onNew={newChat}
          onDelete={deleteConversation}
        />
        {/* Ambient heat-glow flourishes */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-[300px] left-1/2 -translate-x-1/2 w-[820px] h-[620px] rounded-full"
          style={{
            background:
              "radial-gradient(closest-side, rgba(15,161,92,0.12), rgba(15,161,92,0))",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-[240px] -left-[160px] w-[560px] h-[560px] rounded-full"
          style={{
            background:
              "radial-gradient(closest-side, rgba(15,161,92,0.07), rgba(15,161,92,0))",
          }}
        />

        {/* Top bar */}
        <header className="relative flex items-center justify-between px-24 sm:px-40 py-20">
          <div className="flex items-center gap-14">
            <div className="flex items-center gap-10">
              <SymbolColored width={22} height={32} />
              <span className="text-label-medium text-accent-black tracking-tight">ShopSmart</span>
            </div>
            <HistoryButton onClick={() => setHistoryOpen(true)} />
            <NewChatButton onClick={newChat} />
          </div>
          <HeaderLinks />
        </header>

        {/* Content well — centered, input-first hero */}
        <main className="relative z-1 flex-1 mx-auto w-full max-w-[720px] px-24 flex flex-col items-center justify-center text-center pb-24">
          {/* Brand lockup */}
          <div className="flex items-center justify-center gap-12 mb-14">
            <SymbolColored width={28} height={40} />
            <span
              className="text-accent-black tracking-tight"
              style={{ fontSize: "clamp(36px, 5.5vw, 56px)", fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1 }}
            >
              ShopSmart
            </span>
            <svg fill="none" viewBox="0 0 24 24" width="26" height="26" className="text-heat-100" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
              <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
              <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
              <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
              <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
              <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
              <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
              <path d="M6 18a4 4 0 0 1-1.967-.516" />
              <path d="M19.967 17.484A4 4 0 0 1 18 18" />
            </svg>
          </div>

          {/* Tagline */}
          <p className="mb-32 text-body-large text-black-alpha-40">
            Your AI shopping agent for India
          </p>

          {/* Input card — the hero element */}
          <div
            className="w-full relative bg-accent-white rounded-16 border border-border-muted overflow-visible text-left transition-all duration-300 focus-within:border-heat-40 focus-within:shadow-[0_16px_44px_-14px_rgba(15,161,92,0.24)]"
            style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}
          >
          {/* Text area */}
          <div className="px-20 pt-16 pb-8 relative">
            <textarea
              ref={textareaRef}
              className="w-full bg-transparent text-body-large text-accent-black placeholder:text-black-alpha-32 focus:outline-none resize-none"
              placeholder={voiceState === "recording" ? "Listening…" : voiceState === "busy" ? "Transcribing…" : (typingPlaceholder || "What do you want to shop for?")}
              rows={2}
              autoFocus
              value={config.prompt}
              onChange={(e) => {
                const val = e.target.value;
                setConfig({ ...config, prompt: val });
                // @ or / skill mention detection
                const pos = e.target.selectionStart ?? val.length;
                const before = val.slice(0, pos);
                const slashMatch = before.match(/(?:@|\/)([\w-]*)$/);
                if (slashMatch) {
                  setMentionQuery(slashMatch[1]);
                  setMentionStart(pos - slashMatch[0].length);
                } else {
                  setMentionQuery(null);
                }
              }}
              onKeyDown={(e) => {
                if (mentionQuery !== null && mentionSkills.length > 0) {
                  if (e.key === "Escape") { e.preventDefault(); setMentionQuery(null); return; }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const skill = mentionSkills[0];
                    const before = config.prompt.slice(0, mentionStart);
                    const after = config.prompt.slice((textareaRef.current?.selectionStart ?? config.prompt.length));
                    setConfig({ ...config, prompt: before + after, skills: config.skills.includes(skill.name) ? config.skills : [...config.skills, skill.name] });
                    setMentionQuery(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && config.prompt.trim() && mentionQuery === null) {
                  e.preventDefault();
                  onRun();
                }
              }}
            />
            {/* @ mention dropdown */}
            {mentionQuery !== null && mentionSkills.length > 0 && (
              <div
                className="absolute left-20 right-20 top-full mt-2 bg-accent-white rounded-10 border border-border-muted overflow-hidden z-10"
                style={{ boxShadow: "0px 8px 24px -4px rgba(0,0,0,0.08), 0px 2px 8px -2px rgba(0,0,0,0.04)" }}
              >
                {mentionSkills.map((skill) => (
                  <button
                    key={skill.name}
                    type="button"
                    className="w-full text-left px-12 py-8 hover:bg-black-alpha-2 transition-all flex items-center gap-8"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const before = config.prompt.slice(0, mentionStart);
                      const after = config.prompt.slice((textareaRef.current?.selectionStart ?? config.prompt.length));
                      setConfig({ ...config, prompt: before + after, skills: config.skills.includes(skill.name) ? config.skills : [...config.skills, skill.name] });
                      setMentionQuery(null);
                    }}
                  >
                    <SkillsIcon />
                    <div className="min-w-0">
                      <div className="text-label-small text-accent-black">{skill.name}</div>
                      <div className="text-body-small text-black-alpha-40 truncate">{skill.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt,.json,.md,.xml,.yaml,.yml,.pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx,.pptx,.html"
            className="hidden"
            multiple
            onChange={(e) => {
              const files = e.target.files;
              if (files) {
                for (let i = 0; i < files.length; i++) handleFileUpload(files[i]);
              }
              e.target.value = "";
            }}
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-12 pb-10 pt-4">
            <div className="flex items-center gap-4 relative">
              {/* + button */}
              <div className="relative">
                <button
                  type="button"
                  className={cn(
                    "flex items-center justify-center w-28 h-28 rounded-8 transition-all",
                    (config.skills.length > 0 || (config.uploads ?? []).length > 0)
                      ? "text-heat-100 hover:bg-heat-8"
                      : "text-black-alpha-32 hover:bg-black-alpha-4 hover:text-black-alpha-48",
                  )}
                  onClick={() => setShowPlus(!showPlus)}
                >
                  <svg fill="none" height="18" viewBox="0 0 24 24" width="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                {showPlus && (
                  <PlusMenu
                    skills={skills}
                    selectedSkills={config.skills}
                    onSkillsChange={(s) => setConfig({ ...config, skills: s })}
                    onUploadClick={() => fileInputRef.current?.click()}
                    uploads={config.uploads ?? []}
                    onRemoveUpload={(i) =>
                      setConfig({ ...config, uploads: (config.uploads ?? []).filter((_, idx) => idx !== i) })
                    }
                    onClose={() => setShowPlus(false)}
                    schema={config.schema}
                    onSchemaChange={(s) => setConfig({ ...config, schema: s })}
                  />
                )}
              </div>

              {/* Inline indicators for selected items */}
              {((config.uploads ?? []).length > 0 || config.skills.length > 0 || config.schema) && (
                <div className="flex items-center gap-4">
                  {(config.uploads ?? []).map((f, i) => (
                    <span key={`f-${i}`} className="flex items-center gap-2 px-6 py-2 rounded-6 bg-black-alpha-4 text-mono-x-small text-black-alpha-48 max-w-[100px]">
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        className="flex-shrink-0 text-black-alpha-24 hover:text-accent-crimson transition-colors"
                        onClick={() => setConfig({ ...config, uploads: (config.uploads ?? []).filter((_, idx) => idx !== i) })}
                      >
                        <svg fill="none" height="8" viewBox="0 0 24 24" width="8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    </span>
                  ))}
                  {config.skills.length > 0 && (
                    <span className="flex items-center gap-4 px-6 py-2 rounded-6 bg-heat-8 text-mono-x-small text-heat-100">
                      <SkillsIcon />
                      {config.skills.length} skill{config.skills.length > 1 ? "s" : ""}
                    </span>
                  )}
                  {config.schema && (
                    <span className="flex items-center gap-2 px-6 py-2 rounded-6 bg-heat-8 text-mono-x-small text-heat-100">
                      {"{}"} Schema
                      <button
                        type="button"
                        className="flex-shrink-0 text-heat-60 hover:text-accent-crimson transition-colors"
                        onClick={() => setConfig({ ...config, schema: undefined })}
                      >
                        <svg fill="none" height="8" viewBox="0 0 24 24" width="8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Mic + Submit */}
            <div className="flex items-center gap-4">
              <MicButton
                size={32}
                onState={setVoiceState}
                onTranscript={(text) => {
                  if (!text.trim()) return;
                  setConfig((c) => ({ ...c, prompt: text }));
                  setHasSubmitted(true);
                  sendMessage({ text });
                }}
              />
              <button
                type="button"
                className={cn(
                  "rounded-8 p-8 transition-all",
                  config.prompt.trim()
                    ? "bg-heat-100 hover:bg-[color:var(--heat-90)] text-accent-white active:scale-95"
                    : "bg-black-alpha-8 text-black-alpha-24 cursor-not-allowed",
                )}
                disabled={config.prompt.trim().length === 0}
                onClick={onRun}
              >
                <svg fill="none" height="18" viewBox="0 0 20 20" width="18">
                  <path
                    d="M10 16.875V3.125M4.79163 8.33333L9.99994 3.125L15.2083 8.33333"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>

          {/* Suggestion chips — a few neat, uniform examples */}
          <div className="mt-24 flex flex-wrap items-center justify-center gap-8">
            {[
              {
                label: "Best phone under ₹20k",
                text: "Find the best smartphone under ₹20,000 in India in 2026",
                icon: <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></>,
              },
              {
                label: "Student laptop deals",
                text: "Find the best budget laptops for students in India in 2026 under ₹40,000",
                icon: <><rect x="3" y="4" width="18" height="12" rx="1" /><path d="M2 20h20" /></>,
              },
              {
                label: "Earbuds under ₹2,000",
                text: "Find the best noise-cancelling earbuds under ₹2,000 in India in 2026",
                icon: <path d="M3 14v-1a9 9 0 0 1 18 0v1M21 17a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2zM3 17a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z" />,
              },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                className="group inline-flex items-center gap-7 pl-11 pr-14 py-8 rounded-full bg-accent-white border border-border-faint text-body-small text-black-alpha-56 hover:text-accent-black hover:border-heat-40 hover:bg-heat-4 transition-all active:scale-[0.98]"
                onClick={() => {
                  const newConfig = { ...config, prompt: item.text, skills: ["e-commerce"] };
                  configRef.current = newConfig;
                  setConfig(newConfig);
                  setHasSubmitted(true);
                  sendMessage({ text: item.text });
                }}
              >
                <svg fill="none" height="14" viewBox="0 0 24 24" width="14" className="text-black-alpha-32 group-hover:text-heat-100 transition-colors flex-shrink-0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  {item.icon}
                </svg>
                {item.label}
              </button>
            ))}
          </div>
        </main>

        {/* Footer */}
        <footer className="relative z-1 px-24 sm:px-40 py-18 flex items-center justify-between text-mono-x-small text-black-alpha-32">
          <span>ShopSmart · {new Date().getFullYear()}</span>
          <span className="tabular-nums">
            Powered by{" "}
            <a
              href="https://app.rankup.diy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-black-alpha-48 hover:text-heat-100 transition-colors"
            >
              RankUp
            </a>
          </span>
        </footer>
      </div>
    );
  }

  // After submission: centered activity feed
  return (
    <div className="h-screen bg-background-base flex flex-col">
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        conversations={conversations}
        activeId={conversationId}
        configured={historyConfigured}
        onSelect={loadConversation}
        onNew={newChat}
        onDelete={deleteConversation}
      />
      <header className="border-b border-border-faint px-20 py-12 flex items-center gap-10 flex-shrink-0">
        <button
          type="button"
          className="flex items-center gap-10 hover:opacity-80 transition-opacity"
          onClick={() => {
            setHasSubmitted(false);
            setConfig(defaultConfig);
            setSuggestions([]);
            setSparkMode(false);
            setSparkResult(null);
            setSparkError(null);
            setSparkLoading(false);
            clearMessages();
            stop();
          }}
        >
          <SymbolColored width={22} height={32} />
          <span className="text-label-large text-accent-black tracking-tight">ShopSmart</span>
        </button>
        <HistoryButton onClick={() => setHistoryOpen(true)} />
        <NewChatButton onClick={newChat} />
        <div className="ml-auto flex items-center gap-6">
          <SettingsPanel config={config} onChange={setConfig} />
          <HeaderLinks />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar">
      <div className={cn("mx-auto px-20 py-24 transition-all duration-200 flex flex-col min-h-full", !artifactOpen ? "max-w-900" : "max-w-700")}>
        {/* Firecrawl Spark results */}
        {sparkMode ? (
          <div className="mt-8">
            {sparkLoading && (
              <div className="my-12 rounded-10 border border-border-faint overflow-hidden">
                <div className="flex items-center gap-8 px-14 py-10">
                  <ProviderModelIcon icon="firecrawl" size={16} />
                  <span className="text-label-small text-accent-black">
                    {config.model.model === "spark-1-pro" ? "Spark 1 Pro" : "Spark 1 Mini"}
                  </span>
                </div>
                <div className="border-t border-border-faint bg-background-lighter p-14">
                  <div className="flex items-center gap-10">
                    <div className="w-16 h-16 border-2 border-black-alpha-16 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    <span className="text-body-small text-black-alpha-48">Searching, navigating, and extracting data...</span>
                  </div>
                  <div className="text-mono-x-small text-black-alpha-24 mt-6 ml-26">This may take a few minutes for complex queries</div>
                </div>
              </div>
            )}
            {sparkError && (
              <div className="my-12 border border-border-faint overflow-hidden">
                <div className="flex items-center gap-8 px-14 py-10">
                  <ProviderModelIcon icon="firecrawl" size={16} />
                  <span className="text-label-small text-accent-black">
                    {config.model.model === "spark-1-pro" ? "Spark 1 Pro" : "Spark 1 Mini"}
                  </span>
                  <span className="text-mono-x-small text-accent-crimson bg-accent-crimson/8 px-4 py-1">failed</span>
                </div>
                <div className="border-t border-border-faint bg-background-lighter p-14">
                  <div className="text-body-small text-accent-black">{sparkError}</div>
                  <button
                    type="button"
                    className="mt-10 px-12 py-6 rounded-8 text-label-small text-black-alpha-48 hover:text-accent-black bg-black-alpha-4 hover:bg-black-alpha-8 transition-all"
                    onClick={() => { setHasSubmitted(false); setSparkMode(false); setSparkError(null); }}
                  >
                    Back
                  </button>
                </div>
              </div>
            )}
            {sparkResult && (
              <div className="my-12 rounded-10 border border-border-faint overflow-hidden">
                <div className="flex items-center gap-8 px-14 py-10">
                  <ProviderModelIcon icon="firecrawl" size={16} />
                  <span className="text-label-small text-accent-black">
                    {config.model.model === "spark-1-pro" ? "Spark 1 Pro" : "Spark 1 Mini"}
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="flex items-center gap-4 text-mono-x-small text-black-alpha-32 hover:text-accent-black transition-colors"
                    onClick={() => {
                      const text = typeof sparkResult.data === "string"
                        ? sparkResult.data
                        : JSON.stringify(sparkResult.data, null, 2);
                      navigator.clipboard.writeText(text);
                    }}
                  >
                    <svg fill="none" height="12" viewBox="0 0 24 24" width="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                    Copy
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-4 text-mono-x-small text-black-alpha-32 hover:text-accent-black transition-colors"
                    onClick={() => {
                      const text = typeof sparkResult.data === "string"
                        ? sparkResult.data
                        : JSON.stringify(sparkResult.data, null, 2);
                      const blob = new Blob([text], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "output.json";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <svg fill="none" height="12" viewBox="0 0 24 24" width="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                    Download
                  </button>
                </div>
                <div className="border-t border-border-faint bg-background-lighter max-h-[70vh] overflow-auto no-scrollbar">
                  <JsonViewer data={typeof sparkResult.data === "string" ? sparkResult.data : JSON.stringify(sparkResult.data, null, 2)} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
        {/* Restoring a saved chat */}
        {restoring && messages.length === 0 && (
          <div className="flex items-center justify-center gap-10 py-60 text-body-small text-black-alpha-48">
            <span className="w-16 h-16 border-2 border-black-alpha-16 border-t-heat-100 rounded-full animate-spin" />
            Restoring your chat…
          </div>
        )}

        {/* Conversation feed — user/assistant turns in order */}
        {messages.map((msg, msgIdx) => {
          if (msg.role === "user") {
            const text = msg.parts
              .filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text)
              .join("\n")
              .trim();
            if (!text) return null;
            return (
              <div
                key={msg.id}
                className={cn("flex justify-end", msgIdx === 0 ? "mb-24" : "mt-32 mb-24")}
              >
                <div
                  className="max-w-[78%] rounded-[18px] rounded-tr-[6px] px-18 py-12 text-body-medium text-accent-black whitespace-pre-wrap break-words text-pretty"
                  style={{
                    background: "linear-gradient(180deg, rgba(15,161,92,0.06), rgba(15,161,92,0.03))",
                    boxShadow: "inset 0 0 0 1px rgba(15,161,92,0.18)",
                  }}
                >
                  {text}
                </div>
              </div>
            );
          }

          // Assistant turn: text + (if this message contained formatOutput) product cards.
          // Only the final assistant message of a turn shows its text; earlier
          // narration messages are hidden (their cards, if any, still render).
          const showText = finalAssistantIds.has(msg.id);
          const textParts = showText
            ? msg.parts.filter(
                (part) => part.type === "text" && (part as { text?: string }).text?.trim(),
              )
            : [];
          // Primary: structured output from formatOutput.
          // Fallback: parse the assistant's prose for product blocks (the LLM
          // sometimes forgets the contract and answers with a numbered list).
          let formatted = extractMessageFormatted(msg);
          if (!formatted) formatted = synthesizeFallbackProducts(msg);
          const showCards =
            formatted &&
            !formatted.streaming &&
            formatted.format === "json" &&
            isProductData(formatted.content);

          if (textParts.length === 0 && !showCards && !recovered[msg.id] && !recovering[msg.id]) return null;

          return (
            <div key={msg.id} className="flex items-start gap-14 mb-28">
              <div className="flex-shrink-0 pt-4">
                <SymbolColored width={22} height={32} />
              </div>
              <div className="flex-1 min-w-0">
                {textParts.map((part, i) => (
                  <div
                    key={i}
                    className="text-body-medium text-accent-black/88 text-pretty max-w-[68ch] leading-[1.75] [&_p]:my-12 [&_p]:leading-[1.75] [&_ul]:my-12 [&_ol]:my-12 [&_li]:my-6 [&_li]:leading-[1.7] [&_h1]:mt-20 [&_h1]:mb-8 [&_h2]:mt-18 [&_h2]:mb-8 [&_h3]:mt-16 [&_h3]:mb-6 [&_strong]:text-accent-black [&_strong]:font-medium [&_a]:text-heat-100 [&_a:hover]:underline tabular-nums"
                  >
                    <StreamdownBlock>{(part as { text: string }).text}</StreamdownBlock>
                  </div>
                ))}
                {/* Card source priority: the deterministic normalizer wins (it
                    matches the summary and carries links + reviews); the agent's
                    own formatOutput shows immediately while normalization is in
                    flight, then gets swapped for the normalized set. */}
                {recovered[msg.id] ? (
                  <div className="mt-20">
                    <ProductCards
                      data={recovered[msg.id]}
                      onViewJson={() => setArtifactOpen(true)}
                      onSelect={buyProduct}
                    />
                  </div>
                ) : showCards ? (
                  <div className="mt-20">
                    <ProductCards
                      data={formatted!.content}
                      onViewJson={() => setArtifactOpen(true)}
                      onSelect={buyProduct}
                    />
                  </div>
                ) : recovering[msg.id] ? (
                  <div className="mt-16 flex items-center gap-10 text-body-small text-black-alpha-48">
                    <span className="w-14 h-14 border-2 border-black-alpha-16 border-t-heat-100 rounded-full animate-spin" />
                    Formatting results…
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}

        {/* Live browser — watch the agent navigate / check out in real time */}
        {isRunning && liveViews.length > 0 && (() => {
          const lv = liveViews[liveViews.length - 1];
          const src = lv.interactiveLiveViewUrl ?? lv.liveViewUrl;
          let host = "live browser";
          try { if (lv.url) host = new URL(lv.url).hostname.replace(/^www\./, ""); } catch { /* keep default */ }
          return (
            <div className="mb-28 rounded-14 overflow-hidden border border-border-faint bg-black-alpha-2">
              <div className="flex items-center gap-8 px-12 py-8 border-b border-border-faint">
                <span className="relative flex h-7 w-7 flex-shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-heat-100 opacity-60" />
                  <span className="relative inline-flex h-7 w-7 rounded-full bg-heat-100" />
                </span>
                <span className="text-mono-x-small uppercase tracking-wider text-heat-100">Live</span>
                <span className="text-mono-x-small text-black-alpha-48 truncate">{host}</span>
              </div>
              <iframe
                src={src}
                title="Agent live browser"
                className="w-full aspect-[16/10] bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms"
                referrerPolicy="no-referrer"
              />
            </div>
          );
        })()}

        {/* Activity log — appears under the most recent user prompt while running */}
        {isRunning && <ActivityIndicator messages={messages as unknown as ActivityMessage[]} />}

        {/* Session stats scoreboard */}
        {messages.length > 0 && (
          <div className="mt-16 mb-2">
            <div className="flex items-center justify-end gap-x-12 gap-y-4 flex-wrap">
              <div className="flex items-center gap-5 text-mono-x-small text-black-alpha-32">
                <span className="w-5 h-5 rounded-full bg-heat-100" />
                Curated by ShopSmart AI
              </div>
              {sessionStats.fc.total > 0 && (
                <>
                  <div className="flex items-center gap-4 text-mono-x-small text-black-alpha-32">
                    🔥 {sessionStats.fc.total} credits
                  </div>
                  <div className="flex items-center gap-x-8 text-mono-x-small text-black-alpha-24">
                    {(["search", "scrape", "map", "crawl", "interact"] as const).map((tool) => {
                      const b = sessionStats.fc[tool];
                      if (b.credits === 0) return null;
                      return (
                        <span key={tool}>
                          {tool}: {b.credits}
                        </span>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Sticky composer pinned to the bottom (Claude/GPT style) */}
        {messages.length > 0 && (
          <div className="mt-auto sticky bottom-0 z-10 bg-background-base border-t border-border-faint -mx-20 px-20 pt-12 pb-8">
            {/* Error display */}
            {chatError && (() => {
              const raw = chatError.message || "Something went wrong";
              let msg: string;
              try { msg = (JSON.parse(raw).error as string) ?? raw; } catch { msg = raw; }
              // Hide Firecrawl's site-unsupported / enterprise-upsell message and
              // replace it with a clean line.
              if (
                /We apologi[sz]e for the inconvenience|typeform\.com\/to\/Ej6oydlg|do(?:n['']?| not) support this site/i.test(msg)
              ) {
                msg = "That store couldn't be accessed. Try a different one — I'll search elsewhere.";
              }
              return (
                <div className="mb-10 px-14 py-10 border border-accent-crimson/20 bg-accent-crimson/5 text-body-small text-accent-black">
                  <span className="text-accent-crimson text-label-small">Error: </span>
                  {msg}
                </div>
              );
            })()}

            {/* Composer — always visible, even while the agent is working */}
            {(
              <div
                className="bg-accent-white border border-border-faint rounded-12 overflow-hidden transition-all focus-within:border-heat-40"
              >
                <div className="flex items-center gap-8 px-16 py-12 relative">
                  <input
                    className="flex-1 bg-transparent text-body-medium text-accent-black placeholder:text-black-alpha-32 focus:outline-none"
                    placeholder={voiceState === "recording" ? "Listening…" : voiceState === "busy" ? "Transcribing…" : isRunning ? "Agent is working — press stop to interrupt" : "Ask another question..."}
                    value={followUp}
                    onChange={(e) => {
                      const val = e.target.value;
                      setFollowUp(val);
                      const pos = e.target.selectionStart ?? val.length;
                      const before = val.slice(0, pos);
                      const match = before.match(/(?:@|\/)([\w-]*)$/);
                      if (match) {
                        setFollowUpMentionQuery(match[1]);
                        setFollowUpMentionStart(pos - match[0].length);
                      } else {
                        setFollowUpMentionQuery(null);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (followUpMentionQuery !== null && followUpMentionSkills.length > 0) {
                        if (e.key === "Escape") { e.preventDefault(); setFollowUpMentionQuery(null); return; }
                        if (e.key === "Enter" || e.key === "Tab") {
                          e.preventDefault();
                          const skill = followUpMentionSkills[0];
                          const before = followUp.slice(0, followUpMentionStart);
                          const after = followUp.slice(e.currentTarget.selectionStart ?? followUp.length);
                          setFollowUp(before + after);
                          setConfig({ ...config, skills: config.skills.includes(skill.name) ? config.skills : [...config.skills, skill.name] });
                          setFollowUpMentionQuery(null);
                          return;
                        }
                      }
                      if (e.key === "Enter" && !isRunning && followUp.trim() && followUpMentionQuery === null) {
                        e.preventDefault();
                        setSuggestions([]);
                        sendMessage({ text: followUp });
                        setFollowUp("");
                      }
                    }}
                  />
                  {followUpMentionQuery !== null && followUpMentionSkills.length > 0 && (
                    <div
                      className="absolute left-0 right-0 bottom-full mb-2 bg-accent-white border border-border-muted overflow-hidden z-10"
                      style={{ boxShadow: "0px 8px 24px -4px rgba(0,0,0,0.08), 0px 2px 8px -2px rgba(0,0,0,0.04)" }}
                    >
                      {followUpMentionSkills.map((skill) => (
                        <button
                          key={skill.name}
                          type="button"
                          className="w-full text-left px-12 py-8 hover:bg-black-alpha-2 transition-all flex items-center gap-8"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            const before = followUp.slice(0, followUpMentionStart);
                            const after = followUp.slice(followUp.length);
                            setFollowUp(before + after);
                            setConfig({ ...config, skills: config.skills.includes(skill.name) ? config.skills : [...config.skills, skill.name] });
                            setFollowUpMentionQuery(null);
                          }}
                        >
                          <SkillsIcon />
                          <div className="min-w-0">
                            <div className="text-label-small text-accent-black">{skill.name}</div>
                            <div className="text-body-small text-black-alpha-40 truncate">{skill.description}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {!isRunning && (
                    <MicButton
                      size={30}
                      onState={setVoiceState}
                      onTranscript={(text) => {
                        if (!text.trim()) return;
                        setSuggestions([]);
                        setFollowUp("");
                        sendMessage({ text });
                      }}
                    />
                  )}
                  {isRunning ? (
                    <button
                      type="button"
                      aria-label="Stop"
                      className="flex-shrink-0 bg-black-alpha-8 hover:bg-black-alpha-12 text-accent-black p-7 rounded-8 transition-all active:scale-95"
                      onClick={stop}
                    >
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                        <rect x="5" y="5" width="10" height="10" rx="2" />
                      </svg>
                    </button>
                  ) : followUp.trim() ? (
                    <button
                      type="button"
                      className="flex-shrink-0 bg-heat-100 hover:bg-[color:var(--heat-90)] text-accent-white p-7 rounded-8 transition-all active:scale-95"
                      onClick={() => {
                        setSuggestions([]);
                        sendMessage({ text: followUp });
                        setFollowUp("");
                      }}
                    >
                      <svg fill="none" height="16" viewBox="0 0 20 20" width="16">
                        <path
                          d="M3.125 10H16.875M11.6667 4.79163L16.875 9.99994L11.6667 15.2083"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.5"
                        />
                      </svg>
                    </button>
                  ) : null}
                </div>
              </div>
            )}

            {/* Suggestions */}
            {!isRunning && suggestions.length > 0 && (
              <div className="flex flex-col mt-10">
                {suggestions.slice(0, 3).map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    className="w-full px-16 py-12 text-body-small text-black-alpha-40 hover:text-accent-black transition-all text-left border border-border-faint -mb-[1px]"
                    onClick={() => {
                      setSuggestions([]);
                      sendMessage({ text: s });
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

          </div>
        )}

          </>
        )}

      </div>
      </div>

      {/* Artifact panel -- right side, auto-opens when output is ready */}
      {artifactOpen && (
        <ArtifactPanel
          messages={messages}
          isRunning={isRunning}
          prompt={config.prompt}
          schema={config.schema}
          urls={config.urls}
          initialSkillMode={artifactSkillMode}
          onRequestFormat={(format) => {
            const skillMap: Record<string, string> = { JSON: "export-json", CSV: "export-csv" };
            const skill = skillMap[format] ?? "export-json";
            sendMessage({ text: `Load the "${skill}" skill and then format all the collected data as ${format}. Follow the skill instructions. Stream the output inline.` });
          }}
          onClose={() => { setArtifactOpen(false); setArtifactSkillMode(false); }}
        />
      )}

      </div>


    </div>
  );
}
