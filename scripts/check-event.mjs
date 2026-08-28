#!/usr/bin/env node
/**
 * Validate an event JSON before importing it.
 *
 *   node scripts/check-event.mjs data/events/<slug>.json
 *
 * A Riftbound tournament deck is a fixed shape, so a decklist transcribed from
 * an article can be checked arithmetically:
 *
 *   1 legend + 1 champion + 39 maindeck + 3 battlefields + 12 runes = 56
 *
 * Card types come from the live Riftscribe catalogue rather than a hardcoded
 * list of battlefield names — an earlier version of this check kept such a list
 * and reported every deck of a new event as broken simply because that event
 * used battlefields the list had never heard of.
 *
 * This does NOT check that card names resolve; scripts/import-decks.mjs does
 * that, and fails loudly. This checks the shape, which is what catches a line
 * dropped or doubled while transcribing.
 */

import { readFile } from 'node:fs/promises';

const RIFTSCRIBE = 'https://riftscribe.gg/api/cards';
const PAGE_SIZE = 200; // 500 silently returns an empty array — do not raise

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-event.mjs <event.json>');
  process.exit(1);
}

/** name (normalised) → card_type, from the live catalogue. */
async function loadTypes() {
  const types = new Map();
  for (let offset = 0; offset < 20000; offset += PAGE_SIZE) {
    // Riftscribe is a free community API and returns the occasional 502/504.
    // A transcription check failing because of someone else's gateway blip is
    // pure noise, so retry a few times before giving up.
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(`${RIFTSCRIBE}?limit=${PAGE_SIZE}&offset=${offset}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'Scoutpost/1.0 check' },
      });
      if (res.ok) break;
      if (attempt >= 4) throw new Error(`Riftscribe returned HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error('Riftscribe returned a non-array payload');
    if (page.length === 0) {
      if (offset === 0) throw new Error('Riftscribe returned an empty catalogue');
      break;
    }
    for (const c of page) {
      if (!c?.name || !c?.type) continue;
      // Mirror the importer's three resolution quirks, or this reports false
      // failures for names that import perfectly well:
      //   - legends are catalogued without their champion prefix
      //     ("Annie, Dark Child" is stored as "Dark Child")
      //   - starter reprints carry a " - Starter" suffix, and for some legends
      //     that reprint is the ONLY printing ("Dark Child - Starter")
      const forms = [c.name];
      const trimmed = String(c.name).replace(/\s+-\s+.*$/, '');
      if (trimmed !== c.name) forms.push(trimmed);
      for (const form of [...forms]) {
        if (form.includes(',')) forms.push(form.split(',').slice(1).join(' '));
      }
      for (const form of forms) {
        const key = norm(form);
        if (key && !types.has(key)) types.set(key, c.type);
      }
    }
    if (page.length < PAGE_SIZE) break;
  }
  return types;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const data = JSON.parse(await readFile(file, 'utf8'));
const types = await loadTypes();

let bad = 0;
for (const deck of data.decks) {
  const bucket = { Legend: 0, Battlefield: 0, Rune: 0, other: 0, unknown: [] };
  for (const entry of deck.cards) {
    const name = entry.name ?? entry.code ?? '';
    let type = types.get(norm(name));
    if (!type && name.includes(',')) type = types.get(norm(name.split(',').slice(1).join(' ')));
    if (!type) {
      bucket.unknown.push(name);
      bucket.other += entry.qty;
      continue;
    }
    if (type in bucket) bucket[type] += entry.qty;
    else bucket.other += entry.qty;
  }

  const total = deck.cards.reduce((a, c) => a + c.qty, 0);
  const side = (deck.sideboard ?? []).reduce((a, c) => a + c.qty, 0);
  // 'other' is champion + units + spells + gear: 1 champion plus 39 maindeck.
  const ok =
    total === 56 && bucket.Legend === 1 && bucket.Battlefield === 3 && bucket.Rune === 12;
  if (!ok) bad++;

  console.log(
    `${String(deck.placement).padStart(2)}  ${String(deck.player).padEnd(18)} ` +
      `total=${total} legend=${bucket.Legend} bf=${bucket.Battlefield} ` +
      `runes=${bucket.Rune} rest=${bucket.other} side=${side} ${ok ? 'OK' : '<<< CHECK'}` +
      (bucket.unknown.length ? `\n      unknown names: ${bucket.unknown.join(', ')}` : ''),
  );
}

console.log(
  bad
    ? `\n${bad} of ${data.decks.length} deck(s) FAILED`
    : `\nAll ${data.decks.length} decks: 1 legend + 1 champion + 39 maindeck + 3 battlefields + 12 runes = 56`,
);
process.exit(bad ? 1 : 0);
