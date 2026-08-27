/**
 * D1 queries.
 *
 * Deck build cost is ALWAYS computed here, at read time, by joining deck_cards
 * against the most recent price_snapshot per card. It is never read back from
 * deck_cost_snapshots — that table is history for charting only.
 *
 * "Most recent per card" rather than "most recent overall": if a card missed a
 * day (TCGplayer had no market price, or a set import was skipped), it should
 * fall back to its own last known price instead of dropping out of the total.
 */

/**
 * Latest price row per card. Reused by every cost query.
 *
 * The ranking is per-card, not a global "newest date", so a card absent from
 * today's feed keeps its own last known price instead of dropping out of a deck
 * total. That fallback is the whole point of the window function.
 *
 * The WHERE clause is what keeps it affordable. Without it this scans every
 * price row ever recorded on every page view — fine at a few thousand rows,
 * ~410k/year later, for identical output. Bounding the scan to the most recent
 * PRICE_WINDOW_DAYS makes the cost constant no matter how deep the history
 * gets, and idx_prices_date serves it.
 *
 * The tradeoff: a card with no price for longer than the window reads as
 * unpriced rather than quoting a stale figure. That is the better answer — the
 * deck page already shows how many of its cards are priced, so an honest gap is
 * visible where a months-old price would silently look current.
 */
const PRICE_WINDOW_DAYS = 30;

const LATEST_PRICES = `
  latest AS (
    SELECT card_id, market_price, low_price, date,
           ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY date DESC) AS rn
      FROM price_snapshots
     WHERE date >= date((SELECT MAX(date) FROM price_snapshots), '-${PRICE_WINDOW_DAYS} day')
  )`;

export async function latestPriceDate(db) {
  const row = await db.prepare('SELECT MAX(date) AS d FROM price_snapshots').first();
  return row?.d ?? null;
}

export async function listEvents(db, { limit = 50 } = {}) {
  const { results } = await db
    .prepare(
      `WITH ${LATEST_PRICES},
       deck_costs AS (
         SELECT d.id AS deck_id, d.event_id,
                SUM(COALESCE(p.market_price, 0) * dc.quantity) AS cost
           FROM decks d
           JOIN deck_cards dc ON dc.deck_id = d.id
           LEFT JOIN latest p ON p.card_id = dc.card_id AND p.rn = 1
          GROUP BY d.id
       )
       SELECT e.*,
              COUNT(dc.deck_id)  AS deck_count,
              MAX(dc.cost)       AS max_cost,
              MIN(dc.cost)       AS min_cost
         FROM events e
         LEFT JOIN deck_costs dc ON dc.event_id = e.id
        GROUP BY e.id
        ORDER BY e.date DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}

export async function getEvent(db, slug) {
  return db.prepare('SELECT * FROM events WHERE id = ?').bind(slug).first();
}

/**
 * Top 8 for an event, each with a live build cost.
 * `priced_cards` / `total_cards` let the page be honest about coverage rather
 * than quietly under-reporting a total when a card has no price yet.
 */
export async function getEventDecks(db, eventId) {
  const { results } = await db
    .prepare(
      `WITH ${LATEST_PRICES}
       SELECT d.id, d.placement, d.player_name, d.legend, d.notes,
              ROUND(SUM(COALESCE(p.market_price, 0) * dc.quantity), 2) AS total_cost,
              ROUND(SUM(CASE WHEN dc.section = 'main'
                             THEN COALESCE(p.market_price, 0) * dc.quantity ELSE 0 END), 2) AS main_cost,
              ROUND(SUM(CASE WHEN dc.section = 'sideboard'
                             THEN COALESCE(p.market_price, 0) * dc.quantity ELSE 0 END), 2) AS side_cost,
              SUM(CASE WHEN dc.section = 'main' THEN dc.quantity ELSE 0 END) AS main_count,
              SUM(CASE WHEN dc.section = 'sideboard' THEN dc.quantity ELSE 0 END) AS side_count,
              SUM(dc.quantity)                                          AS card_count,
              COUNT(dc.card_id)                                         AS distinct_cards,
              SUM(CASE WHEN p.market_price IS NOT NULL THEN 1 ELSE 0 END) AS priced_cards
         FROM decks d
         LEFT JOIN deck_cards dc ON dc.deck_id = d.id
         LEFT JOIN latest p ON p.card_id = dc.card_id AND p.rn = 1
        WHERE d.event_id = ?
        GROUP BY d.id
        ORDER BY d.placement ASC`,
    )
    .bind(eventId)
    .all();
  return results ?? [];
}

export async function getDeck(db, deckId) {
  return db
    .prepare(
      `SELECT d.*, e.name AS event_name, e.id AS event_slug, e.date AS event_date,
              e.city, e.state, e.country, e.format
         FROM decks d
         JOIN events e ON e.id = d.event_id
        WHERE d.id = ?`,
    )
    .bind(deckId)
    .first();
}

/** Every card in a deck with its current price and line total. */
export async function getDeckCards(db, deckId) {
  const { results } = await db
    .prepare(
      `WITH ${LATEST_PRICES}
       SELECT c.id, c.name, c.set_id, c.collector_number, c.public_code,
              c.rarity, c.card_type, c.image_thumb_url, c.image_large_url,
              c.tcgcsv_product_id,
              dc.quantity, dc.section,
              p.market_price, p.low_price, p.date AS price_date,
              ROUND(COALESCE(p.market_price, 0) * dc.quantity, 2) AS line_total
         FROM deck_cards dc
         JOIN cards c ON c.id = dc.card_id
         LEFT JOIN latest p ON p.card_id = dc.card_id AND p.rn = 1
        WHERE dc.deck_id = ?
        ORDER BY dc.section ASC, line_total DESC, c.name ASC`,
    )
    .bind(deckId)
    .all();
  return results ?? [];
}

/** Decks across all events, most expensive first — powers /decks. */
export async function listDecks(db, { limit = 100 } = {}) {
  const { results } = await db
    .prepare(
      `WITH ${LATEST_PRICES}
       SELECT d.id, d.placement, d.player_name, d.legend,
              e.id AS event_slug, e.name AS event_name, e.date AS event_date,
              ROUND(SUM(COALESCE(p.market_price, 0) * dc.quantity), 2) AS total_cost,
              SUM(dc.quantity) AS card_count
         FROM decks d
         JOIN events e ON e.id = d.event_id
         LEFT JOIN deck_cards dc ON dc.deck_id = d.id
         LEFT JOIN latest p ON p.card_id = dc.card_id AND p.rn = 1
        GROUP BY d.id
        ORDER BY e.date DESC, d.placement ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}

/** Small headline numbers for the homepage. */
export async function siteStats(db) {
  const [cards, events, decks, priceDate] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM cards').first(),
    db.prepare('SELECT COUNT(*) AS n FROM events').first(),
    db.prepare('SELECT COUNT(*) AS n FROM decks').first(),
    latestPriceDate(db),
  ]);
  return {
    cards: cards?.n ?? 0,
    events: events?.n ?? 0,
    decks: decks?.n ?? 0,
    priceDate,
  };
}

export async function allEventSlugs(db) {
  const { results } = await db.prepare('SELECT id, date FROM events ORDER BY date DESC').all();
  return results ?? [];
}

export async function allDeckIds(db) {
  const { results } = await db.prepare('SELECT id FROM decks').all();
  return results ?? [];
}
