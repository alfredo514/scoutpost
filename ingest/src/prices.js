/**
 * Daily price ingestion — TCGCSV (unofficial TCGplayer mirror).
 *
 * Verified API shape (checked against the live endpoints):
 *   GET https://tcgcsv.com/tcgplayer/categories
 *     → { totalItems, success, errors, results:[{ categoryId, name, ... }] }
 *     → Riftbound is categoryId 89.
 *   GET https://tcgcsv.com/tcgplayer/89/groups
 *     → results:[{ groupId, name, abbreviation, publishedOn, categoryId }]
 *     → `abbreviation` ('VEN') is the join key to Riftscribe's set_id.
 *   GET https://tcgcsv.com/tcgplayer/89/{groupId}/products
 *     → results:[{ productId, name, imageUrl, extendedData:[{name,value}] }]
 *     → Sealed product has extendedData: []. Singles carry
 *       { name:'Number', value:'021/166' } and { name:'Rarity', value:'Epic' }.
 *   GET https://tcgcsv.com/tcgplayer/89/{groupId}/prices
 *     → results:[{ productId, lowPrice, midPrice, highPrice, marketPrice,
 *                  directLowPrice, subTypeName }]
 *     → subTypeName is 'Normal' | 'Foil'.
 *
 * Content updates daily around 20:00 UTC. This is one person's unofficial
 * mirror with no uptime guarantee, so every gate below fails the run closed:
 * we would rather record no prices for a day than wrong prices.
 */

import {
  IngestError,
  fetchJson,
  log,
  money,
  runBatched,
  utcDate,
  warn,
} from './util.js';
import { PROMO_GROUPS } from './promos.js';

const BASE = 'https://tcgcsv.com/tcgplayer';
const CATEGORY_ID = 89; // Riftbound: League of Legends Trading Card Game

// Absolute floor. A real run matches thousands of cards; anything this small
// means the feed or the matching broke.
const MIN_PRICE_ROWS = 50;
// Relative floor. If today yields dramatically fewer rows than the last good
// day, treat it as a broken feed rather than a real market event.
const MIN_RATIO_VS_LAST_GOOD = 0.6;

/** Unwrap and validate a TCGCSV envelope. */
function results(body, label) {
  if (!body || typeof body !== 'object') {
    throw new IngestError(`${label}: payload was not an object`);
  }
  if (body.success !== true) {
    throw new IngestError(`${label}: success flag was not true`, body.errors);
  }
  if (!Array.isArray(body.results)) {
    throw new IngestError(`${label}: results was not an array`);
  }
  return body.results;
}

/**
 * Parse a printed collector number into a comparable pair.
 *   '021/166'   → { number: 21,  variant: ''     }
 *   '021a/166'  → { number: 21,  variant: 'a'    }
 *   '223x/221'  → { number: 223, variant: 'star' }   (x here is an asterisk;
 *                  it cannot be written literally without ending this comment)
 *   'SP3/006'   → null  (promo/special numbering; reported, never guessed at)
 *
 * The asterisk is the Signature printing. TCGplayer marks it in the number and
 * calls the product "… (Signature)"; Riftscribe records the same card with
 * `variant: 'star'`. Mapping '*' to 'star' is what makes the two agree.
 *
 * This was missed originally: the regex accepted only digits and an optional
 * letter, so every Signature fell through to the unparseable bucket and 36
 * cards — the most expensive printings in the game — carried no price at all.
 * A collector number ABOVE the set size is normal for these; do not "fix" that.
 */
export function parseCollectorNumber(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)([a-z]|\*)?\s*\/\s*\d+$/i.exec(value.trim());
  if (!m) return null;
  const number = Number.parseInt(m[1], 10);
  if (!Number.isInteger(number)) return null;
  const mark = m[2] || '';
  return { number, variant: mark === '*' ? 'star' : mark.toLowerCase() };
}

/** TCGplayer publishes numeric extendedData as strings; '' and absent are null. */
function intOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isInteger(n) ? n : null;
}

function extended(product, field) {
  if (!Array.isArray(product.extendedData)) return null;
  const hit = product.extendedData.find((d) => d && d.name === field);
  return hit && typeof hit.value === 'string' ? hit.value : null;
}

/** Fetch the Riftbound set list, keyed by abbreviation. */
export async function fetchGroups() {
  const body = await fetchJson(`${BASE}/${CATEGORY_ID}/groups`, { label: 'tcgcsv groups' });
  const rows = results(body, 'tcgcsv groups');

  const groups = [];
  for (const g of rows) {
    if (!g || !Number.isInteger(g.groupId)) continue;
    if (typeof g.abbreviation !== 'string' || !g.abbreviation.trim()) continue;
    groups.push({
      groupId: g.groupId,
      name: typeof g.name === 'string' ? g.name : String(g.groupId),
      abbreviation: g.abbreviation.trim().toUpperCase(),
      releaseDate:
        typeof g.publishedOn === 'string' ? g.publishedOn.slice(0, 10) : null,
    });
  }

  if (groups.length === 0) throw new IngestError('tcgcsv groups: no usable sets returned');
  log(`prices: ${groups.length} TCGplayer set groups`);
  return groups;
}

