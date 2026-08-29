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

/**
 * The Legend's art, for a deck listed among others.
 *
 * A Riftbound deck has exactly one Legend and players recognise a deck by it on
 * sight, so a list of decks reads far faster with the art than with the name
 * alone. Correlated subqueries rather than a join: the surrounding queries
 * aggregate over deck_cards with GROUP BY, and joining a second copy of that
 * table would multiply the rows those aggregates are summing.
 *
 * `idx_deck_cards_deck` serves the lookup, and there are only ever 8 decks on
 * an event page.
 */
const LEGEND_ART = `
  (SELECT cl.image_thumb_url FROM deck_cards dcl JOIN cards cl ON cl.id = dcl.card_id
    WHERE dcl.deck_id = d.id AND cl.card_type = 'Legend' LIMIT 1) AS legend_thumb_url,
  (SELECT cl.image_large_url FROM deck_cards dcl JOIN cards cl ON cl.id = dcl.card_id
    WHERE dcl.deck_id = d.id AND cl.card_type = 'Legend' LIMIT 1) AS legend_large_url`;

export async function latestPriceDate(db) {
  const row = await db.prepare('SELECT MAX(date) AS d FROM price_snapshots').first();
  return row?.d ?? null;
}

/**
 * Events, newest first, each with the cost spread across its top 8.
 *
 * `era` filters to the set that was legal when the event was played. It is
 * derived from dates, not stored, so a new set needs no migration.
 */
