/**
 * Build a local D1 database that looks like production.
 *
 * WHY THIS EXISTS
 *
 * `npm run dev` used to run `wrangler dev --remote`, which points the local
 * server at the PRODUCTION D1. Every page you loaded while developing spent
 * real quota, and a normal afternoon of before/after testing was enough to
 * exhaust the 5,000,000 rows/day free tier twice — see §25 and §26. Local
 * development should not be able to take the live site down.
 *
 * So `npm run dev` is now local-only, and this fills the local database.
 *
 * WHERE THE DATA COMES FROM
 *
 * The same public APIs the ingest Worker uses, and the event JSON already in
 * this repo. It **never reads production D1** — that is the whole point, and
 * it is why this is a fetch script rather than an export.
 *
 *   Riftscribe   the 1,180-card catalogue
 *   TCGCSV       promo cards, and today's prices
 *   data/events  the decklists
 *
 * The prices are one day's snapshot rather than a history. That is enough for
 * every page to render and for costs to be non-zero; it is not enough for the
 * movers board, which needs two dates and will correctly show "not enough
 * history yet" (§18). If you are working on movers, add a second day by hand.
 *
 * USAGE
 *
 *   npm run seed:local     builds build/seed.sql and applies it locally
 *   npm run dev            serves against that local database
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The one definition of the nightly deck-cost recompute. Imported rather than
// copied so the local database can never price a deck differently from the
// live site — see the note in that file.
import { DECK_COST_SQL } from '../ingest/src/deck-cost-sql.js';
import { CATALOG_REBUILD_SQL, PRICE_REBUILD_SQL } from '../ingest/src/facets-sql.js';
import { METAL_ART_SQL, resolveMetalArt } from '../ingest/src/metal-art.js';

const UA = 'Scoutpost/1.0 (+https://softsauce.co/scoutpost)';
const TCG = 'https://tcgcsv.com/tcgplayer';
const CATEGORY = 89;
const OUT = path.join('build', 'seed.sql');

const PROMO_GROUPS = new Set(['PR', 'OPP', 'JDG', 'RWB']);
const PROMO_NAMES = { PR: 'Promos', OPP: 'Organized Play', JDG: 'Judge Promos', RWB: 'Worlds Bundle' };

/**
 * SQL string literal for a NULLABLE column: empty becomes NULL.
 * Everything here is third-party text, so escape it all.
 */
function q(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * SQL string literal for a NOT NULL column: empty stays an empty string.
 *
 * cards.variant is NOT NULL and is '' for every base printing — passing it
 * through q() turned all 1,180 of them into NULL and the insert failed.
 */
function qs(v) {
  return `'${String(v ?? '').replace(/'/g, "''")}'`;
}
function num(v) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? 'NULL' : String(Number(v));
}

async function json(url, label) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

/** The catalogue, paged. limit=500 silently returns nothing — never raise it. */
async function fetchCatalogue() {
  const cards = [];
  for (let offset = 0; offset < 4000; offset += 200) {
    const page = await json(
      `https://riftscribe.gg/api/cards?limit=200&offset=${offset}`,
      'riftscribe',
    );
    if (!Array.isArray(page) || page.length === 0) break;
    cards.push(...page);
  }
  return cards;
}

const TYPES = [
  [/legend/i, 'Legend'], [/battlefield/i, 'Battlefield'], [/\brune\b/i, 'Rune'],
  [/gear/i, 'Gear'], [/spell/i, 'Spell'], [/unit/i, 'Unit'],
];
const typeOf = (line) => (TYPES.find(([re]) => re.test(line || '')) || [, null])[1];
const ext = (p, name) =>
  (p.extendedData || []).find((e) => e && e.name === name)?.value?.trim() || null;

