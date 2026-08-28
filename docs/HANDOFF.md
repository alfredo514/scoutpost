# Scoutpost — session handoff

Written 2026-08-27. Read this first in a new session; it records the things
that are expensive to rediscover.

---

## 1. What this is and where it lives

Riftbound TCG data site. Headline feature: **top-8 decklists with a live build
cost** — nobody else in the Riftbound tool space publishes that.

| | |
|---|---|
| Live | https://softsauce.co/scoutpost |
| Worker URL | https://scoutpost.scoutpost.workers.dev |
| Repo | https://github.com/alfredo514/scoutpost (public) |
| Local | `C:\Users\alfre\Downloads\scoutpost` |
| Cloudflare | alfredoalamdar514@gmail.com, account `2d46810c6a919c5c38787a4842f173bd` |
| D1 | `scoutpost`, id `9aa22aa8-22b8-4cf0-ba2c-6dc6e9d4b15c`, region WNAM |

**Three Workers**, deployed separately:

| Config | Worker | Job |
|---|---|---|
| `wrangler.toml` | `scoutpost` | the site. Deploy by hand — see §10. No CI. |
| `ingest/wrangler.toml` | `scoutpost-ingest` | daily cron data pull (21:15 + 02:15 UTC) |
| `route-worker/wrangler.toml` | `scoutpost-route` | serves the site at `softsauce.co/scoutpost*` |

`softsauce.co` itself is the user's portfolio site, served from **nginx on a
Ugreen NAS**. The route worker claims only `/scoutpost*`; everything else still
goes to the NAS. Don't touch the NAS when working on Scoutpost.

**Status: fully operational and unattended.** Cron has run on its own and
written good data (`ingest_runs` shows `status: ok`).

---

## 2. Starting work on a machine for the first time

This doc is in the repo, so it travels with a clone. Three things do **not**
travel, because they are correctly gitignored or machine-local:

```bash
git clone https://github.com/alfredo514/scoutpost.git
cd scoutpost
npm install          # node_modules is gitignored
npx wrangler login   # auth is per-machine
```

**`.env` does not travel.** It holds `INGEST_TOKEN`, the bearer token for
manually triggering ingestion. It is gitignored deliberately. You only need it
to force a run — the cron works server-side regardless — so on a new machine
either copy `.env` across by hand, or rotate it:

```bash
npx wrangler secret put INGEST_TOKEN --config ingest/wrangler.toml
```

(and save the new value into a local `.env`). The `database_id` in the two
wrangler configs *is* committed and needs no setup.

Everything else — schema, code, event JSON, this doc — comes down with the
clone. Nothing needs re-creating in Cloudflare.

---

## 3. Environment quirks that will waste your time

**Windows only — `Node` is not on PATH for the Bash tool.** It's installed at
`C:\Program Files\nodejs` but the session began before the install, so every
Bash call needs the line below. On macOS this does not apply. Check
`node --version` first either way.

```bash
export PATH="/c/Program Files/nodejs:$PATH"
```

**Windows only — Git Bash `/tmp` is not `C:\tmp`.** Node invoked from Bash
can't read a file written to `/tmp`. Use the scratchpad with a Windows-style
path. On macOS `/tmp` behaves normally.

**All platforms — `wrangler d1 execute --command` must be a SINGLE LINE.**
Multi-line SQL gets mangled before it reaches D1 and fails with a misleading
`no such column: c.set_id`. This cost real time. Keep queries on one line.

**All platforms — don't pipe wrangler through `2>/dev/null`.** Errors go to
stderr; suppressing them turns a real failure into a silently empty result.
Output is pretty-printed JSON, so grep for `'"field":'` and `paste` the lines
together, or parse it with node.

**All platforms — `npm run dev` needs `--var BASE_PATH:/`.** In production the
site is served at `softsauce.co/scoutpost` and `route-worker` strips that prefix
before forwarding, so `BASE_PATH` is `/scoutpost` and every link is built with
it. Nothing strips the prefix locally, so `wrangler dev` on its own serves a
page whose own stylesheet, icons and links all 404 — it looks like the CSS is
broken when it is only mis-addressed. The `dev` script now passes
`--var BASE_PATH:/` for that reason. It affects local preview only; the
deployed value comes from `wrangler.toml`, and the sitemap rendered locally
will show origin-relative URLs as a result.

**All platforms — interactive OAuth can't be backgrounded.** `wrangler login`
in a background task times out before the user can click. Run it in the
foreground with a long timeout, or have the user run it themselves.

**Two machines, one database.** D1 is remote, so both machines write to the
same live data. There is no local copy to diverge — but it does mean an import
run from either machine takes effect immediately for everyone. Pull before you
start, push when you finish.

---

## 4. Verified API facts — do not re-derive

**TCGCSV** (`tcgcsv.com`) — unofficial one-person mirror of TCGplayer prices, no
uptime guarantee. Updates ~20:00 UTC.