/**
 * Build the day's price rows in memory. Writes nothing.
 * Returns { rows, matched, unmatched, productLinks }.
 */
export async function collectPrices(db, groups) {
  // Index the local catalogue once: 'SET|number|variant' → card row.
  const { results: cards } = await db
    .prepare('SELECT id, set_id, collector_number, variant, finish, tcgcsv_product_id FROM cards')
    .all();

  if (!cards || cards.length === 0) {
    throw new IngestError('no cards in the catalogue — run the catalog job first');
  }

  const index = new Map();
  for (const c of cards) {
    const key = `${c.set_id}|${c.collector_number}|${(c.variant ?? '').toLowerCase()}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(c);
  }

  /* Promos are matched by product id, never by number.
   *
   * A promo prints its ORIGINAL set's collector number — "Viktor, Leader" in
   * OPP is `246/298`, and 298 is Origins' set size. Two products in one promo
   * group can even share a number (a promo and its Metal version). The number
   * therefore identifies nothing here; the product id is unique and stable,
   * and promo card ids are built from it. See promos.js. */
  const byProduct = new Map();
  for (const c of cards) {
    if (Number.isInteger(c.tcgcsv_product_id)) byProduct.set(c.tcgcsv_product_id, c);
  }

  const date = utcDate();
  const rows = new Map(); // card_id → row (dedupe: one row per card per day)
  const productLinks = []; // [cardId, productId] pairs to backfill cards
  let unmatched = 0;
  let specialNumbering = 0;
  const cardText = new Map();

  for (const group of groups) {
    let products;
    let prices;

    try {
      products = results(
        await fetchJson(`${BASE}/${CATEGORY_ID}/${group.groupId}/products`, {
          label: `tcgcsv products ${group.abbreviation}`,
        }),
        `tcgcsv products ${group.abbreviation}`,
      );
      prices = results(
        await fetchJson(`${BASE}/${CATEGORY_ID}/${group.groupId}/prices`, {
          label: `tcgcsv prices ${group.abbreviation}`,
        }),
        `tcgcsv prices ${group.abbreviation}`,
      );
    } catch (e) {
      // One bad set should not sink the whole day, but it must be visible.
      warn(`prices: skipping set ${group.abbreviation} — ${e.message}`);
      continue;
    }

    // productId → { Normal: {...}, Foil: {...} }
    const priceByProduct = new Map();
    for (const p of prices) {
      if (!p || !Number.isInteger(p.productId)) continue;
      const subtype = typeof p.subTypeName === 'string' ? p.subTypeName : 'Normal';
      if (!priceByProduct.has(p.productId)) priceByProduct.set(p.productId, {});
      priceByProduct.get(p.productId)[subtype] = {
        market: money(p.marketPrice),
        low: money(p.lowPrice),
      };
    }

    for (const product of products) {
      if (!product || !Number.isInteger(product.productId)) continue;

      const printed = extended(product, 'Number');
      if (!printed) continue; // sealed product — not a single, skip silently

      let candidates;

      if (PROMO_GROUPS.has(group.abbreviation)) {
        // The number is meaningless in a promo group; the product id is not.
        const card = byProduct.get(product.productId);
        if (!card) {
          unmatched++;
          continue;
        }
        candidates = [card];
      } else {
        const parsed = parseCollectorNumber(printed);
        if (!parsed) {
          specialNumbering++; // e.g. 'SP3/006' promo numbering
          continue;
        }

        const key = `${group.abbreviation}|${parsed.number}|${parsed.variant}`;
        candidates = index.get(key);
        if (!candidates || candidates.length === 0) {
          unmatched++;
          continue;
        }
      }

      // Card text first, and OUTSIDE the price guards below. A card with no
      // price row today still has printed rules, and gating the text on a
      // price would leave those cards blank for no reason.
      for (const card of candidates) {
        cardText.set(card.id, {
          card_id: card.id,
          energy_cost: intOrNull(extended(product, 'Energy Cost')),
          power_cost: intOrNull(extended(product, 'Power Cost')),
          might: intOrNull(extended(product, 'Might')),
          type_line: extended(product, 'Card Type'),
          tags: extended(product, 'Tag'),
          domain: extended(product, 'Domain'),
          rules_text: extended(product, 'Description'),
          flavor_text: extended(product, 'Flavor Text'),
        });
      }

      const subtypes = priceByProduct.get(product.productId);
      if (!subtypes) continue; // product exists but had no price row today

      for (const card of candidates) {
        // Prefer the printing that matches the card's finish, but fall back to
        // whatever subtype TCGplayer actually lists. This matters more than it
        // looks: in Riftbound, rares and epics are sold FOIL-ONLY — those
        // products have a 'Foil' row and no 'Normal' row at all. Falling back
        // only to 'Normal' silently dropped ~97% of rares and epics, which are
        // exactly the cards that dominate a deck's build cost.
        const wanted = card.finish === 'foil' ? 'Foil' : 'Normal';
        const price =
          subtypes[wanted] ??
          subtypes.Normal ??
          subtypes.Foil ??
          Object.values(subtypes)[0] ??
          null;
        if (!price) continue;
        if (price.market === null && price.low === null) continue; // nothing usable

        rows.set(card.id, {
          card_id: card.id,
          date,
          market_price: price.market,
          low_price: price.low,
        });
        productLinks.push([card.id, product.productId]);
      }
    }
  }

  if (specialNumbering > 0) {
    log(`prices: ${specialNumbering} product(s) used promo/special numbering (not matched)`);
  }
  if (unmatched > 0) {
    log(`prices: ${unmatched} single(s) had no matching catalogue card`);
  }

  return { rows: [...rows.values()], date, unmatched, productLinks, cardText: [...cardText.values()] };
}

/** How many rows did the last day with data produce? Used as a sanity floor. */
async function lastGoodRowCount(db, today) {
  const row = await db
    .prepare(
      `SELECT date, COUNT(*) AS n
         FROM price_snapshots
        WHERE date < ?
        GROUP BY date
        ORDER BY date DESC
        LIMIT 1`,
    )
    .bind(today)
    .first();
  return row ? Number(row.n) : 0;
}

/**
 * Validate the day's rows against absolute and relative floors, then write.
 * Throws (skipping the day entirely) rather than writing a suspect dataset.
 */
/**
 * How far back "latest price per card" is allowed to look.
 *
 * **This no longer costs anything per page.** Before card_latest_price existed
 * the window sized a scan that ran on every query, so shrinking it was the only
 * lever on read cost. Now it sizes only the once-nightly rebuild: at a full 30
 * days that is ~40,000 price rows, about 120k rows read once a day, against a
 * 5M daily allowance. It was briefly cut to 10 during the incident on
 * 2026-09-01 and restored the same day, because the reason for cutting it had
 * been removed.
 *
 * So this is a DATA question again, not a cost one: how long may a card keep
 * quoting its last known price before it reads as unpriced? Thirty days is
 * generous for a feed that publishes daily, and the pages show how many cards
 * are priced, so an honest gap stays visible where a stale figure would quietly
 * look current.
 */
const PRICE_WINDOW_DAYS = 30;

/**
 * Rebuild `card_latest_price` — one row per card, its newest price inside the
 * window.
 *
 * This is why the site is affordable. Computing this per query with a window
 * function cost 39,939 rows read EACH TIME, six times per /rankings render, and
 * grew every night as history accumulated; it reached 91% of D1's 5M/day free
 * allowance. Doing it once a night costs the same scan once.
 *
 * DELETE then INSERT rather than an upsert, deliberately: a card whose last
 * price has aged out of the window must DISAPPEAR from this table, and an
 * upsert would leave the stale row behind forever. Two statements, batched so
 * they land together — a half-applied rebuild would blank every price on the
 * site.
 *
 * Derived data. price_snapshots stays the source of truth and this can be
 * rebuilt from it at any time.
 */
export async function rebuildLatestPrices(db) {
  await db.batch([
    db.prepare('DELETE FROM card_latest_price'),
    db.prepare(
      `INSERT INTO card_latest_price (card_id, market_price, low_price, date, updated_at)
       SELECT card_id, market_price, low_price, date, datetime('now')
         FROM (
           SELECT card_id, market_price, low_price, date,
                  ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY date DESC) AS rn
             FROM price_snapshots
            WHERE date >= date((SELECT MAX(date) FROM price_snapshots),
                               '-${PRICE_WINDOW_DAYS} day')
         )
        WHERE rn = 1`,
    ),
  ]);

  const row = await db.prepare('SELECT COUNT(*) AS n FROM card_latest_price').first();
  const n = row?.n ?? 0;
  log(`prices: card_latest_price rebuilt — ${n} cards`);
  return n;
}

export async function writePrices(db, { rows, date }) {
  if (rows.length < MIN_PRICE_ROWS) {
    throw new IngestError(
      `refusing to write: only ${rows.length} price rows, floor is ${MIN_PRICE_ROWS}`,
    );
  }

  const previous = await lastGoodRowCount(db, date);
  if (previous > 0 && rows.length < previous * MIN_RATIO_VS_LAST_GOOD) {
    throw new IngestError(
      `refusing to write: ${rows.length} rows is under ${Math.round(
        MIN_RATIO_VS_LAST_GOOD * 100,
      )}% of the last good day (${previous}). Treating as a broken feed.`,
    );
  }

  // Append-only: one row per card per day. Re-running the same day with data
  // that has passed every gate above refreshes it; a failed run never gets here.
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO price_snapshots (card_id, date, market_price, low_price, source)
         VALUES (?, ?, ?, ?, 'tcgcsv')
         ON CONFLICT(card_id, date) DO UPDATE SET
           market_price = excluded.market_price,
           low_price    = excluded.low_price`,
      )
      .bind(r.card_id, r.date, r.market_price, r.low_price),
  );

  const written = await runBatched(db, stmts);
  log(`prices: wrote ${written} snapshots for ${date} (previous good day: ${previous})`);
  return written;
}

