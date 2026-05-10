# Autonomous Web Shopping Agent

An AI agent that can visit any online store, figure out how it works, browse products, and buy things — all on its own. No manual MCP setup. No pre-configured endpoints. No API keys for the store.

You just say: **"Go to this store and buy me headphones"** — and it does.

Built on the Firecrawl Web Agent framework (open-source, has browser automation + web scraping + AI reasoning). Deployed as a Next.js app with a chat UI.

---

## How It Works (No Manual Setup)

```
User: "Go to https://cool-gadgets.odoo.rankup.dev and buy me wireless headphones"

Agent thinking:
  1. Let me visit this store...
  2. I'll check if they have /llms.txt (AI-readable store info)
  3. Found it! This store has a REST API at /api/storefront/cool-gadgets/api
  4. Let me search for "wireless headphones"...
  5. Found 3 options. Let me show the user.
  6. User picked one. Let me get their details and place the order.
  7. Order created. Here's the payment link.

No MCP endpoints configured. No API keys. No manual connections.
The agent discovered everything by visiting the store.
```

### Why this works with RankUp stores

RankUp stores are built to be agent-discoverable:
- Every store has `/llms.txt` — a plain-text file that tells AI agents everything about the store (products, APIs, policies)
- Every store has a public REST API — no auth, no keys, just HTTP calls
- Every store has `/api/openapi.json` — machine-readable API spec

The agent doesn't need to know any of this in advance. It visits the URL, discovers these files, and uses them. Just like a human would find a store's menu, browse products, and checkout.

---

## 1. Scaffold the Project

```bash
# Install Firecrawl CLI
npx -y firecrawl-cli@latest init -y --browser

# Create agent from Next.js template (has chat UI)
firecrawl create agent -t next
cd rankup-shopping-agent
```

---

## 2. Environment Variables

```bash
# .env.local

# Firecrawl — powers browser automation and web scraping
FIRECRAWL_API_KEY=fc-your-key-here

# AI Model (Claude recommended)
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

That's it. No store URLs. No store slugs. No MCP endpoints. The agent discovers stores at runtime.

---

## 3. Add the Shopping SKILL.md

This skill teaches the agent HOW to shop from websites — especially agent-ready ones.

Create: `agent-core/src/skills/definitions/web-shopping/SKILL.md`

```markdown
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
```

---

## 4. System Prompt

Find the orchestrator prompt file and replace/extend with:

```markdown
## Identity

You are an autonomous web shopping agent. Users give you a store URL or name,
and you visit the store, browse products, and help them buy things.

You work like a personal shopping assistant who can actually visit websites:
- You can scrape web pages to read their content
- You can interact with websites using a real browser (click, type, navigate)
- You can search the web to find stores
- You can call REST APIs directly

## How You Shop

1. User gives you a store → you visit it and discover how it works
2. You check for llms.txt (AI-readable store info) — if found, you have the full
   picture including API endpoints
3. You search/browse products based on what the user wants
4. You show options with prices and details
5. When user decides, you collect their name + email and place the order
6. You give them the payment link

## Key Behaviors

- Always discover the store FIRST before doing anything else
- If llms.txt exists, READ IT — it tells you everything about the store
- Use REST APIs when available (faster, more reliable than browser)
- Fall back to browser navigation for traditional stores
- NEVER enter payment details — only present payment links
- Be conversational and helpful, not robotic
- Show prices in the store's currency
- Confirm before placing orders
```

---

## 5. Configure Model

Edit `app/(agent)/_config.ts`:

```typescript
export const config = {
  orchestratorModel: "claude-sonnet-4-20250514",
  subAgentModel: "claude-sonnet-4-20250514",
  backgroundModel: "claude-haiku-4-5-20251001",
  maxWorkers: 10,
  workerMaxSteps: 50,
  experimental: {
    customOpenAI: false,
    skillGenerator: false,
    acp: false,
  },
  history: {
    enabled: true,
  },
};
```

---

## 6. Run

```bash
npm install
npm run dev
# Open http://localhost:3000
```

---

## 7. Demo Script

### Scene 1: Give it a store URL (zero config)
```
User: "Hey, I want to buy something from this store:
       https://app.rankup.dev/api/storefront/cool-gadgets/llms-txt"

Agent: *scrapes the llms.txt*
Agent: "I found Cool Gadgets Store! They sell electronics and accessories.
        They have 15 products across 4 categories.
        What are you looking for?"
```

### Scene 2: Browse
```
User: "What do they have in audio?"

Agent: *calls GET /products?category=audio*
Agent: "Here's what they have in Audio:

        1. Wireless Pro Headphones — ₹4,999 (was ₹6,999)
           Best for: Work from home, Travel
        2. Bass Boost Earbuds — ₹1,499
           Best for: Gym, Commute
        3. Studio Monitor Speakers — ₹8,999
           Best for: Music production

        Want details on any of these?"
