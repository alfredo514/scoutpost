/**
 * Promo cards, sourced from TCGplayer instead of the card catalogue.
 *
 * Riftscribe publishes five sets and nothing else — OGN, OGS, SFD, UNL, VEN.
 * It has no promos at all. TCGplayer has four promo groups it does not:
 *
 *   PR   Riftbound Promotional Cards
 *   OPP  Riftbound Organized Play Promotional Cards
 *   JDG  Riftbound Judge Promotional Cards
 *   RWB  Riftbound Worlds Bundle 2025          (empty today, listed anyway)
 *
 * That is ~239 singles the site knew nothing about, including the most
 * expensive card in the game. They were invisible because the price walk joins
 * on `set abbreviation + collector number`, and no card carried a promo set.
 *
 * **A promo reuses its original set's collector number.** "Viktor, Leader" in
 * OPP is printed `246/298` — 298 is Origins' set size, and Origins card 246 is
 * a different card. So a promo can never be matched by number: two products in
 * the same group can even share one (a base promo and its Metal version). They
 * are matched by `tcgcsv_product_id`, which is unique and stable, and their ids
 * are built from it for the same reason.
 *
 * What TCGplayer gives, it gives completely: name, number, rarity, rules text,
 * flavour text, all three stats, type and domain — everything a card page shows
 * EXCEPT art. There is no art source for promos, so `image_*` stay null and the
 * pages fall back to the placeholder they already render for an unmirrored
 * card. TCGplayer hosts product photography on its own CDN; that is TCGplayer's
 * imagery rather than Riot's, and using it is a separate decision from the Riot
 * policy in §8 — so this module does not touch it.
 */

import { fetchJson, log, nonEmptyString, warn } from './util.js';

const BASE = 'https://tcgcsv.com/tcgplayer';
const CATEGORY_ID = 89;

/** TCGplayer groups that hold promos rather than a numbered set. */
export const PROMO_GROUPS = new Set(['PR', 'OPP', 'JDG', 'RWB']);

/**
 * Shorter names for the set chips.
 *
 * TCGplayer's own names ("Riftbound Organized Play Promotional Cards") are
 * accurate and far too long for a filter pill next to "Vendetta".
 */
export const PROMO_SET_NAMES = {
  PR: 'Promos',
  OPP: 'Organized Play',
  JDG: 'Judge Promos',
  RWB: 'Worlds Bundle',
};

/**
 * `Card Type` from TCGplayer is prose — "Champion Unit", "Battlefield". The
 * site's types are a fixed set, and the order here matters: "Champion Unit"
 * must land on Unit, so the more specific words are tested first.
 */
const TYPES = [
  [/legend/i, 'Legend'],
  [/battlefield/i, 'Battlefield'],
  [/\brune\b/i, 'Rune'],
  [/gear/i, 'Gear'],
  [/spell/i, 'Spell'],
  [/unit/i, 'Unit'],
];

function cardTypeOf(line) {
  if (!nonEmptyString(line)) return null;
  for (const [re, type] of TYPES) if (re.test(line)) return type;
  return null;
}

function extended(product, field) {
  const rows = Array.isArray(product?.extendedData) ? product.extendedData : [];
  const hit = rows.find((e) => e && e.name === field);
  return nonEmptyString(hit?.value) ? String(hit.value).trim() : null;
}

/**
 * The collector number as an integer.
 *
 * Promos print things the base sets never do — `246/298`, `R06/006`, bare
 * `12`. Any run of digits is enough to place the card in a list; the printed
 * string is kept verbatim in `public_code`, which is what a reader searches.
 */
function numberOf(printed) {
  const m = /(\d+)/.exec(String(printed ?? ''));
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Promo cards for every promo group present, in `writeCatalog`'s row shape.
 *
 * Takes the already-fetched group list so this costs no extra call to
 * /groups, and skips sealed product (a box has no `Number`).
 */
export async function fetchPromoCards(groups) {
  const promoGroups = (groups ?? []).filter((g) => PROMO_GROUPS.has(g.abbreviation));
  if (!promoGroups.length) {
    warn('promos: no promo groups in the TCGplayer group list');
    return [];
  }

  const cards = [];

  for (const group of promoGroups) {
    let products;
    try {
      const body = await fetchJson(`${BASE}/${CATEGORY_ID}/${group.groupId}/products`, {
        label: `tcgcsv promo products ${group.abbreviation}`,
      });
      products = Array.isArray(body?.results) ? body.results : [];
    } catch (e) {
      // One bad promo group must not sink the catalogue run.
      warn(`promos: skipping ${group.abbreviation} — ${e.message}`);
      continue;
    }

    let kept = 0;
    for (const product of products) {
      if (!product || !Number.isInteger(product.productId)) continue;

      const printed = extended(product, 'Number');
      if (!printed) continue; // sealed product — a box set, not a card

      const number = numberOf(printed);
      if (number === null) continue;

      const domain = extended(product, 'Domain');

      cards.push({
        // From the product id, not the collector number: promos reuse their
        // original set's numbering and can collide within their own group.
        id: `${group.abbreviation.toLowerCase()}-${product.productId}`,
        name: String(product.name),
        set_id: group.abbreviation,
        collector_number: number,
        // Anything outside '', 'a' and 'star' reads as a promo printing to
        // both the SQL in queries.js and printingOf() in vocab.js.
        variant: 'promo',
        rarity: extended(product, 'Rarity') ?? 'Promo',
        finish: 'normal',
        card_type: cardTypeOf(extended(product, 'Card Type')),
        faction: domain ? domain.split(/[;,/]/)[0].trim().toLowerCase() : null,
        public_code: `${group.abbreviation}-${printed}`,
        image_url: null,
        image_thumb_url: null,
        image_large_url: null,
        // Carried through so the price walk can match on it directly.
        tcgcsv_product_id: product.productId,
      });
      kept++;
    }

    log(`promos: ${group.abbreviation} — ${kept} cards from ${products.length} products`);
  }

  return cards;
}

/**
 * Set metadata for the promo groups, with the long names shortened and
 * **release_date deliberately null**.
 *
 * This is the load-bearing line in the module. `EVENT_ERA` in queries.js
 * derives an event's format from "the most recent set released on or before
 * it", and `setEras` builds the /events and /decks filter from the same dates.
 * Judge Promos published 2025-12-01, which sits between Origins and
 * Spiritforged — give it a real date and every event in that window silently
 * re-attributes itself to a three-card promo set, and a "Judge Promos" pill
 * appears on /decks filtering to nothing.
 *
 * A null date keeps promos out of both: `setEras` filters
 * `release_date IS NOT NULL`, and `EVENT_ERA` compares `release_date <= date`,
 * which no NULL satisfies. They stay fully browsable on /cards, where the set
 * facet does not care.
 */
export function promoSetMeta(groups) {
  const meta = new Map();
  for (const g of groups ?? []) {
    if (!PROMO_GROUPS.has(g.abbreviation)) continue;
    meta.set(g.abbreviation, {
      name: PROMO_SET_NAMES[g.abbreviation] ?? g.name,
      releaseDate: null,
      groupId: g.groupId,
    });
  }
  return meta;
}