export async function listEvents(db, { limit = 50, era = '' } = {}) {
  const filter = era ? `HAVING era = ?` : '';
  const params = era ? [era, limit] : [limit];
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
              ${EVENT_ERA} AS era,
              COUNT(dc.deck_id)  AS deck_count,
              MAX(dc.cost)       AS max_cost,
              MIN(dc.cost)       AS min_cost
         FROM events e
         LEFT JOIN deck_costs dc ON dc.event_id = e.id
        GROUP BY e.id
        ${filter}
        ORDER BY e.date DESC
        LIMIT ?`,
    )
    .bind(...params)
    .all();
  return results ?? [];
}

/** How many events sit in each era — drives the counts on the filter pills. */
export async function eventEraCounts(db) {
  const { results } = await db
    .prepare(`SELECT ${EVENT_ERA} AS era, COUNT(*) AS n FROM events e GROUP BY era`)
    .all();
  return Object.fromEntries((results ?? []).map((r) => [r.era, r.n]));
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
              ${LEGEND_ART},
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

/**
 * Decks across all events — powers /decks.
 *
 * A deck's era is its parent event's era, so the same date-derived rule applies
 * and no deck carries a stored set tag.
 */
/**
 * Decks, newest event first.
 *
 * `legend` matches the stored name exactly; `q` is a substring over the legend
 * and the player, so one box finds "Irelia" and "TheManland" alike. Both are
 * pre-aggregation WHERE conditions rather than a HAVING like `era`, because
 * they filter rows of `decks` rather than a value computed per group — a
 * HAVING here would make the query scan and total every deck before throwing
 * most of them away.
 */
export async function listDecks(db, { limit = 100, era = '', legend = '', q = '' } = {}) {
  const where = [];
  const params = [];
  if (legend) {
    where.push('d.legend = ?');
    params.push(legend);
  }
  if (q) {
    where.push('(lower(d.legend) LIKE ? OR lower(d.player_name) LIKE ?)');
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filter = era ? 'HAVING era = ?' : '';
  if (era) params.push(era);
  params.push(limit);

  const { results } = await db
    .prepare(
      `WITH ${LATEST_PRICES}
       SELECT d.id, d.placement, d.player_name, d.legend,
              e.id AS event_slug, e.name AS event_name, e.date AS event_date,
              ${EVENT_ERA} AS era,
              ${LEGEND_ART},
              ROUND(SUM(COALESCE(p.market_price, 0) * dc.quantity), 2) AS total_cost,
              SUM(dc.quantity) AS card_count
         FROM decks d
         JOIN events e ON e.id = d.event_id
         LEFT JOIN deck_cards dc ON dc.deck_id = d.id
         LEFT JOIN latest p ON p.card_id = dc.card_id AND p.rn = 1
         ${clause}
        GROUP BY d.id
        ${filter}
        ORDER BY e.date DESC, d.placement ASC
        LIMIT ?`,
    )
    .bind(...params)
    .all();
  return results ?? [];
}

/**
 * Every Legend that has a deck, with one piece of art and a deck count.
 *
 * Drives the avatar row on /decks. The art is taken from whichever deck
 * happens to sort first for that Legend — every deck running a Legend runs the
 * same card, so any of them is the right picture, and picking one with
 * ROW_NUMBER avoids a second query per Legend.
 *
 * Counts respect the set filter, so the row never offers a Legend that would
 * return an empty table in the era being viewed.
 */
export async function legendFacets(db, { era = '' } = {}) {
  const having = era ? 'WHERE era = ?' : '';
  const params = era ? [era] : [];
  const { results } = await db
    .prepare(
      `WITH per_deck AS (
         SELECT d.legend, cl.image_thumb_url AS thumb, d.id AS deck_id,
                ${EVENT_ERA} AS era
           FROM decks d
           JOIN events e ON e.id = d.event_id
           JOIN deck_cards dc ON dc.deck_id = d.id
           JOIN cards cl ON cl.id = dc.card_id AND cl.card_type = 'Legend'
       ),
       scoped AS (SELECT * FROM per_deck ${having}),
       ranked AS (
         SELECT legend, thumb,
                ROW_NUMBER() OVER (PARTITION BY legend ORDER BY deck_id) AS rn,
                COUNT(*) OVER (PARTITION BY legend) AS n
           FROM scoped
       )
       SELECT legend, thumb, n FROM ranked
        WHERE rn = 1 AND legend IS NOT NULL AND legend <> ''
        ORDER BY n DESC, legend ASC`,
    )
    .bind(...params)
    .all();
  return results ?? [];
}

/** How many decks sit in each era — drives the counts on the filter pills. */
export async function deckEraCounts(db) {
  const { results } = await db
    .prepare(
      `SELECT ${EVENT_ERA} AS era, COUNT(*) AS n
         FROM decks d JOIN events e ON e.id = d.event_id
        GROUP BY era`,
    )
    .all();
  return Object.fromEntries((results ?? []).map((r) => [r.era, r.n]));
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

/**
 * The card browser behind /cards.
 *
 * Filters are plain SQL over indexed columns, built from whatever the caller
 * passes, because the page drives them from query-string links rather than
 * JavaScript — a filtered view has to be a real URL that can be shared,
 * bookmarked and crawled.
 *
 * Ordering is price descending, which is this site's whole angle: the first
 * thing anyone wants from a card list is what the expensive ones are. Unpriced
 * cards sort last rather than reading as free.
 */
/**
 * Printing groups, expressed as SQL over the `variant` column.
 *
 * The catalogue records the printing in `variant`: empty for the base card,
 * 'a' for the alternate-art showcase, 'star' for the Signature, and codes like
 * sp1/r01/t01 for promos and tokens. Naming them here means a reader never has
 * to know that, and a Signature is findable by the word players actually use.
 */
const PRINTINGS = {
  standard: "c.variant = ''",
  showcase: "c.variant = 'a'",
  signature: "c.variant = 'star'",
  promo: "c.variant NOT IN ('', 'a', 'star')",
};

function cardFilterParts({ type, color, set, rarity, printing, q, priced }) {
  const where = [];
  const params = [];
  if (type) {
    where.push('c.card_type = ?');
    params.push(type);
  }
  if (color) {
    where.push('c.faction = ?');
    params.push(color);
  }
  if (set) {
    where.push('c.set_id = ?');
    params.push(set);
  }
  if (rarity) {
    where.push('c.rarity = ?');
    params.push(rarity);
  }
  if (printing && PRINTINGS[printing]) {
    where.push(PRINTINGS[printing]);
  }
  if (q) {
    // Substring, case-insensitive, over name and printed code, so both
    // "nashor" and "UNL-147" find the card. 1,180 rows makes a scan free;
    // do not reach for FTS until the catalogue is an order of magnitude bigger.
    where.push('(lower(c.name) LIKE ? OR lower(c.public_code) LIKE ?)');
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  if (priced === 'yes') where.push('p.market_price IS NOT NULL');
  if (priced === 'no') where.push('p.market_price IS NULL');

  return { where, params };
}

/**
 * The same filters as a standalone WHERE clause, for queries that have no other
 * conditions of their own. Queries that do (the movers board carries its own)
 * take the parts above and merge them instead.
 */
function cardFilterSql(filters) {
  const { where, params } = cardFilterParts(filters);
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Sort orders offered by /cards.
 *
 * `price` is the default because it is what this site is for. `set` is how you
 * read a set rather than shop it: newest release first, then collector number,
 * which is the order the cards are printed in.
 *
 * A fixed map rather than interpolated input — the value arrives from a query
 * string, and ORDER BY cannot be parameterised.
 */
const UNPRICED_LAST = 'CASE WHEN p.market_price IS NULL THEN 1 ELSE 0 END';

/* Rarity has a meaningful order that alphabetical destroys. */
const RARITY_RANK = `CASE c.rarity
  WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3
  WHEN 'epic' THEN 4 WHEN 'showcase' THEN 5 ELSE 6 END`;

const CARD_SORTS = {
  price: `${UNPRICED_LAST}, p.market_price DESC, c.name ASC`,
  'price-asc': `${UNPRICED_LAST}, p.market_price ASC, c.name ASC`,
  name: 'c.name ASC, s.release_date DESC',
  'name-desc': 'c.name DESC, s.release_date DESC',
  set: 's.release_date DESC, c.collector_number ASC, c.variant ASC',
  'set-asc': 's.release_date ASC, c.collector_number ASC, c.variant ASC',
  rarity: `${RARITY_RANK} DESC, ${UNPRICED_LAST}, p.market_price DESC`,
  'rarity-asc': `${RARITY_RANK} ASC, c.name ASC`,
};

export async function listCards(db, { sort = 'price', limit = 50, offset = 0, ...filters } = {}) {
  const { clause, params } = cardFilterSql(filters);
  const order = CARD_SORTS[sort] ?? CARD_SORTS.price;
  const { results } = await db
    .prepare(
      `WITH ${LATEST_PRICES}
       SELECT c.id, c.name, c.public_code, c.set_id, c.collector_number,
              c.rarity, c.card_type, c.faction,
              c.image_thumb_url, c.image_large_url,
              s.name AS set_name,
              p.market_price
         FROM cards c
         LEFT JOIN sets s ON s.id = c.set_id
         LEFT JOIN latest p ON p.card_id = c.id AND p.rn = 1
         ${clause}
        ORDER BY ${order}
        LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all();
  return results ?? [];
}

