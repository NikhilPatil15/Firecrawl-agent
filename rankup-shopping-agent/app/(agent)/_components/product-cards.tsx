"use client";

import { useState, useMemo } from "react";
import { cn } from "@/utils/cn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NormalizedProduct {
  id: string;
  name: string;
  price: string | number | null;
  originalPrice: string | number | null;
  currency: string;
  description: string | null;
  imageUrl: string | null;
  category: string | null;
  inStock: boolean | null;
  tags: string[];
  rating: number | null;
  reviewCount: number | null;
  sentiment: "positive" | "mixed" | "negative" | null;
  reviewSummary: string | null;
  source: string | null;
  sourceUrl: string | null;
  bestPick: boolean;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

const NAME_KEYS = new Set([
  "name", "product_name", "productName", "title", "product_title", "productTitle", "item_name", "itemName", "label",
]);

const PRICE_KEYS = new Set([
  "price", "list_price", "listPrice", "sale_price", "salePrice", "cost", "amount", "unit_price", "unitPrice",
  "current_price", "currentPrice", "original_price", "originalPrice", "retail_price", "retailPrice",
]);

const RATING_KEYS = new Set([
  "rating", "stars", "star_rating", "starRating", "average_rating", "averageRating", "score",
]);

const REVIEW_KEYS = new Set([
  "reviewCount", "review_count", "reviews", "num_reviews", "numReviews", "ratings_count", "ratingsCount", "total_reviews", "totalReviews",
]);

const SOURCE_KEYS = new Set([
  "source", "store", "storeName", "store_name", "seller", "merchant", "retailer", "vendor", "shop",
]);

const SOURCE_URL_KEYS = new Set([
  "sourceUrl", "source_url", "url", "link", "product_url", "productUrl", "href", "storeUrl", "store_url",
]);

const IMAGE_KEYS = new Set([
  "image", "imageUrl", "image_url", "thumbnail", "thumbnailUrl", "thumbnail_url",
  "img", "photo", "picture", "img_url", "imgUrl",
]);

// Coupon/deal items rarely have a price or image — they identify themselves by
// a code or an offer/discount string instead.
const COUPON_KEYS = new Set([
  "code", "coupon", "coupon_code", "couponCode", "voucher", "voucher_code", "voucherCode",
  "promo", "promo_code", "promoCode", "discount", "offer", "deal", "savings",
]);

const WRAPPER_KEYS = new Set([
  "products", "items", "results", "data", "deals", "coupons", "offers", "list",
  "recommendations", "comparison", "comparisons", "stores", "options",
]);

function keyHas(keys: string[], set: Set<string>): boolean {
  return keys.some((k) => set.has(k));
}

function hasProductShape(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj as Record<string, unknown>);
  // A "name" can be a real title OR a coupon identifier (code/offer/discount).
  const hasName = keyHas(keys, NAME_KEYS) || keyHas(keys, COUPON_KEYS);
  if (!hasName) return false;
  // Render as long as we have a name plus ONE other meaningful signal — not all
  // shopping outputs have a price (coupon/deal items often don't).
  const hasPrice = keyHas(keys, PRICE_KEYS);
  const hasSource = keyHas(keys, SOURCE_KEYS) || keyHas(keys, SOURCE_URL_KEYS) || keys.includes("__sourceHint");
  const hasImage = keyHas(keys, IMAGE_KEYS);
  const hasRating = keyHas(keys, RATING_KEYS);
  const hasCoupon = keyHas(keys, COUPON_KEYS);
  return hasPrice || hasSource || hasImage || hasRating || hasCoupon;
}

function looksItemish(it: unknown): boolean {
  if (!it || typeof it !== "object" || Array.isArray(it)) return false;
  const keys = Object.keys(it as Record<string, unknown>);
  return keyHas(keys, NAME_KEYS) || keyHas(keys, COUPON_KEYS) || keyHas(keys, PRICE_KEYS);
}

