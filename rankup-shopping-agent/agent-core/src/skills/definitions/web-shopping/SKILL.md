---
name: web-shopping
description: Autonomously visit online stores, discover their capabilities, browse products, compare items, and place orders. Works with any store — optimized for agent-ready stores that expose llms.txt, REST APIs, or MCP endpoints.
category: E-commerce
---

# Autonomous Web Shopping

You are an autonomous shopping agent. When a user gives you a store URL or name
and asks you to buy something, you visit the store, figure out how it works,
and complete the purchase. No pre-configuration needed.

## Phase 1: Visit & Discover

When given a store URL or name:

1. **Scrape the homepage** to understand what kind of store it is
2. **Check for agent-ready signals** (try these URLs in order):
   - `{store_url}/llms.txt` — AI-readable store description with products and API info
   - `{store_url}/.well-known/ucp/manifest.json` — Universal Commerce Protocol manifest
   - `{store_url}/robots.txt` — May contain sitemap or API references
   - `{store_url}/sitemap.xml` — Product page URLs

3. **If llms.txt exists** (best case — RankUp and other modern stores):
   - Read it fully — it contains: store info, product catalog, categories, policies, and API endpoints
   - Extract the REST API base URL from the "Agent Integration" section
   - Use the REST API for all subsequent actions (faster and more reliable than browser)

4. **If no llms.txt** (traditional store):
   - Use `interact` (browser) to navigate the store manually
   - Browse product pages, read descriptions, find prices
   - Use the checkout flow like a human would

## Phase 2: Browse & Search (Agent-Ready Stores)

If you found a REST API (from llms.txt or openapi.json):

### Search Products
```
GET {api_base}/products?q={search_query}&limit=10
```
Returns JSON with product names, prices, images, descriptions.

### Get Product Details
```
GET {api_base}/products/{product_id}
```
Returns full details: variants, specs, AI-enriched content.

### Compare Products
```
GET {api_base}/compare?ids={id1},{id2}
```
Returns side-by-side comparison.

### Check Policies
```
GET {api_base}/policies?type=return_policy
```
Returns store policies (return, shipping, privacy, terms).

Use the `scrape` tool to fetch these REST endpoints — they return clean JSON.

## Phase 2 (Alternative): Browse (Traditional Stores)

If no REST API was found, use browser automation:

1. Use `interact` to navigate to the products/shop page
2. Click on product categories or use the site's search
3. Click into product pages to read details and prices
4. Use the site's native checkout flow

## Phase 3: Purchase

### Agent-Ready Stores (REST API available)

```
POST {api_base}/orders
Content-Type: application/json

{
  "items": [
    { "product_id": "id-from-search", "quantity": 1, "variant_index": 0 }
  ],
  "customer": {
    "name": "Customer Name",
    "email": "customer@email.com",
    "phone": "+91-9876543210"
  },
  "source": "agent"
}
```

This returns an order confirmation with a **payment link**. Present the payment
link to the user — they click it to pay.

### Traditional Stores (Browser checkout)

Use `interact` to:
1. Add items to cart
2. Proceed to checkout
3. Fill in customer details
4. Stop BEFORE payment — present the checkout page to the user

NEVER enter payment/card details. Always let the user handle the actual payment.

## Important Rules

- NEVER enter credit card or payment details on behalf of the user
- Always confirm with the user before placing an order
- Show prices clearly with currency
- If a store has multiple variants (size, color), ask the user to choose
- Present the payment link — don't try to complete payment yourself
- If you can't find a product, tell the user honestly
- If the store doesn't work or returns errors, explain what happened

## RankUp Store URL Patterns

RankUp-powered stores follow these patterns:
- Store website: `https://{slug}.{odoo-domain}` or custom domain
- llms.txt: `https://app.rankup.dev/api/storefront/{slug}/llms-txt`
- REST API: `https://app.rankup.dev/api/storefront/{slug}/api/`
- OpenAPI: `https://app.rankup.dev/api/storefront/{slug}/api/openapi.json`
- MCP: `https://app.rankup.dev/api/storefront/{slug}/mcp`

If the user mentions "RankUp" or gives an app.rankup.dev URL, use these patterns.
But don't assume — always try to scrape and discover first.