/**
 * How many cards match a filter — drives the pager and the result count.
 *
 * Joins prices even though it counts rows, because the `priced` filter tests
 * `p.market_price`. Counting against a different FROM clause than the listing
 * uses is how a pager ends up disagreeing with its own results.
 */
export async function countCards(db, filters = {}) {
  const { clause, params } = cardFilterSql(filters);
  const row = await db
    .prepare(
      `WITH ${LATEST_PRICES}
       SELECT COUNT(*) AS n
         FROM cards c
         LEFT JOIN sets s ON s.id = c.set_id
         LEFT JOIN latest p ON p.card_id = c.id AND p.rn = 1
         ${clause}`,
    )
    .bind(...params)
    .first();
  return row?.n ?? 0;
}

/** Facet counts, so a filter button can say how much is behind it. */
export async function cardFacets(db) {
  const [types, colors, sets, rarities] = await Promise.all([
    db.prepare('SELECT card_type AS v, COUNT(*) AS n FROM cards WHERE card_type IS NOT NULL GROUP BY card_type ORDER BY n DESC').all(),
    db.prepare('SELECT faction AS v, COUNT(*) AS n FROM cards WHERE faction IS NOT NULL GROUP BY faction ORDER BY n DESC').all(),
    // Newest set first — that is the one people are looking for.
    db.prepare(
      `SELECT c.set_id AS v, COALESCE(s.name, c.set_id) AS label, COUNT(*) AS n
         FROM cards c LEFT JOIN sets s ON s.id = c.set_id
        GROUP BY c.set_id
        ORDER BY s.release_date DESC, c.set_id ASC`,
    ).all(),
    // Scarcity order, not alphabetical — 'common, epic, rare' would be absurd.
    db.prepare(
      `SELECT rarity AS v, COUNT(*) AS n FROM cards WHERE rarity IS NOT NULL
        GROUP BY rarity ORDER BY ${RARITY_RANK.replace(/c\.rarity/, 'rarity')} ASC`,
    ).all(),
  ]);
  return {
    types: types.results ?? [],
    colors: colors.results ?? [],
    sets: sets.results ?? [],
    rarities: rarities.results ?? [],
  };
}