- Riftbound is **`categoryId 89`**
- `/tcgplayer/89/groups` → `{success, errors, results:[{groupId, abbreviation, ...}]}`
- `/tcgplayer/89/{groupId}/products` and `/prices`
- Sealed product has `extendedData: []`; singles carry `Number` (`021/166`) and `Rarity`
- Prices carry `subTypeName`: `Normal` | `Foil`

**Riftscribe** (`riftscribe.gg/api/cards`) — card catalogue, free, no key.

- Returns a **bare JSON array**, no envelope, no total count
- Paginate `?limit=200&offset=N`. **`limit=500` silently returns an empty
  array** — never raise the page size, and never treat an empty first page as
  "no cards"
- Every card carries a multi-kilobyte `image_blur_data_url`. Never store it.

**Join key**: TCGCSV group `abbreviation` (`VEN`) ↔ Riftscribe `set_id`, then
collector number + variant (`021a/166` → number 21, variant `a`).

---

## 5. Five bugs that were found the hard way

These are all fixed. They are recorded because each one produced *plausible
wrong numbers* rather than an error, which is the failure mode this project
most needs to avoid.

**Rares and epics are sold FOIL-ONLY.** TCGplayer gives them a `Foil` price row
and no `Normal` row. The subtype fallback read
`subtypes[wanted] ?? subtypes.Normal`, so for a normal-finish card it fell back
to the very thing that was missing and gave up. Result: **97% of rares and 96%
of epics had no price** — exactly the cards that dominate a deck's cost.
Coverage went 633 → 1,122 rows when fixed.

**A collector number above the printed set size is a secret rare.** Not
slightly pricier — 100-1000x pricier. Baron Nashor is **$18.92** as
`UNL-147/219` but **$1,634.89** as `UNL-238/219`. Any name-based resolution must
exclude these.

**A card can be in both maindeck and sideboard.** `deck_cards` was keyed
`(deck_id, card_id)`, which silently merged those rows and lost a card. The key
is now `(deck_id, card_id, section)` where section is `main` | `sideboard`.

**Signature printings were silently unpriced.** TCGplayer marks them with an
asterisk in the collector number (`227x/221`, x being an asterisk) and names the
product "… (Signature)". Riftscribe records the same card as `variant: 'star'`.
`parseCollectorNumber` accepted only digits plus an optional letter, so every
Signature landed in the unparseable bucket and **36 cards carried no price at
all** — the most valuable printings in the game, averaging **$952** against
**$13.55** for everything else, top end **$3,474**. They read as $0 for weeks.

The parser now maps the asterisk to `star`. Three things to keep in mind:

- A Signature's collector number is **above** the printed set size. That is
  normal for these and must not be "corrected".
- An asterisk followed by a slash **ends a block comment**, which broke the file
  the first time this was documented.
- The first post-fix run still reported the old numbers — the deploy had not
  propagated. Re-run before concluding a price fix failed.

**Riot article dates are PUBLICATION dates, not event dates.** This has caught
every event so far. Barcelona's article said 8/26 (a Wednesday); the event was
Sat 8/22–Sun 8/23. Vancouver's said 6/4; the event was Fri 5/29–Sun 5/31.
Always corroborate with Eventbrite/Liquipedia and record the day the top 8 was
decided.

---

## 6. Adding an event

A data operation. **No template is ever edited.**

```bash
cp data/events/_TEMPLATE.json data/events/<slug>.json   # fill it in
node scripts/import-decks.mjs
npx wrangler d1 execute scoutpost --remote --file=build/import.sql -y
npx wrangler deploy      # only if site code changed
```

Files starting with `_` are skipped by the importer — useful for staging an
event whose date isn't confirmed yet.

Deck JSON: `cards[]` is the maindeck (legend + champion + main + battlefields +
runes all go here), `sideboard[]` is the sideboard. Entries take `code`
(`OGN-025`, unambiguous, preferred) or `name`.

**Name resolution handles three catalogue quirks:** legends are stored without
the champion prefix (`Kennen, Heart of the Tempest` → `Heart of the Tempest`),
starter reprints carry a ` - Starter` suffix, and most cards have several
printings. Ambiguity resolves to the base printing (no letter variant, not
showcase/signature, collector number within set size) and **reports each pick**.
If there's no single base printing it fails loudly.

### Entering lists from a Riot article

`WebFetch` on a `playriftbound.com/news/.../xxx-top-decks/` URL extracts the
full top 8 reliably. **It is an automated read, so verify before trusting:**

- Every deck should total **39 maindeck + 12 runes + 3 battlefields**, plus the
  legend and champion, which the article lists above the maindeck rather than
  in it — so `cards[]` sums to **56**. All 32 decks entered so far hit this
  exactly; a deck that doesn't is a red flag.
- **Don't trust a `WebFetch` summary on a contested line.** Asked twice about
  BaoBaoaz's duplicate `Irelia, Fervent`, it answered both ways. Open the page
  with the browser tool and read the raw text when a count looks off.