/** "myntra_coupons" -> "Myntra", "ajioProducts" -> "Ajio". */
function sourceFromKey(k: string): string | null {
  const base = k
    .replace(/[_\s-]?(coupons?|promo(?:s|codes?)?|products?|items?|deals?|offers?|results?|list|data)$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  const cleaned = base.replace(/[_\s-]+/g, " ").trim();
  if (!cleaned || cleaned.toLowerCase() === k.toLowerCase()) return null;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function unwrapProducts(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    // 1) A known wrapper key holding the array.
    for (const key of Object.keys(obj)) {
      if (WRAPPER_KEYS.has(key) && Array.isArray(obj[key])) {
        return obj[key] as unknown[];
      }
    }
    // 2) Generic: gather EVERY array-of-items value (e.g. myntra_coupons +
    //    ajio_coupons) and tag each item's source from its container key.
    const collected: unknown[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > 0 && v.some(looksItemish)) {
        const hint = sourceFromKey(k);
        for (const it of v) {
          if (it && typeof it === "object" && !Array.isArray(it)) {
            const item = it as Record<string, unknown>;
            const tagged = hint && !item.source && !item.store && !item.__sourceHint
              ? { __sourceHint: hint, ...item }
              : item;
            collected.push(tagged);
          }
        }
      }
    }
    if (collected.length > 0) return collected;
    // 3) Single object with product shape.
    if (hasProductShape(parsed)) return [parsed];
  }
  return null;
}

/**
 * Heuristic: does this JSON string contain product-like data?
 */