/** Counts per printing group, so the Signature chip can say how many there are. */
/**
 * How many cards fall in each printing group.
 *
 * One pass with a conditional count per group, not one query per group. The
 * loop that was here awaited four round trips in sequence for four numbers off
 * the same 1,180-row scan — on the critical path of both /cards and /rankings,
 * where every one of those trips is latency the reader waits for.
 *
 * Order comes from PRINTINGS, so the chips stay in the order that object
 * declares and adding a group there needs no change here.
 */
export async function printingFacets(db) {
  const groups = Object.entries(PRINTINGS);
  const columns = groups
    .map(([key, sql], i) => `SUM(CASE WHEN ${sql} THEN 1 ELSE 0 END) AS g${i}`)
    .join(', ');

  const row = await db.prepare(`SELECT ${columns} FROM cards c`).first();
  return groups.map(([key], i) => ({ v: key, n: row?.[`g${i}`] ?? 0 }));
}

/**
 * The format eras — the main sets, newest first.
 *
 * An event belongs to the set that was legal when it was played, so the era is
 * derived from dates rather than stored on the event. That means a new set
 * needs no migration: it appears here the moment the catalogue ingests it.
 *
 * Sets sharing a release date are one era, labelled by the larger of them.
 * Origins: Proving Grounds is a 24-card starter released alongside Origins and
 * is not a format of its own, which is what the card-count ordering handles
 * without naming it.
 */
export async function setEras(db) {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.release_date, COUNT(c.id) AS cards
         FROM sets s LEFT JOIN cards c ON c.set_id = s.id
        WHERE s.release_date IS NOT NULL
        GROUP BY s.id
        ORDER BY s.release_date DESC, cards DESC`,
    )
    .all();

  const byDate = new Map();
  for (const row of results ?? []) if (!byDate.has(row.release_date)) byDate.set(row.release_date, row);
  return [...byDate.values()];
}

/**
 * Which era an event falls in: the most recent set released on or before it.
 * Expressed as SQL so it can be both selected and filtered on.
 */
const EVENT_ERA = `
  (SELECT s.id FROM sets s
    WHERE s.release_date <= e.date
    ORDER BY s.release_date DESC, (SELECT COUNT(*) FROM cards WHERE set_id = s.id) DESC
    LIMIT 1)`;

/**
 * One card, with its transcribed text if we have any, and its current price.
 *
 * The LEFT JOIN on card_text is deliberate: that table is sparse because the
 * catalogue API publishes no rules or flavor text, so most cards have no row.
 * The page renders what exists rather than pretending.
 */
export async function getCard(db, id) {
  return db
    .prepare(
      `WITH ${LATEST_PRICES}
       SELECT c.*, s.name AS set_name, s.release_date,
              t.energy_cost, t.power_cost, t.might, t.type_line,
              t.tags, t.domain, t.rules_text, t.flavor_text,
              p.market_price, p.low_price, p.date AS price_date
         FROM cards c
         LEFT JOIN sets s ON s.id = c.set_id
         LEFT JOIN card_text t ON t.card_id = c.id
         LEFT JOIN latest p ON p.card_id = c.id AND p.rn = 1
        WHERE c.id = ?`,
    )
    .bind(id)
    .first();
}

/** Which top-8 decks play this card, and how many copies. */
export async function decksPlayingCard(db, cardId, { limit = 12 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.placement, d.player_name, d.legend,
              e.id AS event_slug, e.name AS event_name, e.date AS event_date,
              dc.quantity, dc.section
         FROM deck_cards dc
         JOIN decks d ON d.id = dc.deck_id
         JOIN events e ON e.id = d.event_id
        WHERE dc.card_id = ?
        ORDER BY e.date DESC, d.placement ASC
        LIMIT ?`,
    )
    .bind(cardId, limit)
    .all();
  return results ?? [];
}

