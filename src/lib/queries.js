/**
 * D1 queries.
 *
 * Prices live ON the card row and deck costs live ON the deck row. Nothing here
 * computes a cost, and nothing here joins price_snapshots except the movers
 * board, which needs two specific dates rather than "the latest".
 *
 * This file's header used to say the opposite — that build cost is ALWAYS
 * computed at read time — and it stayed that way for a while after §26 reversed
 * it, which is the most misleading place in the repo for a stale claim to sit.
 * The reasoning it recorded is still worth keeping, and it still holds: the
 * price a deck is costed against is the most recent price PER CARD, not the
 * most recent overall, so a card that missed a day falls back to its own last
 * known price instead of dropping out of the total. That rule now lives in
 * rebuildLatestPrices() in ingest/src/prices.js, which runs nightly.
 *
 * `deck_cost_snapshots` is history for charting and no page reads a cost from
 * it.
 */

import {
  METAL_HIDDEN,
  METAL_ONLY,
  PRINTINGS,
  RARITY_RANK,
} from '../../shared/card-sql.js';

/**
 * Prices live ON the card row. There is no price join.
 *
 * The history behind this is worth keeping, because each step looked like the
 * answer at the time:
 *
 *   1. A window function over `price_snapshots`, per query. ~40,000 rows read
 *      each, growing nightly. Nearly took the site off the air (§25).
 *   2. A materialised `card_latest_price` table, joined per query. ~4,000 rows
 *      read each — 10x better, and still enough to burn 5M/day at about a
 *      hundred page views, because every query still walked 1,419 cards and
 *      1,349 prices and then sorted them.
 *   3. Here: `cards.market_price`, `cards.low_price`, `cards.price_date`,
 *      written nightly by the price job, with `idx_cards_price` on
 *      `market_price DESC`.
 *
 * The index is the part that matters. "Top 50 by price" was a full scan plus a
 * sort; it is now an index range read. **Measured: 4,034 rows read → 50.**
 *
 * Deck costs are precomputed the same way, onto `decks` — see the note on
 * listDecks. Both are derived data: `price_snapshots` and `deck_cards` remain
 * the source of truth and either can be rebuilt from them.
 */

/**
 * The Legend's art, for a deck listed among others.
 *
 * A Riftbound deck has exactly one Legend and players recognise a deck by it on
 * sight, so a list of decks reads far faster with the art than with the name
 * alone.
 *
 * **Reached by primary key, through `decks.legend_card_id`.** This used to walk
 * `deck_cards` for the deck and join `cards` on every row to find which of them
 * was the Legend — about 30 index entries plus 30 card lookups, twice (once per
 * rendition), for every deck row. Roughly 120 rows read per deck, ~7,700 for a
 * single listDecks, and it grew with both the deck count and the size of a
 * decklist. Now it is two primary-key lookups: about 2.
 *
 * `legend_card_id` is derived data, written by the nightly recompute in
 * ingest/src/deck-cost-sql.js. `deck_cards` remains the source of truth.
 *
 * An older comment here insisted these had to be correlated subqueries rather
 * than a join, because the surrounding queries aggregated over deck_cards with
 * GROUP BY and a second copy of that table would have multiplied what the
 * aggregates were summing. That was true and is not any more — §26 moved those
 * costs onto the deck row and neither caller has a GROUP BY left. Kept as
 * subqueries only because it makes this a drop-in string; a LEFT JOIN would now
 * be equally correct.
 */
const LEGEND_ART = `
  (SELECT cl.image_thumb_url FROM cards cl WHERE cl.id = d.legend_card_id) AS legend_thumb_url,
  (SELECT cl.image_large_url FROM cards cl WHERE cl.id = d.legend_card_id) AS legend_large_url`;

export async function latestPriceDate(db) {
  const row = await db.prepare('SELECT MAX(date) AS d FROM price_snapshots').first();
  return row?.d ?? null;
}

/**
 * Events, newest first, each with the cost spread across its top 8.
 *
 * `era` filters to the set that was legal when the event was played. It is
 * derived from dates, not stored, so a new set needs no migration.
 *
 * Reads `decks.total_cost`, which the price job writes nightly — it does not
 * aggregate deck_cards. That aggregation cost ~4,170 rows read per view; this
 * reads 79.
 *
 * `era` moved from HAVING to WHERE. It was in a HAVING only because the query
 * needed a GROUP BY to aggregate; with the costs already stored there is
 * nothing to group, and EVENT_ERA is a correlated subquery that works fine as
 * a WHERE predicate.
 */
