import type { UIMessage } from "ai";

export function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

// LangChain ToolMessage content is a string of JSON-stringified tool output.
// Parse when possible.
export function normalizeToolOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return raw;
  try { return JSON.parse(trimmed); } catch { return raw; }
}

export interface FormattedOutput {
  format: "text" | "json" | "csv";
  content: string;
}

export function extractMessageFormatted(msg: UIMessage): FormattedOutput & { streaming: boolean } | null {
  if (msg.role !== "assistant") return null;
  for (const part of msg.parts) {
    if (!isToolPart(part)) continue;
    const p = part as Record<string, unknown>;
    const toolName = (p.toolName ?? (part.type as string).replace("tool-", "")) as string;
    if (toolName !== "formatOutput") continue;

    const state = (p.state ?? "") as string;
    const rawOutput = normalizeToolOutput(p.output ?? p.result);
    const output = (rawOutput && typeof rawOutput === "object")
      ? rawOutput as { format?: string; content?: string }
      : undefined;
    const isComplete = state === "output-available" || state === "result" || !!(output?.format && output?.content);

    if (isComplete && output?.format && output?.content) {
      return { format: output.format as FormattedOutput["format"], content: output.content, streaming: false };
    }

    // Still streaming: use the tool input as preview
    const input = (p.input ?? p.args ?? {}) as Record<string, unknown>;
    const format = (input.format as string) ?? output?.format ?? "json";
    let content = output?.content ?? "";
    if (!content && input.data !== undefined) {
      content = typeof input.data === "string" ? input.data : JSON.stringify(input.data, null, 2);
    }
    return { format: format as FormattedOutput["format"], content: content || "...", streaming: true };
  }
  return null;
}

