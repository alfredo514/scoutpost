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
| `wrangler.toml` | `scoutpost` | the site. Auto-deploys on push to `main`. |
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

## 5. Four bugs that were found the hard way

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
| RQ Vancouver | 2026-05-31 | 8 | Canada's first RQ. Winner's Diana at $204 beat runner-up Rengar at $428 — cheapest deck ($147) came 5th |
| RQ Utrecht | 2026-06-14 | 8 | Both finalists had the two *cheapest* decks ($282 / $236); priciest deck came 8th |
| RQ Hartford | 2026-06-21 | 8 | Winner had the priciest of the top 4 |
| RQ Barcelona | 2026-08-23 | 8 | Winner's Ornn at $146 beat runner-up Kennen at $456 |

1,180 cards, ~1,122 daily prices, 32 decks, 100% price coverage on all decks.

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
card* (so a card missing a day falls back to its own last price rather than
vanishing). `deck_cost_snapshots` is history for future charting only — no page
reads a cost from it.

**Base path**: every internal link is built from `BASE_PATH`. To move to a
dedicated domain: attach it to the Worker, set `BASE_PATH="/"`, update
`SITE_ORIGIN`, delete `route-worker`. Nothing else changes.

---

## 9. What's next

Not yet built (roadmap order from the original brief):

- [ ] **Card pages with price history** — `price_snapshots` has the raw daily
      data; nothing surfaces it yet
- [ ] **Ranking pages** — most expensive overall / by set / signatures, biggest
      movers
- [ ] **Box EV calculator**

When `/cards` and `/box-ev` ship, add them to the `nav` array in
`src/lib/render.js` — they're deliberately unlinked while unbuilt.

Smaller open items:

- `robots.txt` lives at the domain root on the **NAS**, not in this repo. It
  still needs `Sitemap: https://softsauce.co/scoutpost/sitemap.xml` added.
- Submit that sitemap in Google Search Console.
- 58 of 1,180 cards are unpriced — showcase/promo printings with special
  numbering (`SP3/006`) that have no catalogue counterpart. Documented
  limitation, not a bug.
- Decks show `main_cost` / `side_cost` separately; the headline cost includes
  the sideboard. The user was offered maindeck-only and kept the combined total.