export async function listEvents(db, { limit = 50, era = '' } = {}) {
  const filter = era ? `WHERE ${EVENT_ERA} = ?` : '';
  const params = era ? [era, limit] : [limit];
  const { results } = await db
    .prepare(
      `SELECT e.*,
              ${EVENT_ERA} AS era,
              (SELECT COUNT(*)        FROM decks d WHERE d.event_id = e.id) AS deck_count,
              (SELECT MAX(total_cost) FROM decks d WHERE d.event_id = e.id) AS max_cost,
              (SELECT MIN(total_cost) FROM decks d WHERE d.event_id = e.id) AS min_cost
         FROM events e
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
      `SELECT d.id, d.placement, d.player_name, d.legend, d.notes,
              ${LEGEND_ART},
              d.total_cost, d.main_cost, d.side_cost,
              d.main_count, d.side_count, d.card_count,
              d.distinct_cards, d.priced_cards
         FROM decks d
        WHERE d.event_id = ?
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

/**
 * The rest of the top 8 this deck was part of, plus how many other decks share
 * its Legend.
 *
 * Reading a top 8 meant going back to the event page between every deck. This
 * is deliberately the WHOLE placement list rather than just the two neighbours:
 * one query either way, and it lets a reader jump straight to 7th instead of
 * clicking "next" five times.
 *
 * No costs and no card counts — this is navigation, and pricing every deck in
 * the event to render a row of links would multiply the page's read cost for
 * numbers nobody reads here.
 */
export async function deckSiblings(db, { eventId, deckId, legend }) {
  const [siblings, sameLegend] = await Promise.all([
    db
      .prepare(
        `SELECT d.id, d.placement, d.legend, d.player_name
           FROM decks d
          WHERE d.event_id = ?
          ORDER BY d.placement ASC`,
      )
      .bind(eventId)
      .all(),
    legend
      ? db
          .prepare('SELECT COUNT(*) AS n FROM decks WHERE legend = ? AND id <> ?')
          .bind(legend, deckId)
          .first()
      : Promise.resolve({ n: 0 }),
  ]);

  return { siblings: siblings.results ?? [], sameLegend: sameLegend?.n ?? 0 };
}

/** Every card in a deck with its current price and line total. */
export async function getDeckCards(db, deckId) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.set_id, c.collector_number, c.public_code,
              c.rarity, c.card_type, c.image_thumb_url, c.image_large_url,
              c.tcgcsv_product_id,
              dc.quantity, dc.section,
              c.market_price, c.low_price, c.price_date,
              ROUND(COALESCE(c.market_price, 0) * dc.quantity, 2) AS line_total
         FROM deck_cards dc
         JOIN cards c ON c.id = dc.card_id
        WHERE dc.deck_id = ?
        ORDER BY dc.section ASC, line_total DESC, c.name ASC`,
    )
    .bind(deckId)
    .all();
  return results ?? [];
}

/**
 * Decks across all events, newest event first — powers /decks.
 *
 * A deck's era is its parent event's era, so the same date-derived rule applies
 * and no deck carries a stored set tag.
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
  // era is a correlated subquery, so it belongs in the WHERE with everything
  // else now that there is no aggregate to group by.
  if (era) {
    where.push(`${EVENT_ERA} = ?`);
    params.push(era);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);

  const { results } = await db
    .prepare(
      `SELECT d.id, d.placement, d.player_name, d.legend,
              e.id AS event_slug, e.name AS event_name, e.date AS event_date,
              ${EVENT_ERA} AS era,
              ${LEGEND_ART},
              d.total_cost, d.card_count
         FROM decks d
         JOIN events e ON e.id = d.event_id
         ${clause}
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
 * Drives the avatar row on /decks. The art is taken from whichever deck sorts
 * first for that Legend — every deck running a Legend runs the same card, so
 * any of them is the right picture.
 *
 * Counts respect the set filter, so the row never offers a Legend that would
 * return an empty table in the era being viewed.
 *
 * **Group first, then fetch the art.** This used to join `deck_cards` and
 * `cards` for EVERY deck and rank the result — a full scan of `deck_cards`
 * plus three index lookups per row, about 8,800 rows read on every /decks
 * view. That made it several times more expensive than everything else on the
 * page put together (`listDecks` reads 192, §26) and it grew with every deck
 * imported, which is exactly the shape §25 and §26 were about.
 *
 * Now the window functions run over `decks` alone — 64 rows — and the art is a
 * correlated subquery on the ~10 winning decks, the same LEGEND_ART pattern
 * used above and served by `idx_deck_cards_deck`.
 *
 * One deliberate change of meaning: `n` counts DECKS, where before it counted
 * matching deck_cards rows. Those differ only if a deck somehow held two
 * Legend rows, and the label the count feeds — "N decks" — always meant decks.
 */
export async function legendFacets(db, { era = '' } = {}) {
  const having = era ? 'WHERE era = ?' : '';
  const params = era ? [era] : [];
  const { results } = await db
    .prepare(
      `WITH per_deck AS (
         SELECT d.legend, d.id AS deck_id, d.legend_card_id, ${EVENT_ERA} AS era
           FROM decks d
           JOIN events e ON e.id = d.event_id
       ),
       scoped AS (SELECT * FROM per_deck ${having}),
       ranked AS (
         SELECT legend, deck_id, legend_card_id,
                ROW_NUMBER() OVER (PARTITION BY legend ORDER BY deck_id) AS rn,
                COUNT(*) OVER (PARTITION BY legend) AS n
           FROM scoped
       )
       SELECT r.legend,
              (SELECT cl.image_thumb_url FROM cards cl WHERE cl.id = r.legend_card_id) AS thumb,
              r.n
         FROM ranked r
        WHERE r.rn = 1 AND r.legend IS NOT NULL AND r.legend <> ''
        ORDER BY r.n DESC, r.legend ASC`,
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
    // SUM over `sets`, not COUNT over `cards`: eight rows instead of 1,419 for
    // the same number, because sets.card_count is already maintained nightly
    // for EVENT_ERA. Measured 1,419 -> 8. The events and decks counts stay as
    // they are; those tables are small and there is nothing to read them from.
    db.prepare('SELECT COALESCE(SUM(card_count), 0) AS n FROM sets').first(),
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
 * Metal prize cards — see shared/card-sql.js for what they are and why they
 * are hidden by default.
 *
 * The definition is a name match, because the product name is the only signal
 * TCGplayer gives. But a query must never RUN that match: `LIKE '%(Metal)%'`
 * begins with a wildcard, so no index can serve it and it is a guaranteed full
 * scan — and /rankings applied it to every query it ran, by default, on every
 * view. The name test now happens once a night to set `cards.is_metal`, and
 * queries filter on the column. Measured: metalCount 1,419 rows -> 68.
 */
const METAL_MARKER = METAL_HIDDEN;

function cardFilterParts({ type, color, set, rarity, printing, q, priced, metal }) {
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
  if (priced === 'yes') where.push('c.market_price IS NOT NULL');
  if (priced === 'no') where.push('c.market_price IS NULL');
  // Opt-in: absent means no condition, so /cards is unaffected and still shows
  // every card. Only /rankings asks for this, and it asks on every request.
  if (metal === 'hide') where.push(METAL_MARKER);

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
/**
 * Unpriced cards sort last — a card with no price is unknown, not free.
 *
 * **Written as NULLS LAST, never as a CASE.** It used to be
 * `CASE WHEN c.market_price IS NULL THEN 1 ELSE 0 END` as the first sort key,
 * and because that is an EXPRESSION rather than a column, it made
 * `idx_cards_price` unusable: every sorted listing became a full scan plus a
 * temp B-tree. Measured on the default /cards view: **2,838 rows read, against
 * 50 for the same query ordered on the bare column.**
 *
 * On DESC it is not even needed — SQLite orders NULL below every value, so
 * `market_price DESC` already puts unpriced cards last on its own. It is only
 * ASC that needs saying, and NULLS LAST says it without hiding the column from
 * the planner.
 *
 * The rule this is an instance of: an ORDER BY that wraps an indexed column in
 * an expression throws the index away. Same for a WHERE.
 */
const UNPRICED_LAST_ASC = 'c.market_price ASC NULLS LAST';

const CARD_SORTS = {
  // No CASE and no NULLS clause: DESC already puts unpriced last, and the bare
  // column lets idx_cards_price serve the whole thing.
  price: 'c.market_price DESC, c.name ASC',
  'price-asc': `${UNPRICED_LAST_ASC}, c.name ASC`,
  name: 'c.name ASC, s.release_date DESC',
  'name-desc': 'c.name DESC, s.release_date DESC',
  set: 's.release_date DESC, c.collector_number ASC, c.variant ASC',
  'set-asc': 's.release_date ASC, c.collector_number ASC, c.variant ASC',
  rarity: `${RARITY_RANK} DESC, c.market_price DESC`,
  'rarity-asc': `${RARITY_RANK} ASC, c.name ASC`,
};

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
export async function listCards(db, { sort = 'price', limit = 50, offset = 0, ...filters } = {}) {
  const { clause, params } = cardFilterSql(filters);
  const order = CARD_SORTS[sort] ?? CARD_SORTS.price;
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.public_code, c.set_id, c.collector_number,
              c.rarity, c.card_type, c.faction,
              c.image_thumb_url, c.image_large_url,
              s.name AS set_name,
              c.market_price
         FROM cards c
         LEFT JOIN sets s ON s.id = c.set_id
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
 * No join. Every condition `cardFilterParts` can produce reads a column on
 * `cards` — including `priced`, which now tests `c.market_price` on the row
 * itself (§26). The `LEFT JOIN sets` that used to be here was left over from
 * when `listCards` and this shared a FROM clause; it changed no result and cost
 * an index lookup per card, 1,419 of them on every /cards view.
 *
 * If a filter ever needs a column from `sets`, the join comes back here AND in
 * `listCards` together — counting against a different FROM clause than the
 * listing uses is how a pager ends up disagreeing with its own results.
 */
export async function countCards(db, filters = {}) {
  const { clause, params } = cardFilterSql(filters);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM cards c
        ${clause}`,
    )
    .bind(...params)
    .first();
  return row?.n ?? 0;
}

/**
 * Facet counts, so a filter button can say how much is behind it.
 *
 * **One read of `card_facets`, ~30 rows.** This was four separate GROUP BY
 * queries over the whole catalogue — 11,369 rows read, measured — running on
 * every /cards AND every /rankings view, to render a row of chips whose numbers
 * change once a night. The counts are now written by the catalog job; see
 * ingest/src/facets-sql.js.
 *
 * Ordering comes from the stored `position` rather than being re-derived here,
 * so the rule for each kind — types and colours by size, sets newest first,
 * rarities by scarcity — lives in exactly one place: the rebuild.
 */
export async function cardFacets(db) {
  const { results } = await db
    .prepare(
      `SELECT kind, value AS v, label, n FROM card_facets
        WHERE kind IN ('type', 'faction', 'set', 'rarity')
        ORDER BY kind, position`,
    )
    .all();

  const rows = results ?? [];
  const of = (kind) => rows.filter((r) => r.kind === kind).map(({ v, label, n }) => ({ v, label, n }));

  return {
    types: of('type'),
    colors: of('faction'),
    sets: of('set'),
    rarities: of('rarity'),
  };
}

/**
 * How many cards fall in each printing group.
 *
 * Four rows out of `card_facets`, against a 1,419-row scan before. It was
 * already down to one query rather than four round trips; the remaining cost
 * was that the query still counted the whole catalogue on every view.
 *
 * Order still comes from PRINTINGS — the rebuild numbers the rows from that
 * object, so adding a group there needs no change here or in the read.
 */
export async function printingFacets(db) {
  const { results } = await db
    .prepare(
      "SELECT value AS v, n FROM card_facets WHERE kind = 'printing' ORDER BY position",
    )
    .all();
  return results ?? [];
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
 *
 * **Two conditions, both load-bearing, because a TCGplayer group is not the
 * same thing as a format.** The set list comes from TCGCSV's groups, which
 * carry more than the sets people play:
 *
 * - `release_date <= today` — TCGCSV lists sets that have been ANNOUNCED but
 *   not released. On 2026-09-08 those were Radiance (2026-10-23) and Legacy
 *   (2027-01-29), both with zero cards. Without this, `eras[0]` was Legacy, and
 *   since /events and /decks default to the newest era (DEFAULT_ERA) both pages
 *   opened on an empty table five months before that set exists.
 * - `cards > 0` — a group can be a sealed-product line rather than a set.
 *   "Riftbound Bundles" is one, and it has no singles at all.
 *
 * The same reasoning applies to EVENT_ERA below; the two must agree, or the
 * filter bar offers an era that the events themselves are never assigned to.
 */
export async function setEras(db) {
  const { results } = await db
    .prepare(
      // s.card_count, not COUNT(c.id) over a join to cards: this ran on every
      // /events and /decks view and read all 1,419 card rows to produce nine
      // numbers that only change when the catalogue does. See EVENT_ERA below.
      `SELECT s.id, s.name, s.release_date, s.card_count AS cards
         FROM sets s
        WHERE s.release_date IS NOT NULL
          AND s.release_date <= date('now')
          AND s.card_count > 0
        ORDER BY s.release_date DESC, s.card_count DESC`,
    )
    .all();

  const byDate = new Map();
  for (const row of results ?? []) if (!byDate.has(row.release_date)) byDate.set(row.release_date, row);
  return [...byDate.values()];
}

/**
 * Which era an event falls in: the most recent set released on or before it.
 * Expressed as SQL so it can be both selected and filtered on.
 *
 * `card_count > 0` excludes groups that carry no singles, and it has to be a
 * WHERE condition rather than only a tiebreak. The ordering below breaks ties
 * between sets sharing a release DATE; it does nothing about a card-less group
 * released a day LATER, which simply wins. That is not hypothetical —
 * "Riftbound Bundles" is published as 2026-08-01, one day after Vendetta, so
 * every event from August onwards was being filed under a sealed-product line
 * instead of the format that was actually legal.
 *
 * **`s.card_count` is a COLUMN, and it must stay one.** This read
 * `(SELECT COUNT(*) FROM cards WHERE set_id = s.id)`, which looks harmless and
 * is not: this whole expression is a correlated subquery evaluated ONCE PER
 * ROW, so that count re-counted every card in every candidate set for every
 * deck and every event. Measured by plan: ~1,419 rows read per row, ~90,000 for
 * deckEraCounts alone and the same again for listDecks — about 180,000 rows for
 * one /decks view, which is 28 page views to the whole daily free tier. It cost
 * two outages before it was found, on 2026-09-08 and 2026-09-09.
 *
 * The general rule, which is §26 restated: an expression inside EVENT_ERA is
 * paid for once per row of whatever query embeds it. Nothing that touches
 * another table belongs in here.
 *
 * Must stay in step with setEras() above, which applies the same two rules.
 */
const EVENT_ERA = `
  (SELECT s.id FROM sets s
    WHERE s.release_date <= e.date
      AND s.card_count > 0
    ORDER BY s.release_date DESC, s.card_count DESC
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
      `SELECT c.*, s.name AS set_name, s.release_date,
              t.energy_cost, t.power_cost, t.might, t.type_line,
              t.tags, t.domain, t.rules_text, t.flavor_text
         FROM cards c
         LEFT JOIN sets s ON s.id = c.set_id
         LEFT JOIN card_text t ON t.card_id = c.id
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
      `SELECT c.id, c.name, c.public_code, c.set_id, c.collector_number,
              c.variant, c.rarity, c.card_type, c.faction,
              c.image_thumb_url, c.image_large_url,
              s.name AS set_name,
              c.market_price, c.price_date
         FROM cards c
         LEFT JOIN sets s ON s.id = c.set_id
         ${clause}
        ORDER BY c.market_price DESC, c.name ASC
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

  const agg = await db
    .prepare(
      `SELECT COUNT(*) AS cards,
              SUM(CASE WHEN c.market_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(c.market_price) AS total,
              MAX(c.market_price) AS top,
              SUM(CASE WHEN c.market_price >= 50 THEN 1 ELSE 0 END) AS over50
         FROM cards c
         ${totals.clause}`,
    )
    .bind(...totals.params)
    .first();

  return {
    cards: agg?.cards ?? 0,
    priced: agg?.priced ?? 0,
    total: agg?.total ?? 0,
    top: agg?.top ?? null,
    over50: agg?.over50 ?? 0,
    median: await medianPrice(db, middle, Number(agg?.priced ?? 0)),
  };
}

/**
 * The median price of a filtered slice.
 *
 * SQLite has no median, so this walks `idx_cards_price` to the middle and stops.
 *
 * **It used to build the whole sorted list to read one row out of it.** The old
 * shape was `ROW_NUMBER() OVER (ORDER BY market_price)` plus
 * `COUNT(*) OVER ()`, which numbered every priced card, stamped the total onto
 * every row, and then discarded all but the middle one or two. Both window
 * functions have to see every row before they can emit any, so it materialised
 * and sorted the entire slice every time: **8,056 rows read, 84% of what
 * /rankings cost.** Reaching the middle of an index that is already sorted
 * reads about the offset itself.
 *
 * The count comes from the caller rather than being recomputed here — the
 * aggregate query above has already counted the priced rows, and asking twice
 * cost 2,800 rows for a number we were holding. That is why marketStats now
 * awaits the aggregate before this instead of running both together: one extra
 * round trip against several thousand rows saved, on a page cached for half an
 * hour.
 *
 * `LIMIT 2 - (n % 2)` is the whole even/odd rule. An odd count has one middle
 * value and takes 1; an even count straddles two and takes both, which AVG then
 * averages. AVG of a single row is that row, so one expression covers both.
 *
 * Returns null for an empty slice — a filter can legitimately match no priced
 * card, and OFFSET -1 is not a question worth asking.
 */
async function medianPrice(db, filter, pricedCount) {
  if (!pricedCount || pricedCount < 1) return null;

  const limit = 2 - (pricedCount % 2);
  const offset = Math.floor((pricedCount - 1) / 2);

  const row = await db
    .prepare(
      `SELECT AVG(px) AS median FROM (
         SELECT c.market_price AS px
           FROM cards c
           ${filter.clause}
          ORDER BY c.market_price
          LIMIT ? OFFSET ?
       )`,
    )
    .bind(...filter.params, limit, offset)
    .first();

  return row?.median ?? null;
}

/**
 * How many priced Metal cards the current slice is hiding.
 *
 * Only used to put a number on the "Shown" chip, so the reader can see what
 * the default is costing them before they click it.
 */
export async function metalCount(db, filters = {}) {
  const { where, params } = cardFilterParts({ ...filters, metal: undefined, priced: 'yes' });
  const clause = [...where, METAL_ONLY].join(' AND ');
  // No join, for the same reason as countCards: nothing here reads `sets`.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM cards c
        WHERE ${clause}`,
    )
    .bind(...params)
    .first();
  return row?.n ?? 0;
}

/**
 * Every set, ranked by how much of the catalogue's value sits in it.
 *
 * **Read straight off `sets`, ~16 rows.** The history here is three rounds of
 * the same lesson:
 *
 *   1. Two correlated lookups per set, each re-scanning the catalogue: 28,762
 *      rows read.
 *   2. A ROW_NUMBER partition over every card, which was better and measured
 *      23,025 on 2026-08-28 — then 7,127 once prices moved onto the card row.
 *   3. Here: three columns the price job writes, plus one primary-key lookup
 *      for the top card's name.
 *
 * Step 2 is the trap §26 names — a big win on a query that still scans the
 * whole table is not a fix. Ask what the query would read if it were perfect.
 * This board shows eight rows; it should read about eight rows.
 *
 * `WHERE card_count > 0` keeps card-less TCGplayer product groups off the
 * board, the same rule setEras and EVENT_ERA apply.
 */
export async function setValueTable(db) {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.release_date,
              s.card_count   AS cards,
              s.priced_count AS priced,
              s.total_value  AS total,
              s.top_card_id  AS top_id,
              c.name         AS top_name,
              c.market_price AS top_price
         FROM sets s
         LEFT JOIN cards c ON c.id = s.top_card_id
        WHERE s.card_count > 0
        ORDER BY s.total_value DESC`,
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
 * The same reasoning is why this does NOT read `cards.market_price` like every
 * other query here: that column deliberately carries a card's own last known
 * price within the 30-day window, which is right for a deck total and wrong
 * here, where an unchanged stale price would read as a card that held its
 * value. This is the one place price_snapshots is still read directly.
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
