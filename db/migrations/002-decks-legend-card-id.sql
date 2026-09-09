-- Add decks.legend_card_id, and backfill it.
--
-- Apply BEFORE deploying the site Worker that reads it:
--   wrangler d1 execute scoutpost --remote --file=db/migrations/002-decks-legend-card-id.sql
--
-- Additive and safe to run while the old code is serving — the old queries
-- never look at this column. Migration first, deploy second, so there is no
-- window where the deployed code expects a column that is not there.
--
-- WHY
--
-- LEGEND_ART put the Legend's art on every row of a deck list. Finding it meant
-- walking that deck's deck_cards and joining `cards` on each row until the
-- Legend turned up — ~30 index entries plus ~30 card lookups, TWICE, once for
-- each rendition. About 120 rows read per deck row, ~7,700 for one listDecks,
-- growing with both the number of decks and the size of a decklist.
--
-- The Legend does not change between page views, so the lookup does not belong
-- on the read path. Same move as 001, and as §26 before it.
--
-- After this, LEGEND_ART is two primary-key lookups.
--
-- Idempotent apart from the ALTER, which fails harmlessly if the column already
-- exists ("duplicate column name: legend_card_id") — run the UPDATE alone then.
ALTER TABLE decks ADD COLUMN legend_card_id TEXT;

-- Unconditional, over every deck: a deck whose list changed must follow, and a
-- deck with no Legend row must go to NULL rather than keep a stale id. The
-- nightly recompute in ingest/src/deck-cost-sql.js runs exactly this.
UPDATE decks SET legend_card_id = (
  SELECT dc.card_id FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
   WHERE dc.deck_id = decks.id AND c.card_type = 'Legend' LIMIT 1
);
