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

/**
 * One table row's card cell: thumbnail, name, printed code, and a full-size
 * enlargement shown on hover or keyboard focus.
 *
 * The enlargement carries **no JavaScript**. Its art is a `background-image`
 * on an element that is `display: none` until `:hover`/`:focus`, and browsers
 * do not fetch a background for an unrendered element — so the ~100 KB large
 * rendition costs nothing on page load and is fetched once, on first hover,
 * then served from cache for a year. That is what lets a 31-row decklist carry
 * a readable preview per row without weighing anything.
 *
 * The thumbnail is a real <img> with explicit dimensions and `loading="lazy"`,
 * so rows below the fold cost nothing and none of them shift the layout.
 *
 * A card with no mirrored art degrades to an empty frame rather than a broken
 * image, and the row still reads correctly.
 *
 * Lives here rather than in a route because decklists and the rankings boards
 * both render it, and two copies would drift.
 */
export function cardMark(env, card, { href = null } = {}) {
  const thumb = cardImageSrc(env, card, 'small');
  const large = cardImageSrc(env, card, 'large');
  const code = card.public_code || `${card.set_id}-${card.collector_number}`;

  const art = thumb
    ? `<img class="card-thumb" src="${esc(thumb)}" width="40" height="56"
             loading="lazy" decoding="async" alt=""/>`
    : '<span class="card-thumb card-thumb--empty" aria-hidden="true"></span>';

  // aria-hidden: the enlargement is the same card the row already names, so a
  // screen reader gains nothing from it.
  const zoom = large
    ? `<span class="card-zoom" aria-hidden="true" style="--art:url('${esc(large)}')"></span>`
    : '';

  // The rankings boards link the name to the card's own page; a decklist does
  // not, because the whole row is already about that card in that deck.
  const name = href
    ? `<a class="card-name strong-link" href="${esc(href)}">${esc(card.name)}</a>`
    : `<span class="card-name">${esc(card.name)}</span>`;

  return `<span class="card-cell"${large ? ' tabindex="0"' : ''}>
          ${art}
          <span class="card-text">
            ${name}
            <span class="card-code">${esc(code)}</span>
          </span>
          ${zoom}
        </span>`;
}
