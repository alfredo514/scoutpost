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

import { url } from './render.js';

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