/** Backfill cards.tcgcsv_product_id so card pages can link out to TCGplayer. */
export async function writeProductLinks(db, productLinks) {
  if (!productLinks.length) return 0;
  const unique = new Map(productLinks); // card_id → productId
  const stmts = [...unique].map(([cardId, productId]) =>
    db
      .prepare('UPDATE cards SET tcgcsv_product_id = ? WHERE id = ? AND tcgcsv_product_id IS NULL')
      .bind(productId, cardId),
  );
  return runBatched(db, stmts);
}

/**
 * Recompute today's deck cost history.
 * This is a historical record for charting only — pages always recompute live.
 */
export async function snapshotDeckCosts(db, date) {
  const { results: decks } = await db.prepare('SELECT id FROM decks').all();
  if (!decks || decks.length === 0) return 0;

  const stmts = decks.map((d) =>
    db
      .prepare(
        `INSERT INTO deck_cost_snapshots (deck_id, date, total_cost, priced_cards, total_cards)
         SELECT
           dc.deck_id,
           ?,
           ROUND(SUM(COALESCE(p.market_price, 0) * dc.quantity), 2),
           SUM(CASE WHEN p.market_price IS NOT NULL THEN 1 ELSE 0 END),
           COUNT(*)
         FROM deck_cards dc
         LEFT JOIN (
           SELECT card_id, market_price
             FROM price_snapshots
            WHERE date = (SELECT MAX(date) FROM price_snapshots)
         ) p ON p.card_id = dc.card_id
         WHERE dc.deck_id = ?
         GROUP BY dc.deck_id
         ON CONFLICT(deck_id, date) DO UPDATE SET
           total_cost   = excluded.total_cost,
           priced_cards = excluded.priced_cards,
           total_cards  = excluded.total_cards`,
      )
      .bind(date, d.id),
  );

  const written = await runBatched(db, stmts);
  log(`deck costs: snapshotted ${written} deck(s) for ${date}`);
  return written;
}

