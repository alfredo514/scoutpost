/**
 * The nightly deck-row recompute, as one statement.
 *
 * It lives in its own module because TWO callers run it and they must never
 * drift:
 *
 *   ingest/src/prices.js   rebuildDeckCosts(), against production, nightly
 *   scripts/seed-local.mjs the local seed, so `npm run dev` shows real costs
 *                          rather than zeroes (§27)
 *
 * The seed script used to carry a hand-copied duplicate marked "verbatim from
 * ingest/src/prices.js", which is a promise a comment cannot keep. If these two
 * ever disagree, local development shows different numbers from the live site —
 * and the whole point of the local database is that it does not.
 *
 * Reads `cards.market_price` (§26), which the price job has already written by
 * the time this runs. Anything that changes here changes `decks.total_cost` and
 * therefore /events, /decks and the deck_cost_snapshots history, which is
 * copied straight from these columns.
 */
export const DECK_COST_SQL = `UPDATE decks SET
  total_cost = (SELECT ROUND(SUM(COALESCE(c.market_price,0) * dc.quantity), 2)
                  FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
                 WHERE dc.deck_id = decks.id),
  main_cost  = (SELECT ROUND(SUM(CASE WHEN dc.section = 'main'
                                      THEN COALESCE(c.market_price,0) * dc.quantity
                                      ELSE 0 END), 2)
                  FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
                 WHERE dc.deck_id = decks.id),
  side_cost  = (SELECT ROUND(SUM(CASE WHEN dc.section = 'sideboard'
                                      THEN COALESCE(c.market_price,0) * dc.quantity
                                      ELSE 0 END), 2)
                  FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
                 WHERE dc.deck_id = decks.id),
  card_count = (SELECT SUM(dc.quantity) FROM deck_cards dc WHERE dc.deck_id = decks.id),
  main_count = (SELECT SUM(CASE WHEN dc.section = 'main' THEN dc.quantity ELSE 0 END)
                  FROM deck_cards dc WHERE dc.deck_id = decks.id),
  side_count = (SELECT SUM(CASE WHEN dc.section = 'sideboard' THEN dc.quantity ELSE 0 END)
                  FROM deck_cards dc WHERE dc.deck_id = decks.id),
  distinct_cards = (SELECT COUNT(*) FROM deck_cards dc WHERE dc.deck_id = decks.id),
  priced_cards   = (SELECT COUNT(*) FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
                     WHERE dc.deck_id = decks.id AND c.market_price IS NOT NULL),
  -- Not a cost, but it belongs in this pass: it is the same once-nightly walk
  -- of the same deck's cards, and doing it here costs nothing extra while
  -- saving every /decks and /events view from repeating it per row.
  legend_card_id = (SELECT dc.card_id FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
                     WHERE dc.deck_id = decks.id AND c.card_type = 'Legend' LIMIT 1)`;