/* ───────────────────────────── Rankings ─────────────────────────────
 *
 * /rankings answers two questions /cards cannot: what the market looks like in
 * aggregate, and what moved. Everything here reads the same price_snapshots
 * table, but sliced across cards rather than down a decklist.
 */

/**
 * Most valuable cards right now. Filters are the /cards ones, so a ranking is
 * always a slice of the same catalogue and links straight back into it.
 */
export async function topCards(db, { limit = 25, ...filters } = {}) {
  const { clause, params } = cardFilterSql({ ...filters, priced: 'yes' });
  const { results } = await db
    .prepare(
      `WITH ${LATEST_PRICES}
       SELECT c.id, c.name, c.public_code, c.set_id, c.collector_number,
              c.variant, c.rarity, c.card_type, c.faction,
              c.image_thumb_url, c.image_large_url,
              s.name AS set_name,
              p.market_price, p.date AS price_date
         FROM cards c
         LEFT JOIN sets s ON s.id = c.set_id
         LEFT JOIN latest p ON p.card_id = c.id AND p.rn = 1
         ${clause}
        ORDER BY p.market_price DESC, c.name ASC
        LIMIT ?`,
    )
    .bind(...params, limit)
    .all();
  return results ?? [];
}

/**
 * Aggregate market figures for whatever slice is being shown.
 *
 * `cards` counts everything matching the filter and `priced` only what carries
 * a price, because the gap between the two is the honest caveat on every other
 * number here — a catalogue total computed over 96% of the cards is not the
 * catalogue's value, and the page says so rather than implying otherwise.
 */
export async function marketStats(db, filters = {}) {
  const totals = cardFilterSql(filters);
  const middle = cardFilterSql({ ...filters, priced: 'yes' });

  const [agg, med] = await Promise.all([
    db
      .prepare(
        `WITH ${LATEST_PRICES}
         SELECT COUNT(*) AS cards,
                SUM(CASE WHEN p.market_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
                SUM(p.market_price) AS total,
                MAX(p.market_price) AS top,
                SUM(CASE WHEN p.market_price >= 50 THEN 1 ELSE 0 END) AS over50
           FROM cards c
           LEFT JOIN latest p ON p.card_id = c.id AND p.rn = 1
           ${totals.clause}`,
      )
      .bind(...totals.params)
      .first(),
    // SQLite has no median. Rank the priced rows, then average the middle one
    // or two — the integer division picks a single row for an odd count and the
    // straddling pair for an even one.
    db
      .prepare(
        `WITH ${LATEST_PRICES},
         priced AS (
           SELECT p.market_price AS px,
                  ROW_NUMBER() OVER (ORDER BY p.market_price) AS pos,
                  COUNT(*) OVER () AS n
             FROM cards c
             LEFT JOIN latest p ON p.card_id = c.id AND p.rn = 1
             ${middle.clause}
         )
         SELECT AVG(px) AS median FROM priced WHERE pos IN ((n + 1) / 2, (n + 2) / 2)`,
      )
      .bind(...middle.params)
      .first(),
  ]);

  return {
    cards: agg?.cards ?? 0,
    priced: agg?.priced ?? 0,
    total: agg?.total ?? 0,
    top: agg?.top ?? null,
    over50: agg?.over50 ?? 0,
    median: med?.median ?? null,
  };
}

/**
 * Every set, ranked by how much of the catalogue's value sits in it.
 *
 * The priciest card per set comes from a ROW_NUMBER partition rather than a
 * correlated subquery. Two correlated lookups per set each re-scanned the whole
 * catalogue: 28,762 rows read against 23,025 for this, measured on 2026-08-28
 * for identical output. That gap widens with every set added, and D1's free
 * tier is metered on rows read — see §10 of the handoff.
 */
export async function setValueTable(db) {
  const { results } = await db
    .prepare(
      `WITH ${LATEST_PRICES},
       j AS (
         SELECT c.set_id, c.id, c.name, p.market_price AS px,
                ROW_NUMBER() OVER (PARTITION BY c.set_id ORDER BY p.market_price DESC) AS px_rank
           FROM cards c
           LEFT JOIN latest p ON p.card_id = c.id AND p.rn = 1
       )
       SELECT s.id, s.name, s.release_date,
              COUNT(j.id) AS cards,
              SUM(CASE WHEN j.px IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(j.px) AS total,
              MAX(CASE WHEN j.px_rank = 1 AND j.px IS NOT NULL THEN j.px   END) AS top_price,
              MAX(CASE WHEN j.px_rank = 1 AND j.px IS NOT NULL THEN j.name END) AS top_name,
              MAX(CASE WHEN j.px_rank = 1 AND j.px IS NOT NULL THEN j.id   END) AS top_id
         FROM sets s
         JOIN j ON j.set_id = s.id
        GROUP BY s.id
        ORDER BY total DESC`,
    )
    .all();
  return results ?? [];
}