export function extractFormattedOutput(messages: UIMessage[]): FormattedOutput & { streaming: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = extractMessageFormatted(messages[i]);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prose → product fallback
//
// The LLM is instructed to ALWAYS call formatOutput with structured JSON for
// shopping queries. When it forgets and replies with a numbered/bulleted list
// of products in plain markdown, we parse the prose into the same shape so the
// UI can still render product cards instead of a wall of text.
// ---------------------------------------------------------------------------

interface ProseProduct {
  name: string;
  price: number | null;
  originalPrice: number | null;
  currency: string;
  description: string | null;
  source: string | null;
  bestPick: boolean;
}

function parsePriceTokenToNumber(s: string): number | null {
  // Captures the first INR-looking number, ignoring commas. Handles "₹6,999",
  // "6999 INR", "Rs. 5,500", "~₹5,500–6,500" (takes first), etc.
  const m = s.match(/(?:₹|Rs\.?\s*|INR\s*)?([0-9][0-9,]{2,})/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function detectStore(text: string): string | null {
  const stores = [
    // Marketplaces & big retail
    "Amazon.in", "Amazon", "Flipkart", "Myntra", "Ajio", "Croma",
    "Reliance Digital", "Vijay Sales", "Snapdeal", "Tata Cliq", "Pepperfry",
    "Nykaa", "Meesho", "Firstcry", "Bigbasket", "Blinkit", "Zepto",
    // Official brand / D2C stores (deals often live here)
    "boAt", "Noise", "Boult", "Mivi", "pTron", "Samsung", "Mi", "Xiaomi",
    "OnePlus", "Realme", "Nothing", "Apple", "JBL", "Sony", "Asus", "Lenovo",
    "HP", "Dell", "Acer", "Puma", "Nike", "Adidas", "Decathlon", "Bata",
    "Wakefit", "Sleepycat", "boAt Lifestyle",
  ];
  for (const s of stores) {
    if (new RegExp(`\\b${s.replace(/\./g, "\\.")}\\b`, "i").test(text)) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markdown table → products
//
// The LLM frequently presents shopping results as a markdown comparison table
// (| Product | Price | Store | ...). The card renderer can't read that, so the
// user just sees a wall of pipes. We parse the table back into product objects.
// ---------------------------------------------------------------------------

interface RichProduct {
  name: string;
  price: number | null;
  originalPrice: number | null;
  currency: string;
  description: string | null;
  source: string | null;
  sourceUrl: string | null;
  imageUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  inStock: boolean | null;
  bestPick: boolean;
}

type ColRole =
  | "name" | "price" | "originalPrice" | "rating" | "reviewCount"
  | "source" | "sourceUrl" | "imageUrl" | "description" | "inStock" | "bestPick";

function columnRole(header: string): ColRole | null {
  const h = header.toLowerCase().trim();
  if (/image|photo|thumb|pic/.test(h)) return "imageUrl";
  if (/original|mrp|list price|strike|\bwas\b/.test(h)) return "originalPrice";
  if (/url|link|product page|buy link/.test(h)) return "sourceUrl";
  if (/\b(name|product|item|model|title)\b/.test(h)) return "name";
  if (/price|cost|sale|amount|deal|₹|rs\.?/.test(h)) return "price";
  if (/review/.test(h)) return "reviewCount";
  if (/rating|stars?|score/.test(h)) return "rating";
  if (/store|source|retailer|seller|site|platform|merchant|vendor|where|available at/.test(h)) return "source";
  if (/stock|availab/.test(h)) return "inStock";
  if (/best|pick|recommend|verdict|top choice/.test(h)) return "bestPick";
  if (/desc|detail|note|feature|spec|highlight|why|reason/.test(h)) return "description";
  return null;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-/.test(line);
}

function extractLink(cell: string): { text: string; url: string | null } {
  const md = cell.match(/\[([^\]]*)\]\(([^)\s]+)\)/);
  if (md) return { text: md[1].trim() || md[2].trim(), url: md[2].trim() };
  const bare = cell.match(/https?:\/\/[^\s)]+/);
  if (bare) return { text: cell.replace(bare[0], "").trim(), url: bare[0] };
  return { text: cell, url: null };
}

function cleanText(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/[🥇🥈🥉🏆⭐️✨🔥💎🎯✅✔️]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRating(cell: string): number | null {
  const m = cell.match(/([0-5](?:\.\d)?)\s*(?:\/\s*5|★|stars?|out of 5)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : null;
}

function parseInt0(cell: string): number | null {
  const digits = cell.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseProductsFromTable(raw: string): RichProduct[] | null {
  if (!raw || !raw.includes("|")) return null;
  const lines = raw.split("\n");
  const products: RichProduct[] = [];

  let i = 0;
  while (i < lines.length) {
    // A table starts with a header row followed by a separator row.
    if (
      lines[i].trim().startsWith("|") &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1])
    ) {
      const headers = splitRow(lines[i]);
      const roles = headers.map(columnRole);

      // Only treat this as a PRODUCT table if it has a price, image, or product
      // URL column. A table of e.g. "Platform | Program | Discount | Verification"
      // is not a product list — leave it as a table rather than faking cards.
      const looksLikeProducts =
        roles.includes("price") || roles.includes("imageUrl") || roles.includes("sourceUrl");
      if (!looksLikeProducts) {
        let k = i + 2;
        while (k < lines.length && lines[k].trim().startsWith("|")) k++;
        i = k;
        continue;
      }

      // Ensure there's at least a plausible name column; else use column 0.
      if (!roles.includes("name")) {
        const firstUsable = roles.findIndex((r) => r === null);
        roles[firstUsable >= 0 ? firstUsable : 0] = "name";
      }

      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        if (isSeparatorRow(lines[j])) { j++; continue; }
        const cells = splitRow(lines[j]);
        const p: RichProduct = {
          name: "", price: null, originalPrice: null, currency: "INR",
          description: null, source: null, sourceUrl: null, imageUrl: null,
          rating: null, reviewCount: null, inStock: null, bestPick: false,
        };
        const rowText = cells.join(" ");
        cells.forEach((cell, idx) => {
          const role = roles[idx];
          if (!role || !cell) return;
          switch (role) {
            case "name": {
              const { text, url } = extractLink(cell);
              p.name = cleanText(text);
              if (url && !p.sourceUrl) p.sourceUrl = url;
              break;
            }
            case "price": if (p.price === null) p.price = parsePriceTokenToNumber(cell); break;
            case "originalPrice": p.originalPrice = parsePriceTokenToNumber(cell); break;
            case "rating": p.rating = parseRating(cell); break;
            case "reviewCount": p.reviewCount = parseInt0(cell); break;
            case "source": {
              const { text, url } = extractLink(cell);
              p.source = cleanText(text) || detectStore(cell);
              if (url && !p.sourceUrl) p.sourceUrl = url;
              break;
            }
            case "sourceUrl": { const { url } = extractLink(cell); if (url) p.sourceUrl = url; break; }
            case "imageUrl": { const { url } = extractLink(cell); if (url) p.imageUrl = url; break; }
            case "description": p.description = cleanText(cell).slice(0, 160) || null; break;
            case "inStock":
              p.inStock = /in stock|available|yes|✓|✅/i.test(cell)
                ? true
                : /out of stock|unavailable|no\b/i.test(cell) ? false : null;
              break;
            case "bestPick":
              p.bestPick = /best|✓|✅|yes|🥇|top|recommend/i.test(cell);
              break;
          }
        });

        if (!p.source) p.source = detectStore(rowText);
        if (!p.bestPick && /🥇|best pick|top pick/i.test(rowText)) p.bestPick = true;

        // Keep only rows that look like real products.
        if (p.name && p.name.length >= 2 && (p.price !== null || p.sourceUrl || p.source)) {
          products.push(p);
        }
        j++;
      }
      i = j;
    } else {
      i++;
    }
  }

  if (products.length === 0) return null;
  // Exactly one Best Pick.
  let seenBest = false;
  for (const p of products) {
    if (p.bestPick && !seenBest) seenBest = true;
    else p.bestPick = false;
  }
  return products;
}

/**
 * Try to parse an assistant text part into a list of products. Returns null
 * if the text doesn't look like a structured product list.
 *
 * Recognises both formats:
 *   - `## #1 — Name (~₹5,500)` then a paragraph
 *   - `### 🥇 #1 — Name`, `### Name (₹5,999)`
 *   - numbered list `1. Name — ₹5,999`
 */
export function parseProductsFromProse(raw: string): ProseProduct[] | null {
  if (!raw) return null;
  // Each "block" is a heading or numbered item followed by descriptive text
  // until the next heading or end of string.
  const blockRegex =
    /(?:^|\n)(?:#{1,4}\s*(?:[^\n]*?#?\s*\d+\s*[—–\-:.]\s*|[^\n]*?(?=[A-Z]))|\d+\.\s*)([^\n]+)\n([\s\S]*?)(?=\n(?:#{1,4}\s|\d+\.\s)|$)/g;

  const products: ProseProduct[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(raw)) !== null) {
    const headerLine = m[1].trim();
    const body = (m[2] ?? "").trim();
    if (!headerLine) continue;

    // Header sometimes contains the price after a "(" or "—"
    // Strip emojis and rank prefixes
    let name = headerLine
      .replace(/[🥇🥈🥉🏆⭐️✨🔥💎🎯]/g, "")
      .replace(/^\s*#\d+\s*[—–\-:.]?\s*/, "")
      .replace(/\([^)]*[₹Rr][^)]*\)/g, "")
      .replace(/\s+[—–-]\s+.*$/, "")
      .replace(/\(~?[^)]*\)/g, "")
      .trim();

    if (!name || name.length < 3 || name.length > 120) continue;
    // Reject blocks that are clearly meta-headings ("Key Tips", "Bottom Line")
    if (/^(key|bottom|why|how|note|summary|conclusion|tips?|comparison|verdict)/i.test(name)) continue;

    const combined = `${headerLine} ${body}`;

    // Price: look for ₹ in header first (more reliable), then body
    const headerPrice = headerLine.match(/(?:₹|Rs\.?\s*|INR\s*)([0-9][0-9,]{2,})/i);
    const bodyPrice = body.match(/(?:₹|Rs\.?\s*|INR\s*)([0-9][0-9,]{2,})/i);
    const priceMatch = headerPrice ?? bodyPrice;
    const price = priceMatch ? parsePriceTokenToNumber(priceMatch[0]) : null;
    if (price === null) continue; // No price = probably not a product

    // Description: first sentence of body, cleaned of markdown formatting
    const cleanBody = body
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .replace(/[🥇🥈🥉🏆⭐️✨🔥💎🎯]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const descMatch = cleanBody.match(/^[^.!?\n]{20,260}[.!?]?/);
    const description = descMatch ? descMatch[0].trim() : (cleanBody.slice(0, 200) || null);

    const source = detectStore(combined);
    const bestPick = /best\s*(?:pick|overall)|🥇|#1\b|top\s*pick/i.test(headerLine);

    products.push({
      name,
      price,
      originalPrice: null,
      currency: "INR",
      description,
      source,
      bestPick,
    });
  }

  return products.length >= 2 ? products : null;
}

/**
 * If the latest assistant message has no formatOutput tool call but its text
 * looks like a structured product list, synthesize a FormattedOutput payload
 * so the UI can render cards anyway.
 */
export function synthesizeFallbackProducts(msg: UIMessage): FormattedOutput & { streaming: boolean } | null {
  if (msg.role !== "assistant") return null;
  const texts = msg.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("\n\n");
  if (!texts.trim()) return null;

  // Markdown comparison tables are the most common "no cards" failure — try
  // them first, then fall back to prose headings/numbered lists.
  const fromTable = parseProductsFromTable(texts);
  const fromProse = parseProductsFromProse(texts);

  const chosen =
    fromTable && (!fromProse || fromTable.length >= fromProse.length)
      ? fromTable
      : fromProse;

  if (!chosen || chosen.length === 0) return null;
  return {
    format: "json",
    content: JSON.stringify(chosen),
    streaming: false,
  };
}
