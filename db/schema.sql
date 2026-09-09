-- Scoutpost — D1 schema
-- Apply:  wrangler d1 execute scoutpost --remote --file=db/schema.sql
--
-- Design notes:
--  * price_snapshots is APPEND-ONLY, one row per card per day. Raw daily values
--    only — never averages. Weekly/monthly views are computed from it later, so
--    a different window can always be derived.
--  * events carries location columns from day one. Every early row will be a
--    national event, but having the columns now makes a regional layer a data
--    problem instead of a migration.
--  * Deck cost is never the SOURCE OF TRUTH — deck_cards and price_snapshots
--    are, and everything else is rebuildable from them. It IS stored, on the
--    deck row, written nightly by the price job immediately after the prices it
--    depends on (§26). The header here used to say the opposite; the rule that
--    reversed is where it is computed, not what is authoritative.
--    deck_cost_snapshots is a historical record for charting.

PRAGMA foreign_keys = ON;

-- ─────────────────────────── Catalog ───────────────────────────

CREATE TABLE IF NOT EXISTS sets (
  id            TEXT PRIMARY KEY,          -- Riftscribe set_id, e.g. 'OGN'
  code          TEXT NOT NULL,             -- printed set code (same as id today)
  name          TEXT NOT NULL,             -- 'Origins', 'Vendetta', ...
  release_date  TEXT,                      -- ISO date (YYYY-MM-DD)
  tcgcsv_group_id INTEGER,                 -- TCGplayer groupId, for price joins
  -- How many cards are in this set. Denormalised from `cards` by the catalog
  -- job for one reason: EVENT_ERA needs it as a TIEBREAK, and computing it with
  -- a correlated COUNT(*) meant counting every card in every candidate set once
  -- per row — about 1,419 rows read per event row, ~90,000 for a single
  -- /decks view. Same lesson as §26: a value that describes a row belongs on
  -- the row, not in a subquery the reader pays for. Derived; rebuildable with
  --   UPDATE sets SET card_count = (SELECT COUNT(*) FROM cards WHERE set_id = sets.id);
  card_count    INTEGER NOT NULL DEFAULT 0,
  -- Price-derived, refreshed by the price job for the "Value by set" board on
  -- /rankings. That board used a partitioned window function over every card,
  -- 7,127 rows read per view, for figures that move once a night.
  priced_count  INTEGER NOT NULL DEFAULT 0,
  total_value   REAL,
  top_card_id   TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id                TEXT PRIMARY KEY,      -- Riftscribe card id, e.g. 'ogn-001-298'
  name              TEXT NOT NULL,
  set_id            TEXT NOT NULL REFERENCES sets(id),
  collector_number  INTEGER NOT NULL,
  variant           TEXT NOT NULL DEFAULT '',  -- '', 'a', 'b' … distinguishes alt printings
  rarity            TEXT,
  finish            TEXT NOT NULL DEFAULT 'normal',  -- 'normal' | 'foil'
  card_type         TEXT,
  faction           TEXT,
  public_code       TEXT,                  -- 'OGN-001/298' as printed
  image_url         TEXT,                  -- full-size art
  image_thumb_url   TEXT,                  -- small webp (~25KB) for list rows
  image_large_url   TEXT,                  -- large webp (~97KB) for previews
  image_mirrored    TEXT,                  -- basename mirrored to R2; NULL = not yet.
                                           -- Riftscribe content-hashes filenames, so a
                                           -- changed name means changed art: re-mirror.
                                           -- image_url is the 778KB original PNG:
                                           -- canonical source, never served
  -- Denormalised from card_latest_price by the nightly price job. Pages read
  -- these columns and never a price join — see §26.
  market_price      REAL,
  low_price         REAL,
  price_date        TEXT,
  -- Set nightly from the card's name. Queries filter on THIS, never on
  -- name LIKE '%(Metal)%' — a leading wildcard can never use an index, so the
  -- name test was a guaranteed full scan on every /rankings query. See
  -- shared/card-sql.js for the definition. Measured: 1,419 rows -> 68.
  is_metal          INTEGER NOT NULL DEFAULT 0,
  -- Set when this card SHOWS another card's art. Metal prize cards have no
  -- photograph on TCGplayer (52 of 68), so they borrow the ordinary printing's
  -- picture rather than rendering as a blank frame. Nothing reads this to draw
  -- a page — the image URLs are copied onto the row so no join is needed — it
  -- records that the art is not the card's own. See ingest/src/metal-art.js.
  art_from_card_id  TEXT REFERENCES cards(id),
  tcgcsv_product_id INTEGER,               -- NULL until matched to a TCGplayer product
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cards_set       ON cards(set_id, collector_number);
CREATE INDEX IF NOT EXISTS idx_cards_name      ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_product   ON cards(tcgcsv_product_id);
-- The dominant sort on /cards and /rankings. Turns "top 50 by price" from a
-- 1,419-row scan plus a sort into a 50-row index read: 4,034 -> 50.
CREATE INDEX IF NOT EXISTS idx_cards_price     ON cards(market_price DESC);
-- PARTIAL, and that is load-bearing. Metal is ~5% of the catalogue, so this
-- serves "how many are hidden" (is_metal = 1) well. A FULL index on the same
-- column was worse than none: the planner chose it for the 95% case too,
-- matching 1,351 rows and sorting them instead of walking idx_cards_price and
-- stopping at 50 — topCards went 67 rows -> 2,679. See migration 004.
CREATE INDEX IF NOT EXISTS idx_cards_metal     ON cards(is_metal) WHERE is_metal = 1;

-- Facet counts for the filter chips on /cards and /rankings: one row per
-- option, ~35 rows in total, rebuilt by the catalog job.
--
-- These were five queries counting the whole catalogue on EVERY page view —
-- 12,788 rows read to render a row of chips whose numbers change once a night.
-- Derived data; the cards table remains the source of truth.
CREATE TABLE IF NOT EXISTS card_facets (
  kind     TEXT NOT NULL,     -- 'type' | 'faction' | 'set' | 'rarity' | 'printing'
  value    TEXT NOT NULL,     -- the raw value a filter travels as
  label    TEXT,              -- display name where it differs from the value (sets)
  n        INTEGER NOT NULL,
  position INTEGER NOT NULL,  -- render order, decided at write time
  PRIMARY KEY (kind, value)
);

-- ─────────────────────────── Prices ────────────────────────────

CREATE TABLE IF NOT EXISTS price_snapshots (
  card_id       TEXT NOT NULL REFERENCES cards(id),
  date          TEXT NOT NULL,             -- ISO date (YYYY-MM-DD), UTC
  market_price  REAL,                      -- may be NULL when TCGplayer has no market
  low_price     REAL,
  source        TEXT NOT NULL DEFAULT 'tcgcsv',
  PRIMARY KEY (card_id, date)
);

CREATE INDEX IF NOT EXISTS idx_prices_date     ON price_snapshots(date);
CREATE INDEX IF NOT EXISTS idx_prices_card_date ON price_snapshots(card_id, date DESC);

-- ─────────────────────────── Events & decks ────────────────────

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,              -- slug, e.g. 'worlds-2026'
  name      TEXT NOT NULL,
  date      TEXT NOT NULL,                 -- ISO date
  format    TEXT,                          -- 'standard', 'draft', ...
  store     TEXT,
  city      TEXT,
  state     TEXT,                          -- two-letter where applicable
  country   TEXT,                          -- ISO-3166 alpha-2, e.g. 'US'
  player_count INTEGER,                    -- attendance; how much a top 8 is worth
  source_url TEXT,                         -- where the lists were published
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(date DESC);

CREATE TABLE IF NOT EXISTS decks (
  id          TEXT PRIMARY KEY,            -- '<event_id>-<placement>'
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  placement   INTEGER NOT NULL CHECK (placement BETWEEN 1 AND 8),
  player_name TEXT,
  legend      TEXT,                        -- the deck's legend / champion identity
  -- The Legend's CARD, so a list of decks can show its art without going back
  -- through deck_cards for every row. Derived from deck_cards by the nightly
  -- recompute; see the note on LEGEND_ART in src/lib/queries.js for what it
  -- cost to look this up per row instead.
  legend_card_id TEXT REFERENCES cards(id),
  notes       TEXT,
  -- Precomputed nightly, immediately after the card prices they depend on.
  -- This reverses §8's "never stored" rule; §26 explains why it is still safe.
  total_cost     REAL,
  main_cost      REAL,
  side_cost      REAL,
  card_count     INTEGER,
  main_count     INTEGER,
  side_count     INTEGER,
  distinct_cards INTEGER,
  priced_cards   INTEGER,
  UNIQUE (event_id, placement)
);

CREATE INDEX IF NOT EXISTS idx_decks_event ON decks(event_id, placement);

-- One row per card: its most recent price inside PRICE_WINDOW_DAYS.
--
-- A materialised view of price_snapshots, rebuilt nightly by the price job.
-- It exists purely for read cost: computing "latest price per card" with a
-- window function on every query scanned the whole recent history each time,
-- which grew every night and reached 91% of D1's 5M/day read allowance. Here
-- the scan happens once a day.
--
-- Derived data. price_snapshots remains the source of truth; this table can be
-- dropped and rebuilt from it at any time.
CREATE TABLE IF NOT EXISTS card_latest_price (
  card_id      TEXT PRIMARY KEY REFERENCES cards(id),
  market_price REAL,
  low_price    REAL,
  date         TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- section is part of the key on purpose: a card can legitimately appear in both
-- the maindeck and the sideboard (e.g. 2x main + 1x side). Keying on
-- (deck_id, card_id) alone silently merges those two rows and loses a card.
CREATE TABLE IF NOT EXISTS deck_cards (
  deck_id   TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  card_id   TEXT NOT NULL REFERENCES cards(id),
  quantity  INTEGER NOT NULL CHECK (quantity > 0),
  section   TEXT NOT NULL DEFAULT 'main' CHECK (section IN ('main', 'sideboard')),
  PRIMARY KEY (deck_id, card_id, section)
);

CREATE INDEX IF NOT EXISTS idx_deck_cards_deck ON deck_cards(deck_id, section);
-- The reverse lookup: "which decks play this card", on every card page. The
-- primary key is (deck_id, card_id, section), so card_id alone was unindexed
-- and the query scanned the whole table. Measured 2026-09-02: 1,952 rows read
-- before this index, 4 after.
CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards(card_id);

/* Printed card text, from TCGplayer.
 *
 * Riftscribe publishes NO rules or flavor text — its card record carries only
 * ids, names, type, faction, rarity, stats and image URLs. TCGplayer product
 * data carries all of it in extendedData, and the price job already walks those
 * products daily, so the text arrives free and stays current.
 *
 * Upserted, not appended: unlike prices this is not history. Coverage measured
 * 2026-08-28 is 96% for rules text, 65% for flavor. A card with neither is left
 * without a row rather than given an empty one, so the page can tell "nothing
 * published" from "not ingested yet". */
CREATE TABLE IF NOT EXISTS card_text (
  card_id     TEXT PRIMARY KEY REFERENCES cards(id),
  energy_cost INTEGER,
  power_cost  INTEGER,
  might       INTEGER,
  type_line   TEXT,                      -- 'Champion Unit'
  tags        TEXT,                      -- 'Bilgewater;Yordle;Fizz'
  domain      TEXT,
  rules_text  TEXT,                      -- may contain <em> reminder text
  flavor_text TEXT,                      -- usually wrapped in <em>
  source      TEXT NOT NULL DEFAULT 'tcgplayer',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historical record, for the price charts in §9. Written nightly by copying the
-- columns on `decks` that the same job has just recomputed, so the history can
-- never record a number the site did not show.
CREATE TABLE IF NOT EXISTS deck_cost_snapshots (
  deck_id    TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  total_cost REAL,
  priced_cards INTEGER,                    -- how many distinct cards had a price
  total_cards  INTEGER,                    -- how many distinct cards in the deck
  PRIMARY KEY (deck_id, date)
);

-- ─────────────────────────── Observability ─────────────────────
-- The price source is an unofficial mirror with no uptime guarantee, so every
-- run records what happened. A missing day is fine; a silent corrupt day is not.

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  job         TEXT NOT NULL,               -- 'catalog' | 'prices' | 'deck_costs'
  status      TEXT NOT NULL,               -- 'ok' | 'skipped' | 'failed'
  trigger     TEXT,                        -- 'cron' | 'manual'
  rows_written INTEGER DEFAULT 0,
  message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON ingest_runs(started_at DESC);
