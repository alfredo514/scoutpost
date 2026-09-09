/**
 * The nightly rebuild of everything /cards and /rankings used to count per view.
 *
 * WHY
 *
 * Four facet queries, a printing-count query and the set-value board were all
 * unfiltered aggregates over the whole catalogue, recomputed on every page
 * view. Measured on production:
 *
 *   cardFacets (4 queries)   11,369 rows
 *   setValueTable             7,127
 *   printingFacets            1,419
 *   metalCount                1,419
 *
 * ~21,000 rows read per view, for numbers that change once a night. /rankings
 * ran all of them and cost ~30,900 rows — about 160 views to the entire
 * 5,000,000-row daily free tier.
 *
 * None of it depends on the request. Same test as sets.card_count and
 * decks.legend_card_id before it: does this value change between page views?
 * No. So it does not belong on the read path.
 *
 * WHAT RUNS WHERE
 *
 * Split across the two jobs by what each depends on, which matters — running a
 * step before the data it reads produces a silently stale number:
 *
 *   CATALOG_REBUILD_SQL  after the CARDS are written (catalog job). Counts by
 *                        type, colour, set, rarity and printing, and sets
 *                        cards.is_metal. All catalogue properties.
 *   PRICE_REBUILD_SQL    after the PRICES are written (price job), because
 *                        value and "priciest card" move with the market.
 *
 * Exported as SQL STRINGS rather than prepared statements, for the same reason
 * DECK_COST_SQL is: scripts/seed-local.mjs writes them to a file for
 * `wrangler d1 execute --file`, and cannot use a D1 binding. The Workers wrap
 * each in db.prepare().
 *
 * All of it is derived and rebuildable: `cards` remains the source of truth.
 */

import { IS_METAL_DEFINITION, PRINTINGS, RARITY_RANK } from '../../shared/card-sql.js';

/** The `is_metal` definition, written against the unaliased table. */
const IS_METAL_UNALIASED = IS_METAL_DEFINITION.replace(/\bc\./g, 'cards.');

/** One UNION ALL arm per printing group, numbered in the order PRINTINGS declares. */
const PRINTING_ROWS = Object.entries(PRINTINGS)
  .map(
    ([key, sql], i) =>
      `SELECT 'printing', '${key}', NULL, SUM(CASE WHEN ${sql} THEN 1 ELSE 0 END), ${i} FROM cards c`,
  )
  .join('\n       UNION ALL ');

/**
 * Run after the catalogue is written.
 *
 * `card_facets` is DELETEd and re-INSERTed rather than upserted: a value that
 * no longer has any cards — a rarity that vanishes, a set that is removed —
 * must DISAPPEAR from the chips, and an upsert would leave it there with a
 * stale count forever. Same reasoning as rebuildLatestPrices (§25).
 *
 * The Worker batches these, so the DELETE and its INSERTs land together. A page
 * rendered between them would show a filter bar with no chips at all.
 *
 * `position` is written here so the read side never has to know the ordering
 * rule. Types and colours order by size, sets by release date (newest first,
 * which is the one people look for), rarities by scarcity, printings by the
 * order PRINTINGS declares.
 */
export const CATALOG_REBUILD_SQL = [
  // The name test is the DEFINITION and runs once a night; every query reads
  // the column instead, because LIKE '%…%' can never use an index.
  `UPDATE cards SET is_metal = (CASE WHEN ${IS_METAL_UNALIASED} THEN 1 ELSE 0 END)`,

  "DELETE FROM card_facets WHERE kind IN ('type','faction','set','rarity','printing')",

  `INSERT INTO card_facets (kind, value, label, n, position)
     SELECT 'type', card_type, NULL, COUNT(*),
            ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) - 1
       FROM cards WHERE card_type IS NOT NULL GROUP BY card_type`,

  `INSERT INTO card_facets (kind, value, label, n, position)
     SELECT 'faction', faction, NULL, COUNT(*),
            ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) - 1
       FROM cards WHERE faction IS NOT NULL GROUP BY faction`,

  // Sets carry a label because the chip shows the set's NAME while the filter
  // travels as its id.
  `INSERT INTO card_facets (kind, value, label, n, position)
     SELECT 'set', c.set_id, COALESCE(s.name, c.set_id), COUNT(*),
            ROW_NUMBER() OVER (ORDER BY s.release_date DESC, c.set_id ASC) - 1
       FROM cards c LEFT JOIN sets s ON s.id = c.set_id
      GROUP BY c.set_id`,

  `INSERT INTO card_facets (kind, value, label, n, position)
     SELECT 'rarity', c.rarity, NULL, COUNT(*),
            ROW_NUMBER() OVER (ORDER BY ${RARITY_RANK} ASC) - 1
       FROM cards c WHERE c.rarity IS NOT NULL GROUP BY c.rarity`,

  `INSERT INTO card_facets (kind, value, label, n, position)
       ${PRINTING_ROWS}`,
];

/**
 * Run after prices are written.
 *
 * Fills the three price-derived columns behind the "Value by set" board on
 * /rankings: how many of a set's cards carry a price, what they add up to, and
 * which one is the priciest. The board reads those plus one lookup for the top
 * card's name — about 16 rows, where the window function it replaced cost
 * 7,127.
 *
 * `top_card_id` deliberately ignores whether the card is Metal. That board says
 * it covers every set and every printing, and §18 is explicit that it is a
 * comparison BETWEEN sets rather than a slice of one.
 */
export const PRICE_REBUILD_SQL = [
  `UPDATE sets SET
     priced_count = (SELECT COUNT(*) FROM cards c
                      WHERE c.set_id = sets.id AND c.market_price IS NOT NULL),
     total_value  = (SELECT SUM(c.market_price) FROM cards c
                      WHERE c.set_id = sets.id),
     top_card_id  = (SELECT c.id FROM cards c
                      WHERE c.set_id = sets.id AND c.market_price IS NOT NULL
                      ORDER BY c.market_price DESC LIMIT 1)`,
];
