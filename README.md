# Scoutpost

Riftbound TCG top-8 decklists with a **live build cost** attached to every deck —
the thing nobody else in the Riftbound tool space publishes.

Deployed at `softsauce.co/scoutpost`, built to move to its own domain later
without a rewrite.

---

## What the pieces are

If you haven't used Cloudflare's platform before, here's the whole stack in plain
terms. Four separate things, each doing one job:

| Piece | What it is | What it does here |
|---|---|---|
| **Worker** | A serverless script that answers HTTP requests | Renders every page from the database |
| **Static assets** | Files in `public/`, served straight from the edge | `styles.css`, `favicon.svg` |
| **D1** | Cloudflare's SQLite database | Cards, prices, events, decks |
| **Cron triggers** | Scheduled Worker invocations | The daily data pull |

There are **three Workers** in this repo, deployed separately because they do
different jobs:

| Directory | Worker | Job |
|---|---|---|
| *(repo root)* | `scoutpost` | The site. Auto-deploys on every push to `main`. |
| `ingest/` | `scoutpost-ingest` | Daily cron data pull. Separate because the site Worker has no schedule. |
| `route-worker/` | `scoutpost-route` | Serves the site at `softsauce.co/scoutpost`. |

`softsauce.co` is served from an existing origin (nginx on a NAS), so
`route-worker` claims just the `/scoutpost*` path and forwards it to the site
Worker, stripping the prefix. Nothing on the existing site changes.

```
                    ┌───────────────────────────┐
softsauce.co/…      │  existing origin (nginx)  │
                    └───────────────────────────┘

softsauce.co/scoutpost ──► route-worker ──► scoutpost Worker + public/ assets
                                                     │ reads
                                                ┌────▼────┐     writes    ┌───────────────┐
                                                │   D1    │◄──────────────┤ scoutpost-    │
                                                └─────────┘  daily cron   │ ingest Worker │
                                                                          └───────┬───────┘
                                                                                  │ fetches
                                                                     Riftscribe ──┘── TCGCSV
```

---

## Layout

```
wrangler.toml            site Worker config (assets, D1, BASE_PATH)
db/schema.sql            D1 schema
src/index.js             router — maps paths to route modules
src/lib/render.js        layout, base-path links, disclaimer, ad slots
src/lib/queries.js       all SQL, including live deck-cost calculation
src/routes/*.js          one module per page
ingest/                  daily cron Worker (catalogue + prices)
route-worker/            serves the site at /scoutpost on the existing domain
public/                  static assets (styles.css, favicon)
data/events/*.json       decklists — the only file you touch to add an event
scripts/import-decks.mjs turns those JSON files into SQL
```

---

## Setup

Requires **Node 18+** (`node --version`). Everything else installs locally.

```bash
npm install
npx wrangler login
```

### 1. Create the database

```bash
npx wrangler d1 create scoutpost
```

Copy the printed `database_id` into **both** config files:
- `wrangler.toml` (the site)
- `ingest/wrangler.toml` (the data job)

The `database_id` is an identifier, not a secret — it grants nothing without an
authenticated token for the account, and committing it is Cloudflare's normal
workflow.

Then create the tables:

```bash
npm run db:schema
```

### 2. Deploy the ingestion Worker

```bash
npx wrangler deploy --config ingest/wrangler.toml
npx wrangler secret put INGEST_TOKEN --config ingest/wrangler.toml   # any long random string
```

Seed the data immediately rather than waiting for the 21:15 UTC cron:

```bash
curl -X POST "https://scoutpost-ingest.<your-subdomain>.workers.dev/run?job=all" \
  -H "Authorization: Bearer <INGEST_TOKEN>"
```

Check what happened at any time:

```bash
curl https://scoutpost-ingest.<your-subdomain>.workers.dev/health
```

### 3. Deploy the site Worker

Either deploy straight from your machine:

```bash
npx wrangler deploy
```

…or connect the repo in the Cloudflare dashboard
(**Workers & Pages → Create → Continue with GitHub**) so it auto-deploys on
every push to `main`. Leave **Build command** empty; the **Deploy command** is
`npx wrangler deploy`.

Everything the Worker needs — the D1 binding, `BASE_PATH`, `SITE_ORIGIN`, the
`public/` asset directory — is already declared in `wrangler.toml`, so there are
no dashboard bindings or environment variables to add by hand.