async function main() {
  console.log('seeding a local database — no production D1 is read\n');

  const groups = (await json(`${TCG}/${CATEGORY}/groups`, 'groups')).results || [];
  console.log(`  groups        ${groups.length}`);

  const raw = await fetchCatalogue();
  console.log(`  catalogue     ${raw.length} cards`);

  const sets = new Map();
  const cards = [];

  for (const g of groups) {
    const ab = String(g.abbreviation || '').toUpperCase();
    if (!ab) continue;
    sets.set(ab, {
      name: PROMO_GROUPS.has(ab) ? (PROMO_NAMES[ab] ?? g.name) : g.name,
      // Promo sets carry no release date, deliberately — see §24.
      release: PROMO_GROUPS.has(ab) ? null : (g.publishedOn || '').slice(0, 10) || null,
      groupId: g.groupId,
    });
  }

  for (const c of raw) {
    const t = c.image_thumb || {};
    cards.push({
      id: String(c.id),
      name: String(c.name),
      set_id: String(c.set_id).toUpperCase(),
      collector_number: Number.parseInt(String(c.collector_number), 10) || 0,
      variant: c.variant || '',
      rarity: c.rarity || null,
      finish: /foil|showcase|signature/i.test(c.rarity || '') ? 'foil' : 'normal',
      card_type: c.type || null,
      faction: c.faction || null,
      public_code: c.public_code || null,
      image_thumb_url: t.small || t.medium || null,
      image_large_url: t.large || t.medium || t.small || null,
      product_id: null,
    });
  }

  // Promos, and the price for every product in one pass.
  const prices = new Map(); // productId -> { market, low }
  let promoCount = 0;

  for (const g of groups) {
    const ab = String(g.abbreviation || '').toUpperCase();
    const [prods, prs] = await Promise.all([
      json(`${TCG}/${CATEGORY}/${g.groupId}/products`, `products ${ab}`),
      json(`${TCG}/${CATEGORY}/${g.groupId}/prices`, `prices ${ab}`),
    ]);

    for (const p of prs.results || []) {
      if (!Number.isInteger(p.productId)) continue;
      const cur = prices.get(p.productId) || {};
      // Prefer a real market price from whichever subtype has one.
      if (p.marketPrice != null && cur.market == null) cur.market = p.marketPrice;
      if (p.lowPrice != null && cur.low == null) cur.low = p.lowPrice;
      prices.set(p.productId, cur);
    }

    for (const p of prods.results || []) {
      const printed = ext(p, 'Number');
      if (!printed || !Number.isInteger(p.productId)) continue;

      if (PROMO_GROUPS.has(ab)) {
        const hasArt = Number(p.imageCount) > 0;
        const art = (w) => `https://tcgplayer-cdn.tcgplayer.com/product/${p.productId}_${w}.jpg`;
        cards.push({
          id: `${ab.toLowerCase()}-${p.productId}`,
          name: String(p.name),
          set_id: ab,
          collector_number: Number.parseInt(/(\d+)/.exec(printed)?.[1] ?? '0', 10),
          variant: 'promo',
          rarity: ext(p, 'Rarity') || 'Promo',
          finish: 'normal',
          card_type: typeOf(ext(p, 'Card Type')),
          faction: (ext(p, 'Domain') || '').split(/[;,/]/)[0].trim().toLowerCase() || null,
          public_code: `${ab}-${printed}`,
          image_thumb_url: hasArt ? art('200w') : null,
          image_large_url: hasArt ? art('400w') : null,
          product_id: p.productId,
        });
        promoCount++;
      } else {
        // Match a catalogue card to its product so it gets a price.
        const m = /^(\d+)([a-z]|\*)?\s*\/\s*\d+$/i.exec(printed);
        if (!m) continue;
        const number = Number.parseInt(m[1], 10);
        const variant = m[2] === '*' ? 'star' : (m[2] || '').toLowerCase();
        for (const c of cards) {
          if (c.set_id === ab && c.collector_number === number && c.variant === variant) {
            c.product_id = p.productId;
          }
        }
      }
    }
  }
  console.log(`  promos        ${promoCount}`);
  console.log(`  priced products ${prices.size}`);

  const today = new Date().toISOString().slice(0, 10);
  const lines = [];

  lines.push('-- Generated by scripts/seed-local.mjs. Do not edit; do not commit.');
  lines.push('PRAGMA foreign_keys = OFF;');
  lines.push('DELETE FROM price_snapshots; DELETE FROM card_latest_price;');
  lines.push('DELETE FROM deck_cards; DELETE FROM decks; DELETE FROM events;');
  lines.push('DELETE FROM cards; DELETE FROM sets;');

  for (const [id, s] of sets) {
    lines.push(
      `INSERT INTO sets (id, code, name, release_date, tcgcsv_group_id) VALUES ` +
        `(${qs(id)}, ${qs(id)}, ${qs(s.name)}, ${q(s.release)}, ${num(s.groupId)});`,
    );
  }

  let pricedCards = 0;
  for (const c of cards) {
    const pr = c.product_id ? prices.get(c.product_id) : null;
    const market = pr?.market ?? null;
    if (market != null) pricedCards++;
    lines.push(
      `INSERT INTO cards (id, name, set_id, collector_number, variant, rarity, finish,` +
        ` card_type, faction, public_code, image_thumb_url, image_large_url,` +
        ` tcgcsv_product_id, market_price, low_price, price_date) VALUES (` +
        [
          qs(c.id), qs(c.name), qs(c.set_id), c.collector_number, qs(c.variant), q(c.rarity),
          qs(c.finish), q(c.card_type), q(c.faction), q(c.public_code),
          q(c.image_thumb_url), q(c.image_large_url), num(c.product_id),
          num(market), num(pr?.low ?? null), market == null ? 'NULL' : q(today),
        ].join(', ') +
        ');',
    );
    if (market != null) {
      lines.push(
        `INSERT INTO price_snapshots (card_id, date, market_price, low_price) VALUES ` +
          `(${qs(c.id)}, ${qs(today)}, ${num(market)}, ${num(pr?.low ?? null)});`,
      );
      lines.push(
        `INSERT INTO card_latest_price (card_id, market_price, low_price, date) VALUES ` +
          `(${qs(c.id)}, ${num(market)}, ${num(pr?.low ?? null)}, ${qs(today)});`,
      );
    }
  }

  lines.push('PRAGMA foreign_keys = ON;');

  fs.mkdirSync('build', { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`  cards priced  ${pricedCards}`);
  console.log(`\nwrote ${OUT} (${(lines.join('\n').length / 1024 / 1024).toFixed(1)} MB)`);

  const wrangler = (args) =>
    execFileSync('npx', ['wrangler', ...args], { stdio: 'inherit', shell: true });

  console.log('\napplying schema…');
  wrangler(['d1', 'execute', 'scoutpost', '--local', '--file=db/schema.sql', '-y']);

  console.log('applying seed…');
  wrangler(['d1', 'execute', 'scoutpost', '--local', `--file=${OUT}`, '-y']);

  console.log('\nimporting events from data/events…');
  execFileSync('node', ['scripts/import-decks.mjs'], { stdio: 'inherit' });
  wrangler(['d1', 'execute', 'scoutpost', '--local', '--file=build/import.sql', '-y']);

  // The same recompute the nightly price job does, so local matches production.
  //
  // Written to a file rather than passed with --command: a multi-line SQL
  // argument does not survive the Windows shell, and wrangler then reports a
  // confusing "You must provide either --command or --file".
  console.log('\nrecomputing deck costs…');
  const costSql = path.join('build', 'deck-costs.sql');
  // sets.card_count is what EVENT_ERA orders on, and the inserts above leave it
  // at its default of 0 — which would hide every set from the era filter. The
  // catalog job does this same refresh against production.
  /* Everything the read path expects to be precomputed, in the order the two
   * ingest jobs run it. Miss any of these and local looks broken in a way
   * production is not: no era filter without card_count, no filter chips
   * without card_facets, an empty value board without the set columns.
   *
   * Imported from the same modules the Workers use, never copied — a local
   * database that computes these differently from production is worse than no
   * local database at all (§27). */
  // Metal prize cards borrow the ordinary printing's art; resolved here from
  // the same in-memory card list, with the same resolver the catalog job uses.
  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const metalArt = resolveMetalArt(cards).pairs.map((p) => {
    let i = 0;
    const binds = [p.sourceId, p.sourceId, p.sourceId, p.sourceId, p.metalId];
    return METAL_ART_SQL.replace(/\?/g, () => lit(binds[i++]));
  });

  const statements = [
    'UPDATE sets SET card_count = (SELECT COUNT(*) FROM cards WHERE set_id = sets.id)',
    DECK_COST_SQL,
    ...CATALOG_REBUILD_SQL,
    ...PRICE_REBUILD_SQL,
    ...metalArt,
  ];

  fs.writeFileSync(costSql, `${statements.join(';\n')};\n`);
  wrangler(['d1', 'execute', 'scoutpost', '--local', `--file=${costSql}`, '-y']);

  console.log('\nlocal database ready — run `npm run dev`');
}

main().catch((e) => {
  console.error('\nseed failed:', e.message);
  process.exit(1);
});