- Every legend should resolve to a card with `card_type = 'Legend'`.
- Check unpriced counts are 0.
- Corroborate the winner/runner-up against independent coverage.

Attendance figures **disagree between sources** every time (Riot's day-one
number vs Liquipedia's entrant count). Use Riot's, note the discrepancy in the
event file's `_note`.

---

## 7. Current data

| Event | Date | Decks | Notable |
|---|---|---|---|
| RQ Las Vegas | 2026-03-01 | 8 | |
| RQ Lille | 2026-04-19 | 8 | The event that surfaced `Yi, Honed` — see §16 |
| RQ Atlanta | 2026-04-26 | 8 | |
| RQ Sydney | 2026-05-17 | 8 | Its article prints battlefields without quantities; every other one prints `1 Foo` |
| RQ Vancouver | 2026-05-31 | 8 | Canada's first RQ. Winner's Diana cost roughly half the runner-up's Rengar; cheapest deck came 5th |
| RQ Utrecht | 2026-06-14 | 8 | Both finalists brought the two *cheapest* decks; priciest deck came 8th |
| RQ Hartford | 2026-06-21 | 8 | Winner had the priciest of the top 4 — the only event so far where that happened |
| RQ Barcelona | 2026-08-23 | 8 | Winner's Ornn beat a runner-up Kennen costing ~3× as much |

1,180 cards, ~1,158 daily prices, **8 events, 64 decks**, 100% price coverage on
all decks. 22 cards are unpriced — promo printings with no TCGplayer
counterpart, see §9.

**Don't write dollar figures into this doc.** Prices move every day — the whole
point of the site — so a number recorded here is wrong by tomorrow and reads
like a bug to whoever finds the mismatch. Describe the *relationship* (which
deck was dearer, by roughly what factor) and let the site carry the figures.
Costs shifted 1–2% across every deck during a single session on 2026-08-27
purely from one cron run.

**A champion can also appear as a maindeck line.** Vancouver's 8th place
(BaoBaoaz) lists `Irelia, Fervent` as its champion *and* again inside the main
deck — 2 copies total, which is legal. The article's "Main Deck" section is
always 39 cards and excludes the legend and champion, so the expected `cards[]`
total is 39 + 1 legend + 1 champion + 3 battlefields + 12 runes = **56**. Check
that, not 39, when validating a new event. The importer sums duplicate entries
within a section, so either spelling works.

An earlier **NRG Milwaukee** event was entered by hand from user-pasted lists,
then deleted at the user's request. Its JSON is recoverable from git history if
ever wanted — it's the only event whose prices were cross-checked against
independently published figures (agreed to 0.3%).

---

## 8. Constraints — permanent

Riot **"Legal Jibber Jabber"** policy:

- ❌ No LLC or legal entity, no crowdfunding, no paywall or paid ad-free tier
- ✅ Ads permitted, but not at launch — traffic minimums. Fixed-height
  `.ad-slot` containers are already reserved so adding them can't wreck CLS.
- ✅ Footer disclaimer required **verbatim** — it's `DISCLAIMER` in
  `src/lib/render.js`. Do not reword.

v1 scope: no user accounts, no public submissions, no leaderboards.

**Build cost is computed at read time, never stored.** Most recent price *per
card*, so a card missing a day falls back to its own last price rather than
vanishing — bounded to a 30-day window, see §10. `deck_cost_snapshots` is
history for future charting only; no page reads a cost from it.

**Base path**: every internal link is built from `BASE_PATH`. To move to a
dedicated domain: attach it to the Worker, set `BASE_PATH="/"`, update
`SITE_ORIGIN`, delete `route-worker`. Nothing else changes.

---

## 9. What's next

Not yet built (roadmap order from the original brief):

- [x] **/cards browser** — every card, filterable by type and colour, priced
      and sorted by cost. Filters are query-string links, not scripts
- [x] **Per-card pages** — `/cards/<id>`, art beside the card's text, linked
      from every tile. Shipped 2026-08-27; text comes from TCGplayer, see §17
- [ ] **Price history charts** — `price_snapshots` holds the raw daily data and
      nothing charts it yet. This is the one remaining piece of the card pages,
      and it is **gated on history depth, not on code**: three days of snapshots
      as of 2026-08-28. Leave it until there are weeks
- [x] **Ranking pages** — most valuable cards, biggest movers, and where the
      value sits by set. Shipped 2026-08-28; see §18 for the two decisions that
      make its numbers mean anything
- [ ] **Box EV calculator**

Box EV is **already in the nav**, routed, and styled. `src/lib/sections.js`
is the single registry every consumer reads — header nav, footer, router,
sitemap. A planned section routes to `src/routes/planned.js`, which renders a
real page saying what's coming and linking to what works; it carries
`noindex, follow` and is excluded from the sitemap.

**To ship one, two lines:**

1. `status: 'planned'` → `'live'` in `sections.js`
2. replace its generated entry in the `ROUTES` array in `src/index.js` with the
   real handler

Nav, footer, styling, sitemap and the noindex all follow automatically. Do not
add links by hand anywhere — nothing reads a hardcoded nav list any more.

Smaller open items:

- `robots.txt` lives at the domain root on the **NAS**, not in this repo. It
  still needs `Sitemap: https://softsauce.co/scoutpost/sitemap.xml` added.
- Submit that sitemap in Google Search Console.
- 22 of 1,180 cards are unpriced — promo printings with special numbering
  (`SP3/006`, `R01`, `T01`) that have no TCGplayer counterpart. Documented
  limitation, not a bug. This was 58 until the Signature fix; see §5.
- Decks show `main_cost` / `side_cost` separately; the headline cost includes
  the sideboard. The user was offered maindeck-only and kept the combined total.

---

## 10. Deploying, and the data cadence

### Deploying is manual — there is no CI

Pushing to `main` changes nothing on the live site. Push and deploy are two
separate steps, in that order.

```bash
npx wrangler deploy                                     # the site
npx wrangler deploy --config ingest/wrangler.toml       # cron ingest
npx wrangler deploy --config route-worker/wrangler.toml # the /scoutpost route
```

**Verify against the live URL, never against wrangler's output.** It prints
"No updated asset files to upload" even on runs where `public/` demonstrably
changed, so that line is not evidence in either direction.

```bash
curl -s https://softsauce.co/scoutpost/styles.css | grep -o '\-\-accent: *#[0-9a-f]*'
```

Both this doc and the README once claimed the site auto-deployed on push. It
never did — `wrangler deployments list` shows every deployment as
`Source: Unknown`, i.e. hand-run. A GitHub Actions workflow was added and
removed on 2026-08-27: the user prefers deploying by hand, and a workflow that
red-Xes on every push for want of a `CLOUDFLARE_API_TOKEN` is worse than none.
Recover it with `git log --diff-filter=D -- .github` if that ever changes; it
needs only that one secret.

### What actually requires a deploy

| Change | Deploy? |
|---|---|
| Anything in `src/` or `public/` | **Yes** |
| A new event | No — the importer writes to D1 |
| New prices | No — the cron writes to D1 |

### Prices

The ingest Worker's cron runs **21:15 and 02:15 UTC** daily. TCGCSV publishes
around 20:00 UTC, so 21:15 is the real pull and 02:15 is the retry if the source
was late or down.

Stored: **one row per card per day**, `market_price` and `low_price`, keyed
`(card_id, date)` with `ON CONFLICT DO UPDATE` — so two crons a day still leave
exactly one row per card per day. Both figures are TCGplayer's own, passed
through unmodified; **nothing is averaged locally**. Only the finish matching
the card is stored, so there is no separate foil price history.

Costs are computed at read time and reach the site within the edge cache TTL
(`s-maxage=300`, ≤5 minutes of the cron finishing).

**`PRICE_WINDOW_DAYS` in `src/lib/queries.js` is load-bearing.** The per-card
"latest price" lookup only scans the last 30 days. Without that bound it scans
every price row ever written on every page view — ~1,100 rows/day accumulating
to ~410k/year, for identical output. `d1 info` already showed 682k rows read in
24h at near-zero traffic against a 5M/day free-tier limit, and that number grows
with history depth whether or not traffic does. Do not remove the `WHERE`
clause. Widening the window is safe; deleting it is not.

---

## 11. Card images

Card art is **mirrored into R2** and served by the site Worker. Pages never link
to `cdn.riftscribe.gg`.

| Rendition | Size | Dimensions | Column | Mirrored? |
|---|---|---|---|---|
| small webp | ~26 KB | 300×418 | `image_thumb_url` | yes — list rows |
| medium webp | ~71 KB | 600×837 | *(not stored)* | no |
| large webp | ~100 KB | 744×1039 | `image_large_url` | yes — previews |
| original png | **778 KB** | — | `image_url` | **never** |

Averages from a 25-card sample, 2026-08-27. **Do not mirror the originals**:
8× heavier than `large` for no useful gain, ~918 MB against ~145 MB, and the
only rendition without a long cache (`max-age=14400` vs `immutable, 1yr`).

### How it works

- `ingest/src/images.js` — the mirror. `R2 key = <size>/<filename>`, where the
  filename is Riftscribe's content hash.
- `src/routes/card-image.js` — serves `/card-image/<size>/<file>` from R2 with a
  one-year immutable cache. Safe because the key's bytes can never change.
- `src/lib/images.js` — `cardImageSrc(env, card, size)` builds a page's `src`.
  Returns null when unavailable, so callers render a placeholder.
- `image_mirrored` on `cards` holds the basename already in R2. Changed art
  means a changed hash means a changed name, so it re-mirrors automatically.

Run it manually; repeat until `remaining` is 0:

```bash
curl -X POST "https://scoutpost-ingest.scoutpost.workers.dev/run?job=images&limit=20" \
  -H "Authorization: Bearer $INGEST_TOKEN"
```

The nightly `all` run mirrors one batch only when something is pending, so it
catches up over several nights after a new set. That is deliberate: the
catalogue and price jobs must never lose subrequest budget to images.

### Verifying images in the browser pane

`loading="lazy"` images sit at `complete: false` forever when the Browser pane
is not displayed — no paint means no intersection observation, so the fetch
never fires. This looks exactly like a broken image and cost time twice. Tell
the two apart by checking `naturalWidth === 0 && complete` (a real failure) vs
`!complete` (never requested), or load the same URL through `new Image()`,
which ignores lazy loading entirely.

### The subrequest cap is the binding constraint — measured, not assumed

Each card costs **two `fetch()` calls**, and Workers allow **50 subrequests per
invocation** on this plan. R2 binding calls (`get`/`put`) do *not* count; the
CDN fetches do.

A run at `limit=50` mirrored exactly 25 cards and failed the other 25 on
subrequest exhaustion. `MAX_BATCH` is therefore 25 and `DEFAULT_BATCH` is 20.
**A full backfill can never be one invocation** — loop until `remaining` is 0.
Raise the cap only on a Workers plan with a higher limit, and re-measure first.

Failures are per-card and non-fatal: the card stays unmirrored and retries next
run. That is why the half-failed probe above cost nothing.

### Costs

~145 MB for the full catalogue against R2's 10 GB free tier — **1.4%**. Class A
writes are one-time (~2,360) then near zero, since only new or changed art is
fetched. Class B reads are shielded by the immutable cache, so the edge answers
most requests without touching R2. A `$1` budget alert is configured; projected
spend is $0.

Every mirror run records objects and bytes into `ingest_runs`, so a runaway
shows up as an anomalous row the next morning rather than only on a bill:

```bash
npx wrangler d1 execute scoutpost --remote --command "SELECT started_at, rows_written, message FROM ingest_runs WHERE job='images' ORDER BY id DESC LIMIT 5"
```

### On the page

Decklists group by card type, **Legend first**. The Legend is the deck.s
leader — it decides what the rest of the list may contain, so a player
identifies a deck by it before anything else. Sorting the whole list by price,
which this page did until 2026-08-27, buried the Legend wherever its market
price happened to fall. Cost order is kept *within* each group, so expensive
cards still surface where they matter. Order is `TYPE_ORDER` in
`src/routes/deck-detail.js`: Legend, Units, Spells, Gear, Battlefields, Runes,
then the sideboard.

The Legend also gets its own panel beside the list (`.legend-panel`), sticky so
it stays in view while a 31-row list scrolls. Its art is the one image on the
page that is **not** lazy-loaded: it is the focal point, and deferring it delays
the thing the reader came for.

Decklist rows carry a 40x56 thumbnail, and hovering a row (or tab-focusing it)
shows the large rendition pinned to the right of the viewport, big enough to
read the card text.

**Both were built with no JavaScript, and the site still ships none.** The
enlargement is a `background-image` on an element that stays `display: none`
until `:hover`/`:focus-visible`, and browsers do not fetch a background for an
unrendered element. Measured on the live page: a 31-row decklist loads 31
thumbnails and **zero** enlargements, and one hover fetches **exactly one**.
Do not "improve" this with a JS preloader — it would undo the whole property.

Three details that are load-bearing:

- `.card-zoom` is `position: fixed`, not absolute, because `.table-wrap` sets
  `overflow: hidden` to clip its rounded corners and would crop anything
  escaping the table.
- `pointer-events: none`, so the preview can never intercept a click.
- The hover rule sits behind `(hover: hover)` so a touch device cannot latch a
  preview open on tap; the reveal needs a viewport of at least 900px, since
  narrower screens have nowhere to put it.

---

## 12. Icons and the social preview

Source artwork: `Gemini_Generated_Image_67rmz667rmz667rm.jpg` in the user's
Downloads (not in the repo — it is the original, keep a copy somewhere safe).

```bash
node scripts/make-icons.mjs <source-image>
```

Regenerates all three into `public/`, then `npx wrangler deploy`:

| File | Size | Used for |
|---|---|---|
| `apple-touch-icon.png` | 180×180 | iOS home screen |
| `icon-512.png` | 512×512 | Android / PWA / high-res |
| `og-image.png` | 1200×630 | link previews in Slack, Discord, social |

Plus `favicon-32/48/96.png` for the browser tab. A hand-drawn `favicon.svg`
served this role until 2026-08-27 and was removed once the real artwork
existed — rendering the artwork at 16/32/48 magnified side by side showed 32
is clearly legible (16 is a smudge), and 32 is what modern browsers request.
It is in git history if a vector mark is ever wanted again.

Two things in that script are worth knowing before editing it:

**The crop is found by locating the neon glow, not by background subtraction.**
The obvious approach fails on this artwork: its field carries a vignette,
brighter left (G≈49) than right (G≈28), and that spread is *larger* than the
difference between the field and the icon's own dark panel. Any threshold loose
enough to catch the panel swallows the whole vignette — the first attempt
returned the full 896px height. The saturated green has no such ambiguity, so
the script finds the glow and pads outward by 12%, which lands the left edge at
x=239 against a panel edge measured by hand at ~240.

**The OG text is not measured.** There is no font metrics available, so line
lengths are eyeballed with slack left over; an overflowing line is silently
clipped, which happened on the first pass. **Look at `public/og-image.png`
after changing any of that copy.**

PNGs are written with a 256-colour palette. The artwork is flat vector colour,
so this is visually free and saves ~78% — `icon-512` goes 478 KB → 107 KB. If
the source ever becomes photographic, check for banding by eye.

---

## 13. The visual language

**A scouting instrument, not a dashboard.** The site reports on a competitive
format and prices it, so the design language is measurement.

| Role | Face | Used for |
|---|---|---|
| Display | Chakra Petch 700 | h1, section headings, the wordmark |
| Body | IBM Plex Sans | everything else |
| **Numbers** | IBM Plex Mono, tabular | **every price, code, count and label** |

The mono is the load-bearing decision. Prices are what this site is for, and
setting them in tabular mono makes columns align digit-for-digit and read as
measurements. It is the single change that stopped the site looking generic —
before this, every `font-family` in the stylesheet was the system stack.

Other deliberate choices:

- **`--radius: 3px`**, down from 10px. Soft corners read as a template; near
  square reads as a panel on a device. `--radius-lg` exists for the few places
  something should feel like a card.
- **`--snap: 90ms cubic-bezier(.2,.8,.2,1)`** on every transition. Snappy means
  short and decisive, not absent.
- **Grain** — one inline SVG turbulence on `body::after` at 4% opacity. No
  request, no image decode, `pointer-events: none`.
- **A lime tick** before each section heading, and an accent edge on the
  headline cost card.

Three webfonts are loaded with `display=swap` and real fallback stacks. This
**reverses** an earlier decision recorded in the stylesheet header ("no
webfonts, system stack renders instantly"). That was a defensible performance
call, but the system stack was precisely what made the site look like every
other dark dashboard. If page weight ever matters more than identity, dropping
the `<link>` in `render.js` degrades cleanly to the fallback stacks.

**Still no JavaScript anywhere**, card enlargements included. Keep it that way.

---

## 14. Domain (colour) icons

Riftscribe publishes **no icon assets** — a card carries only `faction: "fury"`
and `domains: ["Fury"]` as text. But every domain has a **Rune card whose art is
its symbol**: a large light glyph, centred, on the domain's own colour. So the
icons are cut from the real cards:

```bash
node scripts/make-domain-icons.mjs      # writes public/domain-<faction>.png
```

This matters more than convenience. Players already know these symbols, and an
invented glyph would be worse than no glyph at all — it would look like an
official mark and mean nothing.

The Rune card ids are hardcoded in that script. **Re-run it if the art is ever
reprinted**, and check the output by eye.

Detection gotcha: a Riftbound card has a light frame around its whole edge and a
near-white title band under the art, both as bright as the glyph. Searching the
full card for near-white pixels returns the full card, which is what the first
attempt did. The search window is inset past the frame and stops above the title
band; the threshold alone will not save you.

**Colourless has no Rune card and therefore no icon.** Its chip is text-only,
and `domainIcon()` returns null for it rather than linking a missing file.

Icons appear on the `/cards` colour filter chips and on every card tile.

---

## 15. Event filtering by set

`/events` filters by the set that was legal when an event was played. **The era
is derived from dates, never stored** — `EVENT_ERA` in `queries.js` picks the
most recent set released on or before the event date, so a new set needs no
migration and no backfill. It appears as a pill the moment the catalogue
ingests it.

Sets sharing a release date are one era, labelled by whichever has more cards.
That is what keeps *Origins: Proving Grounds* — a 24-card starter released the
same day as Origins — from showing up as a format of its own, without naming it
in code.

**The default view is the newest set only.** `/events` with no parameter shows
Vendetta; `?set=all` is an explicit choice. A result is only meaningful against
the format it was played in, which is the argument for it — but be aware of the
cost, which as of 2026-08-28 is that **7 of 8 events are hidden by
default**. The user was asked once more when `/rankings` shipped and confirmed
the default stands. A note under the table says so and links to the full list. If the
event count grows and that tradeoff stops paying, `DEFAULT_ERA` in
`src/routes/events-list.js` is the single switch.

The filter sits **above** `adSlot('leaderboard')` so the reserved 90px
leaderboard height is never displaced and nothing below it shifts when the
filter changes.

---

## 16. Validating an event before import

```bash
node scripts/check-event.mjs data/events/<slug>.json
```

Checks the arithmetic every Riftbound tournament deck must satisfy:

**1 legend + 1 champion + 39 maindeck + 3 battlefields + 12 runes = 56**

Card types come from the live Riftscribe catalogue, **not a hardcoded list of
battlefield names** — the first version kept such a list and reported all eight
decks of a new event as broken purely because that event used battlefields the
list had never seen. It also mirrors the importer's name quirks (champion prefix
dropped, ` - Starter` suffix), or it reports false failures for names that
import perfectly.

Run it before `import-decks.mjs`. The importer validates that names *resolve*;
this validates that the *shape* is right, which is what catches a line dropped
or doubled while transcribing an article.

### Article structure varies — do not rely on one marker

Across four articles the top-8 section was headed three different ways:
`Top 8`, `Top 8 Decks`, and `TOP EIGHT`. One article had no section header at
all. Locate the block by the run of `Overall Ranking: #8 … #1` at the end of the
page instead. Sydney's article also prints battlefields **without quantities**
where every other article prints `1 Foo`.

### Catalogue naming is inconsistent for the same champion

`Master Yi, Tempered` and `Master Yi, Unstoppable` exist under those names, but
the Proving Grounds printing of the same champion is catalogued as **`Yi,
Honed`** — no "Master". Lille's article says "Master Yi, Honed", which resolves
to nothing. The importer caught it and refused to write, which is the system
working; the fix is to use the catalogue's name.

---

## 17. Card text comes from TCGplayer, not the card catalogue

**Riftscribe publishes no rules or flavor text.** Its card record carries only
`id, public_code, name, set_id, collector_number, variant, rarity, faction,
domains, type, orientation, stats, image, image_thumb, image_blur_data_url,
is_banned`. Nothing else. Do not go looking for a text field there.

**TCGplayer has all of it**, in `extendedData` on each product:

```
Rarity, Number, Description, Energy Cost, Power Cost,
Might, Card Type, Tag, Domain, Flavor Text
```

The price job already walks every product daily, so `writeCardText` in
`ingest/src/prices.js` picks the text up for free on the same pass. Nothing
extra is fetched. Coverage on 2026-08-28: **96% rules text, 65% flavor**, over
1,158 cards.

This was nearly missed. The project read only `Number` and `Rarity` from
`extendedData` for months, and the plan before checking was to transcribe 1,180
cards by hand. **Check what a feed already gives you before building a pipeline
to reproduce it.**

### Three stats, not two

`Energy Cost`, `Power Cost` and `Might` are distinct. On Fizz, Trickster they
are 3 / 1 / 3. The large numeral top-right of a card is **Might**, not Power —
Power Cost is the small domain pip under the energy circle. Reading the art
alone gets this wrong, and it was gotten wrong here before the structured data
settled it.

### The `<em>` whitelist

`Description` wraps reminder text in `<em>`, and `Flavor Text` is usually
wrapped entirely. `cardMarkup()` in `src/routes/card-detail.js` escapes
everything and then allows exactly that one tag back. Do not widen it, and do
not skip the escape and pass the feed's HTML through.

### Text is upserted, prices are appended

`card_text` is current state, one row per card. `price_snapshots` is history,
one row per card per day. Do not confuse the two.

---

## 18. The rankings page, and two decisions that carry it

`/rankings` exists to do what `/cards` structurally cannot: report **aggregates**
(catalogue value, median card, value by set) and **movement**, which needs two
dates and therefore needs the price history. Everything else on the page links
back into `/cards` with the equivalent filter rather than growing a second
paginated browser.

Both boards read `price_snapshots`. Two rules keep them honest, and both were
measured rather than guessed.

### A mover must be priced on BOTH endpoint dates

This is the load-bearing line in `topMovers`. The Signature printings went from
unpriced to an average of ~$950 the day `parseCollectorNumber` learned to accept
an asterisk (§5). A "latest versus earliest available" comparison reports that
as the largest rally in the game's history — when nothing moved at all, only our
reading of it did. Comparing two **fixed dates** and dropping any card missing
from either means a data fix can never masquerade as a market event.

For the same reason the movers query deliberately does **not** reuse
`LATEST_PRICES`. That helper falls back to a card's own last known price, which
is exactly right for a deck total and exactly wrong here: a stale price
unchanged for a week would read as a card that held its value.

### Cards under $2 are excluded from the movers board

`MOVER_FLOOR` in `queries.js`. TCGplayer quotes bulk singles in whole cents, so
a common going $0.10 → $0.17 is one cent of rounding arriving as **+70%**.
Measured over 26–28 Aug: the unfiltered top ten risers were **all sub-$1 cards**,
the largest a 7-cent move. The same query above $2 returned Irelia, Rengar and
Ornn — cards people are actually buying. Without the floor this board is a
rounding-error leaderboard. Raising the floor is safe; removing it is not.

### The window is what exists, not what was asked for

`MOVER_WINDOW_DAYS` is 7, but `moverWindow()` returns the widest span that
actually exists inside it and the page **prints the real dates**. With three days
of history it says "Aug 26 → Aug 28", not "this week". When the history is one
day deep it returns `null` and the board says so rather than rendering zeros.
This is the section of the site that most needs history depth: it gets better on
its own every night, with no code change.

### Signatures own the top of the board, correctly

14 of the top 15 most valuable cards are Signature printings, and the 15th is
Baron Nashor's secret rare. That is the truth about this market, so the board is
not filtered — but a note under it points at the printing filter, because
"priciest card I might actually open" is the other question a reader has.

Note that a Signature's collector number is **above** the printed set size, and
so is a secret rare's; `printingOf()` in `rankings.js` reads `variant`, never the
number, which is what keeps Baron Nashor classified as Standard.

### The "Value by set" board ignores the page filters

Deliberately. It is a comparison *between* sets, so filtering it to one would
leave nothing to compare. The copy under it says so.

### It is the most expensive page on the site to serve — measured

Rows read per uncached view, 2026-08-28, with three days of price history:

| Query | Rows read |
|---|---|
| `marketStats` (two queries) | ~36,600 |
| `setValueTable` | 23,025 |
| `topCards` | ~18,300 |
| `topMovers` ×2 | ~3,800 |
| facets | small |

**Roughly 80k rows per uncached view.** Nearly all of it is the `LATEST_PRICES`
join, which costs ~18,300 on its own for 1,180 cards and grows with history
depth up to the `PRICE_WINDOW_DAYS` bound (§10) — so this is the site's existing
floor paid four times, not something the boards do wrong. `s-maxage=300` at the
edge is what makes it affordable; the free tier allows 5M rows/day.

Two things already tried and rejected, so nobody repeats them:

- **Folding `marketStats` into one query** with the aggregates as scalar
  subqueries over a shared CTE. SQLite re-evaluates the CTE per subquery:
  **55,284 rows against ~36,600** for the two-query form. Worse, not better.
- **Correlated subqueries for the priciest card per set**, which is how
  `setValueTable` was first written. The window-function form replaced it.

If this page ever needs to get cheaper, the lever is a materialised
`card_latest_price` table written by the cron, not query rewriting. That is a
real change with a real cost — a second source of truth for prices — so do not
reach for it before the numbers say it is needed.

### One shared card cell

`cardMark()` moved from `deck-detail.js` into `lib/images.js` when the rankings
tables needed the same row: thumbnail, name, printed code, CSS-only hover
enlargement. It takes an optional `href` — rankings link the name to the card
page, decklists do not, because there the whole row is already about that card.
Output for a decklist is unchanged, byte for byte.

---

## 19. The card browser's two disclosures

`/cards` had seven rows of filters plus a sort row above the grid. Three
changes on 2026-08-28 gave the grid back about 155px above the fold, and none of
them added a line of JavaScript.

### Both disclosures are `<details>`, and their open state is decided server-side

Advanced filters (rarity, printing, price) and the sort menu are native
`<details>` elements. That is the only disclosure available on a site with no
script, and it is genuinely enough.

The catch is that a `<details>` cannot remember anything across a navigation,
and on this site **every filter click is a navigation**. Left alone, opening
Advanced filters and clicking a rarity would collapse the panel on the very
request that applied the filter — hiding the control the reader just used, and
looking exactly like a bug. So the server writes the `open` attribute whenever
one of `ADVANCED_KEYS` is set, and the summary carries an "N on" badge. Check
that logic before changing which filters live inside.

### Never put `display: flex` on a `<summary>`

Layout goes on an inner span (`.filters-more-trigger`, `.sortmenu-trigger`) and
the `<summary>` stays `display: block; width: max-content`. Setting a flex or
inline-flex display directly on a `<summary>` has broken the toggle in shipped
browsers, and a disclosure that will not open is not a thing to be clever
about. `width: max-content` keeps the click target matched to what is drawn,
since a block summary would otherwise be clickable across the full row.

Both were written this way from the start here — but note that **neither could
be click-tested from the agent browser**: with the Browser pane undisplayed,
synthetic clicks produce no default action at all, so even a plain nav link does
not navigate. Verify a disclosure by setting `.open` from the console and
checking `checkVisibility()`, or open the page by hand. `getBoundingClientRect`
is the wrong probe: a closed `<details>` still reports a box for its contents.

### The accent means "you narrowed this"

`.chip.is-on` fills with lime. That was also being applied to the six "All"
chips, which are on before anyone has touched the page — so a fresh `/cards`
lit six chips in the brightest colour in the palette to say that no filter was
applied, leaving nothing for an actual selection to say. The default state is
now `.chip.is-default`, a quiet outline.

`filterButton()` **detects** the default rather than taking a flag: an "All"
chip is the one whose change clears its key, so no call site can forget it.

### Sort moved out of the filters

It reorders what you have rather than changing what you have, so it sits
opposite the result count as a single control instead of a row of eight chips.
The panel is a list of real links, so every sort order is still a shareable URL
and the default sort still renders as a bare `/cards`.
