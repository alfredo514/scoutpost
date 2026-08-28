/**
 * Turning a Riftscribe CDN URL into a local image path.
 *
 * The ingest Worker mirrors each rendition into R2 under `<size>/<filename>`
 * (see ingest/src/images.js — the two must agree on this shape). Pages never
 * link to cdn.riftscribe.gg directly; they link here, and this Worker serves
 * the mirrored bytes.
 *
 * Everything degrades rather than breaks: a card with no stored URL, or a URL
 * this cannot parse, yields null, and callers render a placeholder.
 */

import { esc, url } from './render.js';

/** '…/thumbnails/small/ogn-001-abc.webp' → 'small/ogn-001-abc.webp' */
export function imageKeyFromUrl(size, cdnUrl) {
  if (!cdnUrl) return null;
  try {
    const name = new URL(cdnUrl).pathname.split('/').pop();
    return name ? `${size}/${name}` : null;
  } catch {
    return null;
  }
}

/** Site-relative src for a card image, base path included. Null if unavailable. */
export function cardImageSrc(env, card, size = 'small') {
  const cdnUrl = size === 'large' ? card?.image_large_url : card?.image_thumb_url;
  const key = imageKeyFromUrl(size, cdnUrl);
  return key ? url(env, `/card-image/${key}`) : null;
}

/**
 * A deck's Legend, shown as art beside its name.
 *
 * Used wherever decks are listed. A Riftbound deck has exactly one Legend and
 * players recognise a deck by it on sight, so a column of eight decks is far
 * quicker to scan with the art than with names alone — which is the whole point
 * of putting it here.
 *
 * Reuses the decklist row's markup and styling (`.card-cell`, `.card-thumb`,
 * `.card-zoom`), so hovering a Legend here gives the same readable enlargement
 * as hovering a card on a decklist, and there is one set of styles to maintain.
 * Needs `legend_thumb_url` / `legend_large_url` from LEGEND_ART in queries.js.
 *
 * Falls back to the deck's recorded legend name when no art is available, so a
 * row never renders empty.
 */
export function legendMark(env, deck, labelHtml) {
  const name = deck?.legend || '';
  const thumb = imageKeyFromUrl('small', deck?.legend_thumb_url);
  const large = imageKeyFromUrl('large', deck?.legend_large_url);

  // Callers that already render their own label — /decks makes the Legend name
  // the link to the deck — pass it in rather than getting a second copy.
  const label = labelHtml ?? (name ? `<span class="legend">${esc(name)}</span>` : '');

  if (!thumb) return label;

  const zoom = large
    ? `<span class="card-zoom" aria-hidden="true" style="--art:url('${esc(
        url(env, `/card-image/${large}`),
      )}')"></span>`
    : '';

  return `<span class="card-cell legend-cell"${large ? ' tabindex="0"' : ''}>
      <img class="card-thumb" src="${esc(url(env, `/card-image/${thumb}`))}"
           width="34" height="48" loading="lazy" decoding="async" alt=""/>
      <span class="card-text">${label}</span>
      ${zoom}
    </span>`;
}
