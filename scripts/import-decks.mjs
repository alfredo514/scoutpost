#!/usr/bin/env node
/**
 * Turn data/events/*.json into SQL for D1.
 *
 * Adding a new event is a data operation: drop a JSON file in data/events/,
 * run this, apply the SQL. No page template is ever edited.
 *
 *   node scripts/import-decks.mjs                 # build/import.sql
 *   npx wrangler d1 execute scoutpost --remote --file=build/import.sql
 *
 * Card references are resolved against the live Riftscribe catalogue so that a
 * typo fails HERE, loudly, instead of silently inserting a deck with missing
 * cards that would then under-report its build cost.
 */

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS_DIR = join(ROOT, 'data', 'events');
const OUT_FILE = join(ROOT, 'build', 'import.sql');

const RIFTSCRIBE = 'https://riftscribe.gg/api/cards';
const PAGE_SIZE = 200; // 500 silently returns an empty array — do not raise

const problems = [];
function problem(file, msg) {
  problems.push(`${file}: ${msg}`);
}

/** SQL string literal. */
function s(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}
function n(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : 'NULL';
}

/** Pull the whole card catalogue and index it by printed code. */
async function loadCatalogue() {
  const byCode = new Map(); // 'OGN|1|'   → id
  const byName = new Map(); // 'blazing scorcher' → [ids]
  let offset = 0;

  for (;;) {
    const res = await fetch(`${RIFTSCRIBE}?limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Scoutpost/1.0 import' },
    });
    if (!res.ok) throw new Error(`Riftscribe returned HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error('Riftscribe returned a non-array payload');
    if (page.length === 0) {
      if (offset === 0) throw new Error('Riftscribe returned an empty catalogue');
      break;
    }

    for (const c of page) {
      if (!c?.id || !c?.set_id) continue;
      const set = String(c.set_id).toUpperCase();
      const variant = (c.variant ?? '').toLowerCase();
      byCode.set(`${set}|${Number(c.collector_number)}|${variant}`, c.id);

      const key = String(c.name ?? '').trim().toLowerCase();
      if (key) {
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(c.id);
      }
    }

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`  catalogue: ${byCode.size} printings indexed`);
  return { byCode, byName };
}

/**
 * Resolve one deck-list entry to a card id.
 * Accepts { code: 'OGN-001' } (preferred, unambiguous) or { name: '...' }.
 */
function resolveCard(entry, catalogue, file) {
  if (entry.card_id) return entry.card_id; // explicit override, trusted

  if (entry.code) {
    const m = /^([A-Za-z]+)[-\s]?0*(\d+)([a-z]?)$/.exec(String(entry.code).trim());
    if (!m) {
      problem(file, `card code "${entry.code}" is not in SET-NUMBER form (e.g. OGN-001)`);
      return null;
    }
    const key = `${m[1].toUpperCase()}|${Number(m[2])}|${(m[3] || '').toLowerCase()}`;
    const id = catalogue.byCode.get(key);
    if (!id) {
      problem(file, `card code "${entry.code}" matched no card in the catalogue`);
      return null;
    }
    return id;
  }

  if (entry.name) {
    const hits = catalogue.byName.get(String(entry.name).trim().toLowerCase()) ?? [];
    if (hits.length === 0) {
      problem(file, `card name "${entry.name}" matched no card`);
      return null;
    }
    if (hits.length > 1) {
      problem(
        file,
        `card name "${entry.name}" is ambiguous (${hits.length} printings) — use a code instead`,
      );
      return null;
    }
    return hits[0];
  }

  problem(file, 'a deck entry had neither "code" nor "name"');
  return null;
}

function validateEvent(data, file) {
  const required = ['id', 'name', 'date'];
  for (const key of required) {
    if (!data?.[key]) problem(file, `missing required field "${key}"`);
  }
  if (data?.id && !/^[a-z0-9-]+$/.test(data.id)) {
    problem(file, `event id "${data.id}" must be a lowercase slug (a-z, 0-9, hyphens)`);
  }
  if (data?.date && !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    problem(file, `date "${data.date}" must be YYYY-MM-DD`);
  }
  if (!Array.isArray(data?.decks) || data.decks.length === 0) {
    problem(file, 'no decks array');
  }
}

async function main() {
  console.log('Scoutpost deck import\n');

  let files = [];
  try {
    // Files starting with '_' are scaffolding (e.g. _TEMPLATE.json), not events.
    files = (await readdir(EVENTS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    console.error(`No ${EVENTS_DIR} directory found.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error('No event JSON files found in data/events/.');
    process.exit(1);
  }
  console.log(`  ${files.length} event file(s) found`);

  const catalogue = await loadCatalogue();

  const sql = [
    '-- Generated by scripts/import-decks.mjs — do not edit by hand.',
    `-- Generated ${new Date().toISOString()}`,
    'PRAGMA foreign_keys = ON;',
    '',
  ];

  let deckTotal = 0;
  let cardTotal = 0;

  for (const file of files) {
    const raw = await readFile(join(EVENTS_DIR, file), 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      problem(file, `invalid JSON — ${e.message}`);
      continue;
    }

    validateEvent(data, file);
    if (problems.length) continue; // don't build SQL from a broken file

    sql.push(`-- ── ${data.name} (${file}) ──`);
    sql.push(
      `INSERT INTO events (id, name, date, format, store, city, state, country, source_url, updated_at)
VALUES (${s(data.id)}, ${s(data.name)}, ${s(data.date)}, ${s(data.format)}, ${s(data.store)}, ${s(
        data.city,
      )}, ${s(data.state)}, ${s(data.country)}, ${s(data.source_url)}, datetime('now'))
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name, date=excluded.date, format=excluded.format, store=excluded.store,
  city=excluded.city, state=excluded.state, country=excluded.country,
  source_url=excluded.source_url, updated_at=datetime('now');`,
    );

    // Re-importing an event replaces its decks wholesale (cascade clears deck_cards).
    sql.push(`DELETE FROM decks WHERE event_id = ${s(data.id)};`);

    const seenPlacements = new Set();
    for (const deck of data.decks) {
      const placement = Number(deck.placement);
      if (!Number.isInteger(placement) || placement < 1 || placement > 8) {
        problem(file, `placement "${deck.placement}" must be an integer 1-8`);
        continue;
      }
      if (seenPlacements.has(placement)) {
        problem(file, `placement ${placement} appears more than once`);
        continue;
      }
      seenPlacements.add(placement);

      const deckId = `${data.id}-${placement}`;
      sql.push(
        `INSERT INTO decks (id, event_id, placement, player_name, legend, notes)
VALUES (${s(deckId)}, ${s(data.id)}, ${placement}, ${s(deck.player)}, ${s(deck.legend)}, ${s(
          deck.notes,
        )});`,
      );
      deckTotal++;

      const cards = Array.isArray(deck.cards) ? deck.cards : [];
      if (cards.length === 0) problem(file, `deck ${placement} has no cards`);

      const merged = new Map(); // card_id → qty (a list may repeat a card)
      for (const entry of cards) {
        const cardId = resolveCard(entry, catalogue, file);
        if (!cardId) continue;
        const qty = Number(entry.qty ?? entry.quantity ?? 1);
        if (!Number.isInteger(qty) || qty < 1) {
          problem(file, `quantity "${entry.qty}" for ${entry.code ?? entry.name} must be a positive integer`);
          continue;
        }
        merged.set(cardId, (merged.get(cardId) ?? 0) + qty);
      }

      for (const [cardId, qty] of merged) {
        sql.push(
          `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (${s(deckId)}, ${s(
            cardId,
          )}, ${qty}) ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity=excluded.quantity;`,
        );
        cardTotal++;
      }
    }
    sql.push('');
  }

  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s) — nothing was written:\n`);
    for (const p of problems) console.error(`   • ${p}`);
    console.error('\nFix the JSON and run again.');
    process.exit(1);
  }

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, sql.join('\n'), 'utf8');

  console.log(`\n✓ ${deckTotal} deck(s), ${cardTotal} card line(s) → build/import.sql`);
  console.log('\nApply with:');
  console.log('   npx wrangler d1 execute scoutpost --remote --file=build/import.sql');
}

main().catch((e) => {
  console.error('\n✗ import failed:', e.message);
  process.exit(1);
});
