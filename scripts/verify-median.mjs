/**
 * Diff the old median expression against the new one across EVERY filter
 * combination /rankings can produce, plus the extra ones /cards can.
 *
 * Runs against the local D1 sqlite file directly, so it costs no production
 * quota and can afford to be exhaustive (§27 rule 4).
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const file = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'))
  .map((f) => path.join(dir, f))[0];

const db = new DatabaseSync(file, { readOnly: true });

const PRINTINGS = {
  standard: "c.variant = ''",
  showcase: "c.variant = 'a'",
  signature: "c.variant = 'star'",
  promo: "c.variant NOT IN ('', 'a', 'star')",
};

/** Mirrors cardFilterParts in src/lib/queries.js. */
function filterParts({ type, color, set, rarity, printing, q, priced, metal }) {
  const where = [];
  const params = [];
  if (type) { where.push('c.card_type = ?'); params.push(type); }
  if (color) { where.push('c.faction = ?'); params.push(color); }
  if (set) { where.push('c.set_id = ?'); params.push(set); }
  if (rarity) { where.push('c.rarity = ?'); params.push(rarity); }
  if (printing && PRINTINGS[printing]) where.push(PRINTINGS[printing]);
  if (q) {
    where.push('(lower(c.name) LIKE ? OR lower(c.public_code) LIKE ?)');
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  if (priced === 'yes') where.push('c.market_price IS NOT NULL');
  if (priced === 'no') where.push('c.market_price IS NULL');
  if (metal === 'hide') where.push('c.is_metal = 0');
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function oldMedian(f) {
  const row = db
    .prepare(
      `WITH priced AS (
         SELECT c.market_price AS px,
                ROW_NUMBER() OVER (ORDER BY c.market_price) AS pos,
                COUNT(*) OVER () AS n
           FROM cards c ${f.clause}
       )
       SELECT AVG(px) AS median FROM priced WHERE pos IN ((n + 1) / 2, (n + 2) / 2)`,
    )
    .get(...f.params);
  return row?.median ?? null;
}

function newMedian(f, pricedCount) {
  if (!pricedCount || pricedCount < 1) return null;
  const limit = 2 - (pricedCount % 2);
  const offset = Math.floor((pricedCount - 1) / 2);
  const row = db
    .prepare(
      `SELECT AVG(px) AS median FROM (
         SELECT c.market_price AS px FROM cards c ${f.clause}
          ORDER BY c.market_price LIMIT ? OFFSET ?
       )`,
    )
    .get(...f.params, limit, offset);
  return row?.median ?? null;
}

function pricedCount(f) {
  return db.prepare(`SELECT COUNT(*) AS n FROM cards c ${f.clause}`).get(...f.params).n;
}

// The full option space the UI can produce.
const sets = ['', ...db.prepare('SELECT id FROM sets ORDER BY id').all().map((r) => r.id)];
const printings = ['', ...Object.keys(PRINTINGS)];
const metals = ['hide', 'show'];
const types = ['', ...db.prepare("SELECT DISTINCT card_type FROM cards WHERE card_type IS NOT NULL").all().map((r) => r.card_type)];
const rarities = ['', ...db.prepare('SELECT DISTINCT rarity FROM cards WHERE rarity IS NOT NULL').all().map((r) => r.rarity)];

let checked = 0;
let mismatches = 0;
const report = [];

function check(label, filters) {
  // marketStats always asks for the priced slice.
  const f = filterParts({ ...filters, priced: 'yes' });
  const n = pricedCount(f);
  const a = oldMedian(f);
  const b = newMedian(f, n);
  checked++;
  const same = a === b || (a !== null && b !== null && Math.abs(a - b) < 1e-9);
  if (!same) {
    mismatches++;
    report.push(`  MISMATCH ${label}  n=${n}  old=${a}  new=${b}`);
  }
  return n;
}

// /rankings: set x printing x metal
for (const set of sets)
  for (const printing of printings)
    for (const metal of metals)
      check(`set=${set || 'all'} printing=${printing || 'all'} metal=${metal}`, { set, printing, metal });

// /cards can additionally narrow by type and rarity.
for (const type of types) check(`type=${type || 'all'}`, { type });
for (const rarity of rarities) check(`rarity=${rarity || 'all'}`, { rarity });
for (const type of types)
  for (const rarity of rarities)
    check(`type=${type || 'all'} rarity=${rarity || 'all'}`, { type, rarity });

// Deliberately empty and single-row slices — the edge cases that break offsets.
check('impossible (no such set)', { set: '__nope__' });
check('search matching nothing', { q: 'zzzzzzzzzz' });

// Verify odd/even handling directly on synthetic counts.
const oddEven = [];
for (const n of [1, 2, 3, 4, 5, 6, 7, 20, 21]) {
  const f = filterParts({ priced: 'yes' });
  const sub = { clause: `${f.clause} AND c.id IN (SELECT id FROM cards c2 WHERE c2.market_price IS NOT NULL ORDER BY c2.market_price LIMIT ${n})`, params: [] };
  const a = oldMedian(sub);
  const b = newMedian(sub, n);
  const same = a === b || (a !== null && b !== null && Math.abs(a - b) < 1e-9);
  checked++;
  if (!same) { mismatches++; report.push(`  MISMATCH n=${n} old=${a} new=${b}`); }
  oddEven.push(`n=${n}:${same ? 'ok' : 'FAIL'}`);
}

console.log(`combinations checked: ${checked}`);
console.log(`odd/even sizes:       ${oddEven.join(' ')}`);
console.log(`mismatches:           ${mismatches}`);
report.slice(0, 20).forEach((l) => console.log(l));
db.close();