### 4. Put it on softsauce.co/scoutpost

Set `PAGES_ORIGIN` in `route-worker/wrangler.toml` to the site Worker's URL
(`https://scoutpost.<your-subdomain>.workers.dev`), then:

```bash
npx wrangler deploy --config route-worker/wrangler.toml
```

### 5. SEO

The sitemap is generated live at `/scoutpost/sitemap.xml`. Submit that exact URL
in Google Search Console.

`robots.txt` must live at the **domain root**, which is served by the existing
origin — so add this line to `softsauce.co/robots.txt`:

```
Sitemap: https://softsauce.co/scoutpost/sitemap.xml
```

---

## Adding an event

This is a data operation. No template is ever edited.

```bash
cp data/events/_TEMPLATE.json data/events/worlds-2026.json
# fill it in
node scripts/import-decks.mjs
npx wrangler d1 execute scoutpost --remote --file=build/import.sql
```

Card codes are validated against the live Riftscribe catalogue, so a typo fails
the import instead of silently producing a deck that under-reports its cost.
See `data/events/README.md`.

---

## How build cost is calculated

Deck cost is **computed at read time**, never stored:

```
cost = Σ (quantity × most recent market_price for that card)
```

"Most recent **per card**", not "most recent overall" — if a card missed a day,
it falls back to its own last known price rather than dropping out of the total
and making a deck look cheaper than it is. Pages also report how many cards in a
list are actually priced, so a partial total is visibly partial.

`deck_cost_snapshots` records the daily total for future charting. It is history
only; no page reads a cost from it.

---

## Data sources and the safety rules

| Source | Provides | Reality |
|---|---|---|
| [Riftscribe](https://riftscribe.gg) | Card catalogue | Free, no key. `/api/cards` returns a **bare array**; `limit` caps out — 200 works, **500 silently returns empty**. |
| [TCGCSV](https://tcgcsv.com) | Daily TCGplayer market prices | Free, no account. **Unofficial mirror run by one person — no uptime guarantee.** Updates ~20:00 UTC. Riftbound is `categoryId 89`. |

Because the price source is unsupported, the ingest job **fails closed** at
every step. A missing day is fine; a corrupted day is not.

- Non-JSON responses (an HTML error page returned as `200`) are rejected
- `success !== true` or a non-array `results` aborts that set
- Prices must be finite, non-negative numbers or `null`
- **Absolute floor**: under 50 price rows → refuse to write
- **Relative floor**: under 60% of the last good day's row count → refuse to
  write and log it as a broken feed rather than a market crash
- An empty *first* page from Riftscribe is a failure, never "no cards"
- Every run is recorded in `ingest_runs` with its status and reason

Nothing is written until the whole payload has validated.

---

## Constraints

Built under Riot's **"Legal Jibber Jabber"** policy. That means, permanently:

- ❌ No LLC or any legal entity behind the project
- ❌ No crowdfunding (no Patreon)
- ❌ No paywall, no paid ad-free tier
- ✅ Ads are permitted
- ✅ The footer disclaimer is required **verbatim** — it lives in
  `src/lib/render.js` as `DISCLAIMER`. Do not reword it.

**Ads**: none at launch (ad networks have traffic minimums this won't clear for a
long time). Fixed-height slot containers are already reserved in the layout
(`.ad-slot` in `styles.css`) so dropping ads in later cannot shift content and
wreck CLS.

**Scope (v1)**: no user accounts, no public submissions, no leaderboards.

---

## Moving to a dedicated domain

1. Attach the domain to the Pages project
2. Set `BASE_PATH` = `/` and `SITE_ORIGIN` = the new origin
3. Delete the `route-worker` deployment

Nothing else changes — every internal link is built from `BASE_PATH`, and no
absolute URL is hardcoded anywhere.

---

## Roadmap

- [x] D1 schema, card + price ingestion on a daily cron
- [x] Events, decks, JSON deck entry
- [x] Event pages: top 8 with build costs and the cost spread
- [ ] Card pages with price history
- [ ] Ranking pages (most expensive overall / by set / signatures, biggest movers)
- [ ] Box EV calculator

When `/cards` and `/box-ev` ship, add them to the `nav` array in
`src/lib/render.js` — they're deliberately not linked while unbuilt.
