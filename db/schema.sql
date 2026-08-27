-- Scoutpost — D1 schema
-- Apply:  wrangler d1 execute scoutpost --remote --file=db/schema.sql
--
-- Design notes:
--  * price_snapshots is APPEND-ONLY, one row per card per day. Raw daily values
--    only — never averages. Weekly/monthly views are computed at read time so
--    that a different window can always be derived later.
--  * events carries location columns from day one. Every early row will be a
--    national event, but having the columns now makes a regional layer a data
--    problem instead of a migration.
--  * Deck cost is NEVER stored as the source of truth. It is computed from
--    deck_cards joined against the latest price_snapshots at read time.
--    deck_cost_snapshots exists only as a historical record for charting.

PRAGMA foreign_keys = ON;

-- ─────────────────────────── Catalog ───────────────────────────

CREATE TABLE IF NOT EXISTS sets (
  id            TEXT PRIMARY KEY,          -- Riftscribe set_id, e.g. 'OGN'
  code          TEXT NOT NULL,             -- printed set code (same as id today)
  name          TEXT NOT NULL,             -- 'Origins', 'Vendetta', ...
  release_date  TEXT,                      -- ISO date (YYYY-MM-DD)
  tcgcsv_group_id INTEGER,                 -- TCGplayer groupId, for price joins
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
                                           -- image_url is the 778KB original PNG:
                                           -- canonical source, never served
  tcgcsv_product_id INTEGER,               -- NULL until matched to a TCGplayer product
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cards_set       ON cards(set_id, collector_number);
CREATE INDEX IF NOT EXISTS idx_cards_name      ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_product   ON cards(tcgcsv_product_id);

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
  notes       TEXT,
  UNIQUE (event_id, placement)
);

CREATE INDEX IF NOT EXISTS idx_decks_event ON decks(event_id, placement);

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

-- Historical record only. The displayed cost is always recomputed live.
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
