import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { auth } from "@/auth";
import { getProviderApiKeys, getFirecrawlKey } from "@agent/_lib/config/keys";

export const maxDuration = 90;

// Forced structured extraction. Unlike the agent, this CANNOT narrate, refuse,
// or re-scrape — generateObject must return schema-shaped JSON. It's the
// deterministic safety net that guarantees product cards whenever a run found
// products but didn't call formatOutput itself.
//
// When a store URL is provided, we ALSO scrape its catalog (the /shop page)
// server-side — this is the robust fix for agents that use `interact` and
// return only one product / no images: scraping the listing yields the full
// catalog with absolute image URLs.

const Item = z.object({
  name: z.string().describe("Product or offer title"),
  price: z.number().nullable().describe("Current price as a plain number in INR (no symbols); null if unknown"),
  originalPrice: z.number().nullable().describe("MRP / struck-through price as a number; null if none"),
  currency: z.string().describe('Always "INR"'),
  imageUrl: z.string().nullable().describe("Direct product image URL if present; else null"),
  description: z.string().nullable().describe("One short line; for coupons include the code"),
  source: z.string().nullable().describe("Store name, e.g. Amazon.in, Flipkart, boAt"),
  sourceUrl: z.string().nullable().describe("Product page URL if present; else null"),
  rating: z.number().nullable(),
  reviewCount: z.number().nullable(),
  sentiment: z.enum(["positive", "mixed", "negative"]).nullable().describe("Overall review sentiment if review text/ratings are present; else null"),
  reviewSummary: z.string().nullable().describe("One short line on what reviewers say (e.g. 'Great battery, weak mic'); else null"),
  bestPick: z.boolean().describe("true on exactly one best item, false otherwise"),
});

async function scrapeMarkdown(url: string, key: string): Promise<string> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(45000),
    });
    const d = (await res.json()) as { data?: { markdown?: string }; markdown?: string };
    return (d?.data?.markdown ?? d?.markdown ?? "") || "";
  } catch {
    return "";
  }
}

// Build candidate catalog URLs from a store URL the user gave.
function catalogUrls(raw: string): string[] {
  try {
    const u = new URL(raw);
    const origin = u.origin;
    const urls = new Set<string>();
    // If they linked a deep page, scrape it too; always try the shop listing.
    urls.add(`${origin}/shop`);
    if (u.pathname && u.pathname !== "/") urls.add(raw);
    urls.add(origin);
    return Array.from(urls).slice(0, 2);
  } catch {
    return [];
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { text, url } = (await req.json().catch(() => ({}))) as { text?: string; url?: string };

  const key = getProviderApiKeys().anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ items: [] });

  // If a store URL is present, scrape its catalog for complete data (images!).
  let catalog = "";
  const fcKey = getFirecrawlKey();
  if (url && fcKey) {
    const parts = await Promise.all(catalogUrls(url).map((u) => scrapeMarkdown(u, fcKey)));
    catalog = parts.filter(Boolean).join("\n\n").slice(0, 22000);
  }

  const source = `${catalog ? `--- STORE CATALOG (scraped from ${url}) ---\n${catalog}\n\n` : ""}${
    text ? `--- ASSISTANT OUTPUT ---\n${(text || "").slice(0, 14000)}` : ""
  }`;
  if (source.trim().length < 24) return Response.json({ items: [] });

  const anthropic = createAnthropic({ apiKey: key });
  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5-20251001"),
      schema: z.object({ items: z.array(Item) }),
      prompt:
        "Extract EVERY distinct product (or coupon) from the content below into the JSON. Prefer the STORE CATALOG section when present — it is the source of truth and contains image URLs. " +
        "Rules: currency is always \"INR\"; price/originalPrice are plain numbers (strip ₹/Rs and commas); set bestPick true on exactly ONE best item and false on the rest. " +
        "imageUrl MUST be the product's absolute image URL when the catalog shows one (e.g. an .../web/image/... or https image link). " +
        "sourceUrl is the product's own page URL. For variant-priced products set price to the lowest/base variant and put the range in description. " +
        "If the content includes review text or a rating, set sentiment (positive/mixed/negative) and a one-line reviewSummary of what buyers say; otherwise leave both null. " +
        "Only use null when truly no value exists. Do NOT invent products. If there are none, return an empty items array.\n\n" +
        source,
    });
    return Response.json({ items: object.items ?? [] });
  } catch (err) {
    return Response.json({ items: [], error: err instanceof Error ? err.message : "error" });
  }
}