export function isProductData(data: string): boolean {
  try {
    const parsed = JSON.parse(data);
    const items = unwrapProducts(parsed);
    if (!items || items.length === 0) return false;
    // Check at least the first item
    const sample = items.slice(0, 3);
    return sample.some((item) => hasProductShape(item));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extraction & normalization
// ---------------------------------------------------------------------------

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

/** Resolve a possibly-relative image URL (e.g. Odoo's "/web/image/...") to an
 *  absolute URL using the product's source page as the base. */
function resolveImageUrl(url: string | null, base: string | null): string | null {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("data:")) return u;
  if (base && /^https?:\/\//i.test(base)) {
    try { return new URL(u, base).href; } catch { /* fall through */ }
  }
  return u;
}

function normalizeProduct(raw: Record<string, unknown>, index: number): NormalizedProduct {
  // Coupon identifiers — used as a name/description fallback when the model
  // emits coupon-shaped data ({ code, discount, conditions } ) instead of the
  // product schema.
  const couponCode = pickFirst(raw, ["code", "coupon_code", "couponCode", "coupon", "voucher", "voucher_code", "voucherCode", "promo_code", "promoCode", "promo"]);
  const offerText = pickFirst(raw, ["discount", "offer", "deal", "savings"]);
  const couponCodeStr = typeof couponCode === "string" ? couponCode : null;

  const name = (pickFirst(raw, ["name", "product_name", "productName", "title", "product_title", "productTitle", "item_name", "itemName", "label"])
    ?? (typeof offerText === "string" ? offerText : null)
    ?? (couponCodeStr ? `Code: ${couponCodeStr}` : null)
    ?? "Untitled") as string;

  const price = pickFirst(raw, ["price", "sale_price", "salePrice", "current_price", "currentPrice", "cost", "amount", "unit_price", "unitPrice"]) as string | number | null;
  const originalPrice = pickFirst(raw, ["original_price", "originalPrice", "list_price", "listPrice", "retail_price", "retailPrice", "compare_at_price", "compareAtPrice"]) as string | number | null;

  const currency = (pickFirst(raw, ["currency", "currency_code", "currencyCode"]) ?? "") as string;

  let description = (pickFirst(raw, ["description", "product_description", "productDescription", "summary", "snippet", "short_description", "shortDescription"]) ?? null) as string | null;
  // For coupons, assemble a useful line from code + conditions + validity.
  if (!description) {
    const parts: string[] = [];
    if (couponCodeStr) parts.push(`Code: ${couponCodeStr}`);
    if (typeof offerText === "string" && offerText !== name) parts.push(offerText);
    const conditions = pickFirst(raw, ["conditions", "condition", "terms", "min_order", "minOrder", "minimum", "requirement", "requirements"]);
    if (typeof conditions === "string") parts.push(conditions);
    const validity = pickFirst(raw, ["validity", "valid_till", "validTill", "expiry", "expires", "expiry_date", "expiryDate", "valid_until", "validUntil"]);
    if (typeof validity === "string") parts.push(`Valid: ${validity}`);
    if (parts.length) description = parts.join(" · ");
  }

  const rawImageUrl = (pickFirst(raw, ["image", "imageUrl", "image_url", "thumbnail", "thumbnailUrl", "thumbnail_url", "img", "photo", "picture", "img_url", "imgUrl"]) ?? null) as string | null;

  const category = (pickFirst(raw, ["category", "product_category", "productCategory", "type", "product_type", "productType", "department"]) ?? null) as string | null;

  const stockRaw = pickFirst(raw, ["in_stock", "inStock", "available", "availability", "is_available", "isAvailable"]);
  let inStock: boolean | null = null;
  if (typeof stockRaw === "boolean") inStock = stockRaw;
  else if (typeof stockRaw === "string") {
    const lower = stockRaw.toLowerCase();
    if (lower === "true" || lower === "in stock" || lower === "available") inStock = true;
    else if (lower === "false" || lower === "out of stock" || lower === "unavailable") inStock = false;
  }

  const tagsRaw = pickFirst(raw, ["tags", "labels", "keywords"]);
  const tags: string[] = Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === "string").slice(0, 5) : [];

  const ratingRaw = pickFirst(raw, [...RATING_KEYS]);
  let rating: number | null = null;
  if (ratingRaw !== null) {
    const num = typeof ratingRaw === "number" ? ratingRaw : parseFloat(String(ratingRaw));
    if (!isNaN(num)) rating = num;
  }

  const reviewRaw = pickFirst(raw, [...REVIEW_KEYS]);
  let reviewCount: number | null = null;
  if (reviewRaw !== null) {
    const num = typeof reviewRaw === "number" ? reviewRaw : parseInt(String(reviewRaw).replace(/[^0-9]/g, ""), 10);
    if (!isNaN(num)) reviewCount = num;
  }

  // Review sentiment + a one-line gist of what buyers say.
  const sentimentRaw = pickFirst(raw, ["sentiment", "review_sentiment", "reviewSentiment", "overall_sentiment", "overallSentiment"]);
  let sentiment: NormalizedProduct["sentiment"] = null;
  if (typeof sentimentRaw === "string") {
    const s = sentimentRaw.toLowerCase();
    if (/pos|good|great|excellent|favou?rable|love/.test(s)) sentiment = "positive";
    else if (/neg|bad|poor|unfavou?rable|complaint/.test(s)) sentiment = "negative";
    else if (/mix|average|neutral|\bok\b|so.?so/.test(s)) sentiment = "mixed";
  }
  const reviewSummary = (pickFirst(raw, ["reviewSummary", "review_summary", "reviews_summary", "sentiment_summary", "review_highlights", "reviewHighlights"]) ?? null) as string | null;

  const source = (pickFirst(raw, [...SOURCE_KEYS]) ?? raw.__sourceHint ?? null) as string | null;
  const sourceUrl = (pickFirst(raw, [...SOURCE_URL_KEYS]) ?? null) as string | null;
  const imageUrl = resolveImageUrl(rawImageUrl, sourceUrl);

  const bestPickRaw = raw.bestPick ?? raw.best_pick ?? raw.recommended ?? false;
  const bestPick = bestPickRaw === true || bestPickRaw === "true";

  const id = (raw.id ?? raw.product_id ?? raw.productId ?? raw.sku ?? `product-${index}`) as string;

  return { id: String(id), name, price, originalPrice, currency, description, imageUrl, category, inStock, tags, rating, reviewCount, sentiment, reviewSummary, source, sourceUrl, bestPick };
}

