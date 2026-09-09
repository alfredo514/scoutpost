/**
 * Resolving a PRINTED card name to the card it means.
 *
 * Extracted from scripts/import-decks.mjs, which had the only correct copy of
 * these rules. It is shared because a second caller now needs them
 * (ingest/src/metal-art.js) and because every one of the rules below exists
 * because getting it wrong produced a plausible wrong answer rather than an
 * error — §5's failure mode, and the reason this is not four regexes inline.
 *
 * Works on anything with { id, name, variant, rarity, public_code,
 * collector_number } — Riftscribe's API objects and `cards` rows both qualify.
 */

/** Compare names ignoring punctuation, case and spacing. */
export function normaliseName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The forms a printed name might be catalogued under, in preference order.
 *
 * Two quirks, both real and both load-bearing:
 *
 * - **Legends lose the champion prefix.** "Kennen, Heart of the Tempest" is
 *   catalogued as "Heart of the Tempest". But NOT consistently: Annie's legend
 *   is "Annie, Dark Child" with the prefix intact. So both forms are tried, in
 *   that order.
 * - **Starter reprints carry a suffix.** "Wuju Bladesman - Starter" has to be
 *   findable as "Wuju Bladesman", which is what the caller's suffix-trimmed
 *   index is for.
 */
export function nameForms(name) {
  const forms = [normaliseName(name)];
  if (String(name).includes(',')) {
    forms.push(normaliseName(String(name).split(',').slice(1).join(' ')));
  }
  return forms.filter(Boolean);
}

/** A name with its trailing " - Something" removed, or null if it had none. */
export function suffixTrimmed(name) {
  const trimmed = normaliseName(String(name).replace(/\s+-\s+.*$/, ''));
  const full = normaliseName(name);
  return trimmed && trimmed !== full ? trimmed : null;
}

/**
 * Is this the ordinary tournament printing?
 *
 * Excludes, in order of how badly each would hurt:
 *
 * - **A collector number ABOVE the printed set size** — that is a secret rare.
 *   Not marginally pricier: Baron Nashor is $18.92 as UNL-147/219 and
 *   $1,634.89 as UNL-238/219 (§5). The set size is the denominator in
 *   `public_code`, which is why that column is the authority and not a table
 *   of set sizes someone has to maintain.
 * - **An asterisk in the collector number** — the Signature printing, averaging
 *   ~$952 against ~$13.55 for everything else (§5).
 * - **A letter variant** (`007a`) — the showcase alt art.
 * - **A showcase or signature rarity**, for the same reason twice over.
 */
export function isBasePrinting(card) {
  if (card.variant) return false;
  if (/showcase|signature/i.test(card.rarity ?? '')) return false;
  const size = /\/(\d+)$/.exec(card.public_code ?? '');
  if (size && Number(card.collector_number) > Number(size[1])) return false;
  return !String(card.public_code ?? '').includes('*');
}

/**
 * Index a catalogue by name and by suffix-trimmed name.
 * Returns { byName, bySuffixTrimmed }, both Map<string, card[]>.
 */
export function indexByName(cards) {
  const byName = new Map();
  const bySuffixTrimmed = new Map();
  for (const c of cards) {
    const key = normaliseName(c.name ?? '');
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);

    const trimmed = suffixTrimmed(c.name ?? '');
    if (trimmed) {
      if (!bySuffixTrimmed.has(trimmed)) bySuffixTrimmed.set(trimmed, []);
      bySuffixTrimmed.get(trimmed).push(c);
    }
  }
  return { byName, bySuffixTrimmed };
}

/**
 * Every printing a printed name could mean, stopping at the FIRST name form
 * that matches anything. [] if the name is unknown.
 *
 * This is the deck importer's behaviour and it must stay that way: an importer
 * that widened its search would start finding new ambiguities in event files
 * that import cleanly today.
 */
export function lookupPrintings(name, { byName, bySuffixTrimmed }) {
  for (const form of nameForms(name)) {
    const hits = byName.get(form) ?? bySuffixTrimmed.get(form) ?? [];
    if (hits.length) return hits;
  }
  return [];
}

/**
 * Every printing ANY form of the name could mean, unioned.
 *
 * Differs from lookupPrintings deliberately. Stopping at the first matching
 * form is right when you are resolving a decklist entry — the earlier form is
 * the more literal reading. It is wrong when you are looking for the best card
 * to borrow art from, because the literal form can match a worse printing and
 * hide a better one behind it: "Ahri, Nine-Tailed Fox" matches an OPP promo
 * under its full name, while the ordinary OGN printing is catalogued
 * "Nine-Tailed Fox" and would never be reached.
 *
 * Union the forms, then let isBasePrinting choose. Order is preserved so the
 * more literal form still comes first among equals.
 */
export function lookupAllPrintings(name, { byName, bySuffixTrimmed }) {
  const out = [];
  const seen = new Set();
  for (const form of nameForms(name)) {
    for (const c of [...(byName.get(form) ?? []), ...(bySuffixTrimmed.get(form) ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}
