/**
 * SQL fragments that describe a card, shared by both Workers.
 *
 * These live outside src/ and ingest/ because BOTH need them and they must
 * never disagree:
 *
 *   src/lib/queries.js      filters and reads with them
 *   ingest/src/facets-sql.js counts with them, nightly
 *
 * Before this file, `PRINTINGS` existed once in queries.js and was mirrored by
 * hand in `printingOf()` in src/lib/vocab.js, with a comment saying the two must
 * agree. Precomputing the facet counts would have made that three copies of one
 * definition in three directories. Two is already one too many; vocab.js keeps
 * its copy only because it is JavaScript rather than SQL and answers a different
 * question (what to CALL a printing, not how to FIND one), and its comment
 * points here.
 *
 * Everything here assumes the cards table is aliased `c`.
 */

/**
 * Printing groups, expressed as SQL over the `variant` column.
 *
 * The catalogue records the printing in `variant`: empty for the base card,
 * 'a' for the alternate-art showcase, 'star' for the Signature, and codes like
 * sp1/r01/t01 for promos and tokens. Naming them here means a reader never has
 * to know that, and a Signature is findable by the word players actually use.
 *
 * Key order is the order the chips render in — the facet rebuild numbers them
 * from this object, so adding a group here needs no change anywhere else.
 */
export const PRINTINGS = {
  standard: "c.variant = ''",
  showcase: "c.variant = 'a'",
  signature: "c.variant = 'star'",
  promo: "c.variant NOT IN ('', 'a', 'star')",
};

/** Rarity has a meaningful order that alphabetical destroys. */
export const RARITY_RANK = `CASE c.rarity
  WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3
  WHEN 'epic' THEN 4 WHEN 'showcase' THEN 5 ELSE 6 END`;

/**
 * Metal prize cards.
 *
 * TCGplayer marks them only in the product name — "Teemo, Swift Scout (Metal)
 * (Prize Wall)" — so the name is the only signal there is. They are the
 * metal-printed prizes handed out at events: real cards with real prices, but
 * almost none have a photograph, and they are expensive enough to take over a
 * leaderboard sorted by price. Measured on 2026-08-30: 68 Metal cards, 15 of
 * them in the top 50 by price, and those 15 were **every** art-less card in
 * that top 50. Hiding Metal and hiding "expensive things with no picture" were
 * the same operation.
 *
 * **The read path tests `c.is_metal`, never the name.** `name LIKE '%(Metal)%'`
 * begins with a wildcard, so no index can ever serve it — it is a guaranteed
 * full scan, and /rankings applied it to every query it ran. The name test
 * below is the DEFINITION, used once a night to set the column; the column is
 * what queries filter on. Measured: metalCount 1,419 rows -> 68.
 */
export const IS_METAL_DEFINITION = "c.name LIKE '%(Metal)%'";

/** What a query filters on. Cheap, indexed by idx_cards_metal. */
export const METAL_HIDDEN = 'c.is_metal = 0';
export const METAL_ONLY = 'c.is_metal = 1';