/**
 * Write the printed card text.
 *
 * This is the ONLY source for rules and flavor text in the project. The
 * Riftscribe catalogue publishes none — a card record there carries ids, names,
 * type, faction, rarity, stats and image URLs and nothing more. TCGplayer's
 * extendedData carries Description, Flavor Text, Energy Cost, Power Cost,
 * Might, Card Type, Tag and Domain, and it comes free with the product walk the
 * price job already performs.
 *
 * Coverage measured 2026-08-28 across all 1,486 singles: 94% have Description,
 * 59% have Flavor Text. Cards below that are left without a row rather than
 * given an empty one, so the page can tell "no text published" from "no text
 * yet ingested".
 *
 * Text is upserted, not appended — unlike prices, it is not history.
 */
export async function writeCardText(db, rows) {
  const usable = rows.filter((r) => r.rules_text || r.flavor_text || r.energy_cost !== null);
  if (usable.length === 0) {
    warn('card text: nothing usable to write');
    return 0;
  }

  await runBatched(
    db,
    usable.map((r) =>
      db
        .prepare(
          `INSERT INTO card_text
             (card_id, energy_cost, power_cost, might, type_line, tags, domain,
              rules_text, flavor_text, source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tcgplayer', datetime('now'))
           ON CONFLICT(card_id) DO UPDATE SET
             energy_cost = excluded.energy_cost, power_cost = excluded.power_cost,
             might       = excluded.might,       type_line   = excluded.type_line,
             tags        = excluded.tags,        domain      = excluded.domain,
             rules_text  = excluded.rules_text,  flavor_text = excluded.flavor_text,
             updated_at  = datetime('now')`,
        )
        .bind(
          r.card_id,
          r.energy_cost,
          r.power_cost,
          r.might,
          r.type_line,
          r.tags,
          r.domain,
          r.rules_text,
          r.flavor_text,
        ),
    ),
  );

  log(`card text: wrote ${usable.length} card(s)`);
  return usable.length;
}
