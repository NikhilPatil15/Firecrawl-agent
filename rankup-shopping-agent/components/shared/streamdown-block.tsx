"use client";

import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

const plugins = { code };
const controls = {
  table: false,
  code: false,
};

export default function StreamdownBlock({
  children,
  isStreaming,
}: {
  children: string;
  isStreaming?: boolean;
}) {
  // Strip mermaid fenced blocks — we don't render flowcharts in the agent UI;
  // the LLM occasionally emits a plan diagram which adds visual noise.
  // Strip both closed blocks AND any unterminated trailing block (still streaming),
  // so the raw graph syntax doesn't flash to the user before the closing fence arrives.
  let cleaned = children
    .replace(/```mermaid[\s\S]*?```/g, "")
    .replace(/```mermaid[\s\S]*$/g, "")
    .trimStart();

  // Defensive scrub — never let Firecrawl's "site not supported / enterprise upsell"
  // message reach the user verbatim. The toolkit also intercepts this at source
  // (see agent-core/src/toolkit.ts wrapWithUnsupportedSiteScrubber), but a stray
  // fragment can still leak if the LLM paraphrases. This is the last line of defense.
  const patterns: RegExp[] = [
    // Full apology sentence + optional enterprise line
    /We apologi[sz]e for the inconvenience[^]*?(?:do(?:n['']?| not) support this site[^]*?\.)(?:\s*If you are part of an enterprise[^]*?(?:intake form|typeform\.com)[^\n]*)?/gi,
    // Bare enterprise-upsell sentence
    /If you are part of an enterprise[^]*?(?:intake form|typeform\.com)[^\n]*/gi,
    // Domain unsupported phrasings
    /(?:this )?(?:domain|site|url) is (?:not supported|blocked|unavailable)[^.\n]*\.?/gi,
    // Typeform URLs and "fk4bvu0n5qp" identifier
    /https?:\/\/[^\s)]*typeform\.com[^\s)]*/gi,
    /fk4bvu0n5qp/gi,
  ];
  for (const p of patterns) cleaned = cleaned.replace(p, "");

  cleaned = cleaned
    .replace(/\bFirecrawl\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return (
    <div className="max-w-none [&_pre]:!rounded-0 [&_code]:!rounded-0 [&_div[class*='rounded']]:!rounded-0 [&_div[class*='border']]:!rounded-0 [&_figure]:!rounded-0 [&_.streamdown-code]:!rounded-0">
      <Streamdown
        plugins={plugins}
        controls={controls}
        animated
        caret="block"
        isAnimating={isStreaming}
      >
        {cleaned}
      </Streamdown>
    </div>
  );
}
