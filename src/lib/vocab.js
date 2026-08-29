/**
 * How the catalogue's raw values are named and pictured for a reader.
 *
 * Riftscribe stores `faction: "fury"` and `variant: "star"`. A player says
 * "Fury" and "Signature". That translation was written out separately in
 * /cards, /cards/<id> and /rankings, which is three places for one vocabulary
 * and three chances for them to disagree — so it lives here once.
 *
 * Naming only. Anything that queries or filters on these values belongs in
 * queries.js, which works in the raw values the database actually stores.
 */

import { url } from './render.js';

/** Colour names as printed on a card. */
export const COLOR_LABELS = {
  body: 'Body',
  calm: 'Calm',
  chaos: 'Chaos',
  fury: 'Fury',
  mind: 'Mind',
  order: 'Order',
  colorless: 'Colourless',
};

/** Printing groups, named the way players talk about them. */
export const PRINTING_LABELS = {
  standard: 'Standard',
  showcase: 'Showcase',
  signature: 'Signature',
  promo: 'Promo',
};

/**
 * Which printing group a card belongs to.
 *
 * Read from `variant`, never from the collector number. Both Signatures and
 * secret rares carry a number above the printed set size, so the number cannot
 * tell them apart — it is what keeps Baron Nashor's UNL-238/219 classified as
 * Standard while Ahri's signature printing, whose collector number carries an
 * asterisk, is not. Mirrors the `PRINTINGS` SQL in queries.js; the two must
 * agree.
 *
 * (Do not write a signature's collector number in a block comment. The
 * asterisk followed by a slash ends the comment — see §5 of the handoff, where
 * it has already broken a file once.)
 */
export function printingOf(card) {
  if (card.variant === '') return 'standard';
  if (card.variant === 'a') return 'showcase';
  if (card.variant === 'star') return 'signature';
  return 'promo';
}

/**
 * Domain icons, cut from each colour's Rune card by
 * scripts/make-domain-icons.mjs.
 *
 * Colourless has no Rune card and therefore no icon. This returns null for it
 * rather than linking a file that does not exist, and every caller falls back
 * to the label alone — an invented glyph would look like an official mark and
 * mean nothing.
 */
const DOMAINS_WITH_ICONS = new Set(['body', 'calm', 'chaos', 'fury', 'mind', 'order']);

export function domainIconSrc(env, faction) {
  return DOMAINS_WITH_ICONS.has(faction) ? url(env, `/domain-${faction}.png`) : null;
}