```

### Scene 3: Product Details
```
User: "Tell me about the Wireless Pro Headphones"

Agent: *calls GET /products/{id}*
Agent: "Wireless Pro Headphones — ₹4,999 (save ₹2,000!)

        Why buy:
        • 40-hour battery life
        • Active noise cancellation
        • Premium comfort for all-day wear

        Available in: Black, Silver, Navy
        In stock: Yes

        Specs: Bluetooth 5.3, 40mm drivers, USB-C charging
        Weight: 250g

        Want to buy it?"
```

### Scene 4: Check Return Policy
```
User: "What if I don't like them?"

Agent: *calls GET /policies?type=return_policy*
Agent: "Their return policy: 7-day easy returns, no questions asked.
        Free return shipping within India."
```

### Scene 5: Purchase
```
User: "Alright, buy me 1 pair in Black"

Agent: "I'll place the order! What's your name and email?"

User: "Nikhil, nikhil@example.com"

Agent: *calls POST /orders*
Agent: "Order placed!
        Order #SO-042
        Item: Wireless Pro Headphones (Black) × 1
        Total: ₹4,999

        Pay here: https://rzp.io/i/abc123

        Click the link to complete payment via Razorpay."
```

### Scene 6: Another Store (proves it's universal)
```
User: "Nice! Now can you check what organic-foods store has?"

Agent: *scrapes llms.txt for organic-foods*
Agent: "Found Organic Foods! They sell organic groceries and health products.
        23 products across Fruits, Vegetables, Grains, and Superfoods.
        What would you like?"
```

---

## Architecture

```
                    ┌──────────────────────┐
                    │        User          │
                    │  "Buy headphones     │
                    │   from this store"   │
                    └──────────┬───────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────┐
│              Firecrawl Web Agent (Next.js)                │
│                                                           │
│  ┌───────────┐  ┌─────────────┐  ┌─────────────────────┐│
│  │  Claude    │  │  SKILL.md   │  │   Firecrawl Tools   ││
│  │  (brain)   │  │  (shopping  │  │                     ││
│  │           │◄▶│   know-how) │  │  scrape: fetch URLs  ││
│  │  Decides   │  │             │  │  interact: browser   ││
│  │  what to   │  │  Teaches:   │  │  search: web search  ││
│  │  do next   │  │  1. Visit   │  │  bash: process data  ││
│  │           │  │  2. Discover │  │                     ││
│  │           │  │  3. Browse   │  └──────────┬──────────┘│
│  │           │  │  4. Buy      │             │           │
│  └───────────┘  └─────────────┘             │           │
│                                              │           │
│  Agent loop: plan → act → observe → repeat   │           │
└──────────────────────────────────┬───────────┘           │
                                   │                       │
           ┌───────────────────────┼───────────────────┐   │
           │                       │                   │   │
           ▼                       ▼                   ▼   │
  ┌─────────────────┐   ┌──────────────────┐  ┌───────────┤
  │  1. scrape       │   │  2. scrape        │  │ 3. scrape │
  │  /llms.txt       │   │  /api/products    │  │ POST      │
  │                  │   │  ?q=headphones    │  │ /api/     │
  │  "Ah, this store │   │                   │  │ orders    │
  │   has a REST API │   │  Returns JSON     │  │           │
  │   and 15 products│   │  with products    │  │ Returns   │
  │   Let me use it" │   │                   │  │ payment   │
  └─────────────────┘   └──────────────────┘  │ link      │
                                               └───────────┘
           Store A                    Store B
  ┌──────────────────┐      ┌──────────────────┐
  │ cool-gadgets     │      │ organic-foods    │
  │ (RankUp store)   │      │ (RankUp store)   │
  │                  │      │                  │
  │ Has: llms.txt ✓  │      │ Has: llms.txt ✓  │
  │      REST API ✓  │      │      REST API ✓  │
  │      MCP ✓       │      │      MCP ✓       │
  │      OpenAPI ✓   │      │      OpenAPI ✓   │
  └──────────────────┘      └──────────────────┘
```

---

## What Makes This Different

| Other Agents | This Agent |
|-------------|------------|
| Need manual MCP server setup | Zero config — visits the store URL directly |
| Hardcoded to one service | Works with ANY store URL |
| Need API keys for each store | No store API keys — public REST APIs |
| Can only chat | Can actually browse and buy |
| Pre-configured tools | Discovers capabilities from llms.txt |

The agent treats every store like a human would — visit it, read it, understand it, shop from it. RankUp stores just make this easier by having machine-readable discovery files (llms.txt, OpenAPI, UCP).

---

## Deploy

```bash
# Deploy to Vercel
vercel --prod

# Environment variables in Vercel dashboard:
# FIRECRAWL_API_KEY=fc-...
# ANTHROPIC_API_KEY=sk-ant-...
```

Share the deployed URL. Record the demo. That's your autonomous shopping agent.