export function extractProducts(data: string): NormalizedProduct[] {
  try {
    const parsed = JSON.parse(data);
    const items = unwrapProducts(parsed);
    if (!items) return [];
    return items
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item, i) => normalizeProduct(item as Record<string, unknown>, i));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPrice(value: string | number | null, currency: string): string | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "string" ? parseFloat(value.replace(/[^0-9.-]/g, "")) : value;
  if (isNaN(num)) return typeof value === "string" ? value : null;

  // Default to INR when the source didn't specify a currency.
  const code = (currency && currency.length === 3 ? currency : "INR").toUpperCase();

  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: code === "INR" ? 0 : 2,
    }).format(num);
  } catch {
    // fall through
  }

  // If the original string already has a symbol, return as-is
  if (typeof value === "string" && /[£€$¥₹]/.test(value)) return value;

  return `₹${num.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function calcDiscountPct(price: number | string | null, original: number | string | null): number | null {
  const p = typeof price === "number" ? price : parseFloat(String(price ?? "").replace(/[^0-9.-]/g, ""));
  const o = typeof original === "number" ? original : parseFloat(String(original ?? "").replace(/[^0-9.-]/g, ""));
  if (!isFinite(p) || !isFinite(o) || o <= 0 || p >= o) return null;
  return Math.round(((o - p) / o) * 100);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Small store identity chip: favicon (when we have a URL) + name. */
function StoreChip({ source, sourceUrl }: { source: string | null; sourceUrl: string | null }) {
  const host = hostOf(sourceUrl);
  const label = source ?? host;
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-5 max-w-full">
      {host && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
          alt=""
          width={14}
          height={14}
          className="rounded-3 flex-shrink-0"
          referrerPolicy="no-referrer"
        />
      )}
      <span className="text-mono-x-small text-black-alpha-48 truncate">{label}</span>
    </span>
  );
}

function Stars({ rating, reviewCount }: { rating: number; reviewCount: number | null }) {
  return (
    <div className="flex items-center gap-5 tabular-nums">
      <div className="flex items-center gap-3 px-6 py-2 rounded-full bg-heat-8">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className="text-heat-100">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
        </svg>
        <span className="text-mono-x-small font-medium text-heat-100">{rating.toFixed(1)}</span>
      </div>
      {reviewCount !== null && (
        <span className="text-mono-x-small text-black-alpha-32">
          {reviewCount.toLocaleString("en-IN")} reviews
        </span>
      )}
    </div>
  );
}

function SentimentTag({ sentiment }: { sentiment: NonNullable<NormalizedProduct["sentiment"]> }) {
  const cfg = {
    positive: { label: "Mostly positive", cls: "bg-heat-8 text-heat-100", style: undefined as { background?: string } | undefined },
    mixed: { label: "Mixed reviews", cls: "bg-black-alpha-5 text-black-alpha-56", style: undefined as { background?: string } | undefined },
    negative: { label: "Mostly negative", cls: "text-accent-crimson", style: { background: "rgba(235,52,36,0.10)" } },
  }[sentiment];
  return (
    <span
      className={cn("inline-flex items-center gap-4 px-7 py-2 rounded-full text-mono-x-small font-medium", cfg.cls)}
      style={cfg.style}
    >
      <span className="w-5 h-5 rounded-full bg-current opacity-80" />
      {cfg.label}
    </span>
  );
}

function ProductImage({
  product,
  className,
}: {
  product: NormalizedProduct;
  className?: string;
}) {
  const [imgError, setImgError] = useState(false);
  return (
    <div className={cn("relative bg-black-alpha-3 overflow-hidden", className)}>
      {product.imageUrl && !imgError ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={product.imageUrl}
            alt={product.name}
            className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.06]"
            onError={() => setImgError(true)}
            referrerPolicy="no-referrer"
            loading="lazy"
          />
          {/* legibility scrim at the bottom edge */}
          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/15 to-transparent pointer-events-none" />
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-black-alpha-2 to-black-alpha-5">
          <svg fill="none" height="30" viewBox="0 0 24 24" width="30" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="text-black-alpha-16">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </div>
      )}
    </div>
  );
}

function DiscountBadge({ pct }: { pct: number }) {
  return (
    <span className="absolute top-10 right-10 inline-flex items-center gap-2 px-8 py-3 rounded-full text-mono-x-small font-semibold text-accent-white tabular-nums shadow-[0_2px_8px_rgba(15,161,92,0.35)] bg-heat-100">
      −{pct}%
    </span>
  );
}

function PriceRow({
  priceStr,
  originalStr,
  showSale,
  savings,
  size = "default",
}: {
  priceStr: string | null;
  originalStr: string | null;
  showSale: boolean;
  savings: string | null;
  size?: "default" | "large";
}) {
  if (!priceStr) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 tabular-nums">
      <span className={cn("text-accent-black tracking-tight font-medium", size === "large" ? "text-title-h4" : "text-label-large")}>
        {priceStr}
      </span>
      {showSale && originalStr && (
        <span className={cn("text-black-alpha-32 line-through", size === "large" ? "text-body-medium" : "text-body-small")}>
          {originalStr}
        </span>
      )}
      {savings && (
        <span className="text-mono-x-small font-medium text-heat-100">save {savings}</span>
      )}
    </div>
  );
}

/** Standard product card (grid cell). */
export interface ProductPick {
  name: string;
  priceLabel: string | null;
  source: string | null;
  sourceUrl: string | null;
}

function ProductCard({ product, index = 0, onSelect }: { product: NormalizedProduct; index?: number; onSelect?: (p: ProductPick) => void }) {
  const priceStr = formatPrice(product.price, product.currency);
  const originalStr = formatPrice(product.originalPrice, product.currency);
  const showSale = !!(originalStr && priceStr && originalStr !== priceStr);
  const discountPct = showSale ? calcDiscountPct(product.price, product.originalPrice) : null;
  const savings = useMemo(() => {
    const p = typeof product.price === "number" ? product.price : parseFloat(String(product.price ?? "").replace(/[^0-9.-]/g, ""));
    const o = typeof product.originalPrice === "number" ? product.originalPrice : parseFloat(String(product.originalPrice ?? "").replace(/[^0-9.-]/g, ""));
    if (!isFinite(p) || !isFinite(o) || o <= p) return null;
    return formatPrice(o - p, product.currency);
  }, [product.price, product.originalPrice, product.currency]);

  const pick: ProductPick = { name: product.name, priceLabel: priceStr, source: product.source, sourceUrl: product.sourceUrl };
  // Only real products (which have an image) are "buyable". Coupons / deals /
  // EMI & cashback offers (no image) are NOT — they just link out if they have
  // a URL, and never show a "Buy this" action.
  const buyable = !!onSelect && !!product.imageUrl;
  const Wrapper = buyable ? "div" : product.sourceUrl ? "a" : "div";
  const wrapperProps = buyable
    ? {
        onClick: () => onSelect!(pick),
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect!(pick); }
        },
      }
    : product.sourceUrl
      ? { href: product.sourceUrl, target: "_blank", rel: "noopener noreferrer" }
      : {};

  // Any item without an image renders compact — no big empty image placeholder.
  // Covers coupons, deals, EMI/cashback offers, and products with no image.
  const noImage = !product.imageUrl;

  return (
    <Wrapper
      {...wrapperProps}
      style={{ animationDelay: `${Math.min(index, 12) * 55}ms` }}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-16 bg-accent-white animate-card-rise",
        "border border-border-faint shadow-[0_1px_2px_rgba(0,0,0,0.03)]",
        "transition-[transform,box-shadow,border-color] duration-300 ease-out",
        "hover:-translate-y-2 hover:border-heat-40 hover:shadow-[0_18px_40px_-18px_rgba(15,161,92,0.28)]",
        (buyable || product.sourceUrl) && "cursor-pointer",
      )}
    >
      {!noImage && <ProductImage product={product} className="aspect-[4/3]" />}
      {!noImage && discountPct !== null && <DiscountBadge pct={discountPct} />}
      {product.inStock === false && (
        <span className="absolute top-10 left-10 px-8 py-3 rounded-full text-mono-x-small font-medium text-accent-white bg-black/55 backdrop-blur-md">
          Out of stock
        </span>
      )}

      <div className={cn("flex flex-col flex-1 min-w-0 p-14 gap-8", noImage && "p-16")}>
        <div className="flex items-center gap-6">
          {noImage && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-heat-100 flex-shrink-0">
              <path d="M20 12a2 2 0 0 1 0-4V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2a2 2 0 0 1 0 4v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2z" />
              <path d="M15 9l-6 6" />
            </svg>
          )}
          <StoreChip source={product.source} sourceUrl={product.sourceUrl} />
        </div>

        <h3 className={cn("text-accent-black leading-snug tracking-tight text-pretty line-clamp-2", noImage ? "text-label-large" : "text-label-medium")}>
          {product.name}
        </h3>

        {/* Coupons/deals carry their code in the description and have no price —
            show it so the card is useful. */}
        {(noImage || !priceStr) && product.description && (
          <p className="text-body-small text-black-alpha-56 line-clamp-3">{product.description}</p>
        )}

        <div className="mt-auto pt-2 flex flex-col gap-8">
          <PriceRow priceStr={priceStr} originalStr={originalStr} showSale={showSale} savings={savings} />
          {(product.rating !== null || product.sentiment) && (
            <div className="flex items-center gap-6 flex-wrap">
              {product.rating !== null && <Stars rating={product.rating} reviewCount={product.reviewCount} />}
              {product.sentiment && <SentimentTag sentiment={product.sentiment} />}
            </div>
          )}
          {product.reviewSummary && (
            <p className="text-mono-x-small text-black-alpha-40 leading-relaxed line-clamp-2">“{product.reviewSummary}”</p>
          )}
          {buyable ? (
            <div className="flex items-center gap-4 text-mono-x-small font-semibold text-heat-100 group-hover:gap-6 transition-all">
              <svg fill="none" height="12" viewBox="0 0 24 24" width="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
              </svg>
              <span>Buy this</span>
            </div>
          ) : product.sourceUrl ? (
            <div className="flex items-center gap-4 text-mono-x-small font-medium text-black-alpha-32 group-hover:text-heat-100 transition-colors">
              <span>View on {product.source ?? hostOf(product.sourceUrl) ?? "store"}</span>
              <svg fill="none" height="11" viewBox="0 0 24 24" width="11" className="group-hover:translate-x-1 transition-transform" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17L17 7M9 7h8v8" />
              </svg>
            </div>
          ) : null}
        </div>
      </div>
    </Wrapper>
  );
}

/** Hero "Best Pick" card — wide, with an animated heat ring. */
function FeaturedCard({ product, onSelect }: { product: NormalizedProduct; onSelect?: (p: ProductPick) => void }) {
  const priceStr = formatPrice(product.price, product.currency);
  const originalStr = formatPrice(product.originalPrice, product.currency);
  const showSale = !!(originalStr && priceStr && originalStr !== priceStr);
  const discountPct = showSale ? calcDiscountPct(product.price, product.originalPrice) : null;
  const savings = useMemo(() => {
    const p = typeof product.price === "number" ? product.price : parseFloat(String(product.price ?? "").replace(/[^0-9.-]/g, ""));
    const o = typeof product.originalPrice === "number" ? product.originalPrice : parseFloat(String(product.originalPrice ?? "").replace(/[^0-9.-]/g, ""));
    if (!isFinite(p) || !isFinite(o) || o <= p) return null;
    return formatPrice(o - p, product.currency);
  }, [product.price, product.originalPrice, product.currency]);

  const pick: ProductPick = { name: product.name, priceLabel: priceStr, source: product.source, sourceUrl: product.sourceUrl };
  const Wrapper = onSelect ? "div" : product.sourceUrl ? "a" : "div";
  const wrapperProps = onSelect
    ? { onClick: () => onSelect(pick), role: "button" as const, tabIndex: 0 }
    : product.sourceUrl
      ? { href: product.sourceUrl, target: "_blank", rel: "noopener noreferrer" }
      : {};

  return (
    <div className={cn("md:col-span-2 relative rounded-20 p-[2px] overflow-hidden animate-card-rise", onSelect && "cursor-pointer")}>
      {/* Static emerald frame — no animation, just a premium green edge */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-20"
        style={{
          background:
            "linear-gradient(135deg, rgba(15,161,92,0.5), rgba(15,161,92,0.15) 50%, rgba(15,161,92,0.5))",
        }}
      />
      <Wrapper
        {...wrapperProps}
        className={cn(
          "group relative z-10 flex flex-col md:flex-row overflow-hidden rounded-[18px] bg-accent-white",
          "shadow-[0_24px_60px_-26px_rgba(15,161,92,0.28)]",
          "transition-transform duration-300 ease-out hover:-translate-y-1",
        )}
      >
        <div className="relative md:w-[42%] flex-shrink-0">
          <ProductImage product={product} className="aspect-[4/3] md:h-full md:aspect-auto" />
          {discountPct !== null && <DiscountBadge pct={discountPct} />}
        </div>

        <div className="flex flex-col flex-1 min-w-0 p-20 md:p-24 gap-10">
          <div className="flex items-center gap-8">
            <span className="inline-flex items-center gap-4 px-8 py-3 rounded-full bg-heat-100 text-accent-white text-mono-x-small font-semibold tracking-wide shadow-[0_2px_10px_rgba(15,161,92,0.4)]">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.5 11.5L3 8l1.1-1.1 2.4 2.4L11.9 4l1.1 1.1z" />
              </svg>
              Best pick
            </span>
            <StoreChip source={product.source} sourceUrl={product.sourceUrl} />
          </div>

          <h3 className="text-accent-black text-title-h5 leading-tight tracking-tight text-pretty line-clamp-3">
            {product.name}
          </h3>

          {product.description && (
            <p className="text-body-small text-black-alpha-56 line-clamp-2 max-w-[56ch]">
              {product.description}
            </p>
          )}

          {product.reviewSummary && (
            <p className="text-mono-x-small text-black-alpha-40 leading-relaxed line-clamp-2 max-w-[56ch]">“{product.reviewSummary}”</p>
          )}

          <div className="mt-auto pt-4 flex flex-col gap-12">
            <PriceRow priceStr={priceStr} originalStr={originalStr} showSale={showSale} savings={savings} size="large" />
            <div className="flex items-center justify-between gap-12 flex-wrap">
              <div className="flex items-center gap-6 flex-wrap">
                {product.rating !== null && <Stars rating={product.rating} reviewCount={product.reviewCount} />}
                {product.sentiment && <SentimentTag sentiment={product.sentiment} />}
              </div>
              {(onSelect || product.sourceUrl) && (
                <span className="inline-flex items-center gap-6 px-14 py-8 rounded-10 bg-heat-100 text-accent-white text-label-small font-medium transition-all group-hover:bg-[color:var(--heat-90)] group-hover:gap-8 active:scale-[0.98]">
                  {onSelect ? "Buy this" : "View deal"}
                  <svg fill="none" height="13" viewBox="0 0 24 24" width="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </span>
              )}
            </div>
          </div>
        </div>
      </Wrapper>
    </div>
  );
}

interface ProductCardsProps {
  data: string;
  onViewJson: () => void;
  onSelect?: (p: ProductPick) => void;
}

export function ProductCards({ data, onViewJson, onSelect }: ProductCardsProps) {
  const products = useMemo(() => extractProducts(data), [data]);

  if (products.length === 0) return null;

  // Find featured (best pick) — first one only — and render it big
  const featuredIdx = products.findIndex((p) => p.bestPick);
  const featured = featuredIdx >= 0 ? products[featuredIdx] : null;
  const rest = featured ? products.filter((_, i) => i !== featuredIdx) : products;

  return (
    <div className="flex flex-col gap-14">
      {/* Meta row */}
      <div className="flex items-center gap-8 text-mono-x-small">
        <span className="inline-flex items-center gap-6 uppercase tracking-wider text-black-alpha-48 tabular-nums">
          <span className="relative flex h-6 w-6">
            <span className="relative inline-flex h-6 w-6 rounded-full bg-heat-100" />
          </span>
          {products.length} {products.length === 1 ? "result" : "results"}
        </span>
        <span className="flex-1 h-px bg-black-alpha-6" />
        <button
          type="button"
          className="text-black-alpha-32 hover:text-accent-black transition-colors uppercase tracking-wider"
          onClick={onViewJson}
        >
          View JSON
        </button>
      </div>

      {/* Featured + grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-14">
        {featured && <FeaturedCard key={featured.id} product={featured} onSelect={onSelect} />}
        {rest.map((p, i) => (
          <ProductCard key={p.id} product={p} index={i} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
