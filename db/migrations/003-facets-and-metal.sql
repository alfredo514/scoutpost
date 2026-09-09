-- Precompute the facet counts, the set-value board, and the Metal flag.
--
-- Apply BEFORE deploying the site Worker that reads them:
--   wrangler d1 execute scoutpost --remote --file=db/migrations/003-facets-and-metal.sql
--
-- Additive and safe to run while the old code is serving. Migration first,
-- deploy second, so there is no window where the code expects something absent.
--
-- WHY
--
-- /rankings cost ~30,900 rows read per view and /cards ~18,400, almost all of
-- it aggregates over the whole catalogue recomputed on every single view for
-- numbers that change once a night. Measured on production:
--
--   cardFacets (4 queries)   11,369 rows   -> ~30 (one table read)
--   setValueTable             7,127        -> ~16 (columns on sets)
--   printingFacets            1,419        -> ~4
--   metalCount                1,419        -> ~68 (indexed column)
--
-- Same test as sets.card_count and decks.legend_card_id: does this value change
-- between page views? No. So it does not belong on the read path.
--
-- Every statement below is idempotent apart from the ALTERs and the CREATE
-- INDEX, which fail harmlessly if already applied ("duplicate column name").
-- The backfills mirror ingest/src/facets-sql.js exactly; that module is what
-- keeps them current from here on.

ALTER TABLE cards ADD COLUMN is_metal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sets  ADD COLUMN priced_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sets  ADD COLUMN total_value REAL;
ALTER TABLE sets  ADD COLUMN top_card_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cards_metal ON cards(is_metal);

CREATE TABLE IF NOT EXISTS card_facets (
  kind     TEXT NOT NULL,
  value    TEXT NOT NULL,
  label    TEXT,
  n        INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
);

-- ── backfill: catalogue-derived ──
UPDATE cards SET is_metal = (SELECT CASE WHEN cards.name LIKE '%(Metal)%' THEN 1 ELSE 0 END);

DELETE FROM card_facets WHERE kind IN ('type','faction','set','rarity','printing');

INSERT INTO card_facets (kind, value, label, n, position)
SELECT 'type', card_type, NULL, COUNT(*), ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) - 1
  FROM cards WHERE card_type IS NOT NULL GROUP BY card_type;

INSERT INTO card_facets (kind, value, label, n, position)
SELECT 'faction', faction, NULL, COUNT(*), ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) - 1
  FROM cards WHERE faction IS NOT NULL GROUP BY faction;

INSERT INTO card_facets (kind, value, label, n, position)
SELECT 'set', c.set_id, COALESCE(s.name, c.set_id), COUNT(*),
       ROW_NUMBER() OVER (ORDER BY s.release_date DESC, c.set_id ASC) - 1
  FROM cards c LEFT JOIN sets s ON s.id = c.set_id GROUP BY c.set_id;

INSERT INTO card_facets (kind, value, label, n, position)
SELECT 'rarity', c.rarity, NULL, COUNT(*),
       ROW_NUMBER() OVER (ORDER BY CASE c.rarity
         WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3
         WHEN 'epic' THEN 4 WHEN 'showcase' THEN 5 ELSE 6 END ASC) - 1
  FROM cards c WHERE c.rarity IS NOT NULL GROUP BY c.rarity;

INSERT INTO card_facets (kind, value, label, n, position)
SELECT 'printing', 'standard', NULL, SUM(CASE WHEN c.variant = '' THEN 1 ELSE 0 END), 0 FROM cards c
UNION ALL
SELECT 'printing', 'showcase', NULL, SUM(CASE WHEN c.variant = 'a' THEN 1 ELSE 0 END), 1 FROM cards c
UNION ALL
SELECT 'printing', 'signature', NULL, SUM(CASE WHEN c.variant = 'star' THEN 1 ELSE 0 END), 2 FROM cards c
UNION ALL
SELECT 'printing', 'promo', NULL, SUM(CASE WHEN c.variant NOT IN ('', 'a', 'star') THEN 1 ELSE 0 END), 3 FROM cards c;

-- ── backfill: price-derived ──
UPDATE sets SET
  priced_count = (SELECT COUNT(*) FROM cards c WHERE c.set_id = sets.id AND c.market_price IS NOT NULL),
  total_value  = (SELECT SUM(c.market_price) FROM cards c WHERE c.set_id = sets.id),
  top_card_id  = (SELECT c.id FROM cards c WHERE c.set_id = sets.id AND c.market_price IS NOT NULL
                   ORDER BY c.market_price DESC LIMIT 1);
