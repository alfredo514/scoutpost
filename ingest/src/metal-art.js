/**
 * Give Metal prize cards the art of the card they are a Metal version of.
 *
 * WHY
 *
 * Metal cards are the metal-plated prizes handed out at events. TCGplayer
 * publishes no photograph for most of them — 52 of the 68 have no image at all
 * — so they rendered as blank frames wherever they appeared. §18's original
 * answer was to hide them from /rankings by default, which is still right for
 * a leaderboard, but it left the blank frames everywhere else.
 *
 * They are metal printings of an existing card and, per the person who owns
 * this site, they look like the ordinary art. So the ordinary art is the
 * honest thing to show, and it is far better than an empty rectangle.
 *
 * HOW THE MATCH WORKS, AND WHY IT IS NOT A REGEX
 *
 * The product name is "<Base Name> (Metal) (Best Of)" or "… (Prize Wall)".
 * Strip that and you have a printed card name — at which point this is the
 * same problem the deck importer solves, with the same three catalogue quirks:
 *
 *   - legends usually lose the champion prefix, but not always
 *     ("Ahri, Nine-Tailed Fox" -> "Nine-Tailed Fox", yet Annie's legend really
 *     is catalogued "Annie, Dark Child")
 *   - starter reprints carry " - Starter" ("Dark Child - Starter")
 *   - names differ in case ("Grandmaster At Arms" vs "Grandmaster at Arms")
 *
 * and, most importantly, the same trap: a name can match a SECRET RARE whose
 * collector number is above the printed set size. "Swift Scout" matches
 * OGN-263/298 (base), OGN-307/298 (secret rare) and the Signature printing of
 * 307, whose collector number carries an asterisk. Picking wrong would put the
 * wrong picture on the page, silently.
 *
 * (That Signature number is written out in words on purpose. An asterisk
 * followed by a slash ends a block comment, and it has broken a file in this
 * repo twice now — see §5. It just did it again while this was being written.)
 *
 * So the rules come from shared/card-names.js, which is the deck importer's
 * own resolver, rather than a fourth copy of them.
 *
 * WHAT IT WRITES
 *
 * The base card's image URLs, copied onto the Metal row. Because the R2 key is
 * derived from the URL's filename (src/lib/images.js), the Metal card then
 * serves the byte-identical mirrored object the base card already uses — no
 * extra R2 storage and nothing new to mirror. `image_mirrored` is copied for
 * the same reason: that art genuinely is mirrored, so the image job must not
 * queue it again.
 *
 * `art_from_card_id` records the borrow. Nothing reads it to render a page —
 * it exists so that "this art is not this card's own" is a fact in the data
 * rather than something you have to re-derive, and so the card page can say so.
 */

import { indexByName, isBasePrinting, lookupAllPrintings } from '../../shared/card-names.js';

/** "Ahri, Nine-Tailed Fox (Metal) (Prize Wall)" -> "Ahri, Nine-Tailed Fox" */
export function baseNameOf(name) {
  return String(name).replace(/\s*\(Metal\).*$/i, '').trim();
}

export const isMetalName = (name) => /\(Metal\)/i.test(String(name));

/**
 * Work out which card each Metal card should borrow its art from.
 *
 * @param cards every card, each with { id, name, variant, rarity, public_code,
 *   collector_number, image_large_url }
 * @returns {{ pairs: Array<{metalId, sourceId, metalName, sourceName}>,
 *   unmatched: string[], ambiguous: string[] }}
 */
export function resolveMetalArt(cards) {
  // Only non-Metal cards that actually have art are worth borrowing from.
  const pool = cards.filter((c) => !isMetalName(c.name) && c.image_large_url);
  const index = indexByName(pool);

  const pairs = [];
  const unmatched = [];
  const ambiguous = [];

  for (const m of cards) {
    if (!isMetalName(m.name)) continue;

    const hits = lookupAllPrintings(baseNameOf(m.name), index);
    if (hits.length === 0) {
      unmatched.push(m.name);
      continue;
    }

    const base = hits.filter(isBasePrinting);
    // Several base printings are fine as long as they carry the same picture,
    // which is the common case for a reprint. Only genuinely different art is
    // ambiguous, and that is refused rather than guessed at: a wrong picture
    // here would be exactly the quiet kind of wrong (§5).
    const distinctArt = new Set(base.map((b) => b.image_large_url));
    let chosen = null;
    if (distinctArt.size === 1) chosen = base[0];
    else if (base.length === 0 && hits.length === 1) chosen = hits[0]; // nothing else it could mean

    if (!chosen) {
      ambiguous.push(
        `${m.name} -> ${base.length || hits.length} candidates: ` +
          `${(base.length ? base : hits).map((h) => h.public_code ?? h.id).join(', ')}`,
      );
      continue;
    }
    if (chosen.id === m.id) continue;
    pairs.push({ metalId: m.id, sourceId: chosen.id, metalName: m.name, sourceName: chosen.name });
  }

  return { pairs, unmatched, ambiguous };
}

/**
 * SQL to copy one card's art onto another.
 *
 * Reads the source row rather than taking URLs as parameters, so the copy is
 * always of what is actually in the database now. Only fills a Metal card that
 * has no art of its own — 16 of the 68 have a real TCGplayer photograph, and
 * their own picture is better than a borrowed one.
 */
export const METAL_ART_SQL = `UPDATE cards SET
   image_thumb_url  = (SELECT b.image_thumb_url FROM cards b WHERE b.id = ?),
   image_large_url  = (SELECT b.image_large_url FROM cards b WHERE b.id = ?),
   image_mirrored   = (SELECT b.image_mirrored  FROM cards b WHERE b.id = ?),
   art_from_card_id = ?
 WHERE id = ?
   AND (image_large_url IS NULL OR art_from_card_id IS NOT NULL)`;

/** Bind order for METAL_ART_SQL: the source four times, then the target. */
export const metalArtBinds = ({ metalId, sourceId }) => [
  sourceId, sourceId, sourceId, sourceId, metalId,
];