/**
 * How far back the movers board looks.
 *
 * Seven days is the target. The board reports the widest span that actually
 * exists inside it — with a three-day-old price history that is three days, and
 * the page prints the real dates rather than claiming a week.
 */
const MOVER_WINDOW_DAYS = 7;

/**
 * Cards below this price are excluded from the movers board.
 *
 * Not a matter of taste. TCGplayer quotes bulk cards in whole cents, so a
 * common going $0.10 to $0.17 is a one-cent-scale wobble that arrives as +70%
 * and buries every real move: measured over 26-28 Aug, the unfiltered top ten
 * risers were all sub-$1 cards, while the same query above $2 returned Irelia,
 * Rengar and Ornn — the cards actually being bought. The floor is what makes
 * this board mean anything.
 */
const MOVER_FLOOR = 2;

/**
 * The two dates the movers board compares: the newest snapshot, and the oldest
 * one still inside the window.
 *
 * Returns `null` when there is only one date, because a single snapshot cannot
 * show a movement and an empty board is the truthful answer.
 */
export async function moverWindow(db) {
  const row = await db
    .prepare(
      `SELECT (SELECT MAX(date) FROM price_snapshots) AS to_date,
              (SELECT MIN(date) FROM price_snapshots
                WHERE date >= date((SELECT MAX(date) FROM price_snapshots),
                                   '-${MOVER_WINDOW_DAYS} day')) AS from_date`,
    )
    .first();
  if (!row?.to_date || !row?.from_date || row.to_date === row.from_date) return null;
  return { from: row.from_date, to: row.to_date, floor: MOVER_FLOOR };
}

/**
 * Biggest movers between two snapshot dates.
 *
 * **A card must be priced on BOTH dates.** This is the load-bearing line. The
 * Signature printings went from unpriced to ~$952 the day the collector-number
 * parser was fixed; a naive "latest vs earliest available" comparison reports
 * that as the biggest rally in the game's history, when nothing moved at all —
 * only our reading of it did. Comparing fixed endpoints and dropping anything
 * missing from either means a data fix can never masquerade as a market event.
 *
 * The same reasoning is why this does NOT reuse LATEST_PRICES: that helper
 * deliberately falls back to a card's own last known price, which is right for
 * a deck total and wrong here, where an unchanged stale price would read as a
 * card that held its value.
 */
export async function topMovers(db, { from, to, direction = 'up', limit = 8, ...filters } = {}) {
  const { where, params } = cardFilterParts({ ...filters, priced: undefined });
  const extra = where.length ? `AND ${where.join(' AND ')}` : '';
  const order = direction === 'down' ? 'pct ASC' : 'pct DESC';

  const { results } = await db
    .prepare(
      `WITH a AS (SELECT card_id, market_price AS px FROM price_snapshots
                   WHERE date = ? AND market_price IS NOT NULL),
            b AS (SELECT card_id, market_price AS px FROM price_snapshots
                   WHERE date = ? AND market_price IS NOT NULL)
       SELECT c.id, c.name, c.public_code, c.set_id, c.collector_number,
              c.variant, c.rarity, c.card_type, c.faction,
              c.image_thumb_url, c.image_large_url,
              s.name AS set_name,
              a.px AS old_price, b.px AS new_price,
              (b.px - a.px) AS delta,
              (b.px - a.px) / a.px AS pct
         FROM a
         JOIN b ON b.card_id = a.card_id
         JOIN cards c ON c.id = a.card_id
         LEFT JOIN sets s ON s.id = c.set_id
        WHERE a.px >= ${MOVER_FLOOR} AND b.px <> a.px ${extra}
        ORDER BY ${order}, c.name ASC
        LIMIT ?`,
    )
    .bind(from, to, ...params, limit)
    .all();
  return results ?? [];
}
