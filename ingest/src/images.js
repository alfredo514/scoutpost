/**
 * Mirror card art from Riftscribe's CDN into R2.
 *
 * Why mirror at all: hotlinking cdn.riftscribe.gg would work — the URLs are
 * already in D1 — but Riftscribe is a free one-person project, and hotlinking
 * moves this site's image bandwidth onto their bill. It is also one Cloudflare
 * toggle away from breaking every image here without warning.
 *
 * Two renditions per card, measured 2026-08-27 across a 25-card sample:
 *   small  ~26 KB (300x418)   list rows
 *   large  ~100 KB (744x1039) previews and card pages
 * The 778 KB original PNG is deliberately NOT mirrored — 8x heavier than large
 * for no useful gain, and ~918 MB across the catalogue instead of ~145 MB.
 *
 * BATCHING IS NOT OPTIONAL. Each card costs two `fetch()` calls, and Workers
 * cap subrequests per invocation (50 on the free plan). R2 binding calls do not
 * count toward that, but the CDN fetches do — so a full 1,180-card backfill can
 * never be one invocation. Callers pass a batch size and repeat until
 * `remaining` reaches 0. DEFAULT_BATCH stays under the free-plan ceiling.
 *
 * Re-running is cheap by construction, not by luck: `image_mirrored` records
 * the basename already in R2, and only cards whose basename differs (or is
 * NULL) are fetched. Riftscribe content-hashes filenames, so changed art means
 * a changed name and an automatic re-mirror.
 */

import { IngestError, log, runBatched, warn } from './util.js';

/**
 * 20 cards = 40 fetches, inside the 50-subrequest cap with room to spare.
 *
 * The cap is real and was measured, not assumed: a run at limit=50 mirrored
 * exactly 25 cards (50 fetches) and failed the other 25 on subrequest
 * exhaustion. MAX_BATCH is therefore 25 — the true ceiling — so asking for more
 * is refused rather than quietly wasting half the batch. Raise it only if this
 * account moves to a Workers plan with a higher limit, and re-measure first.
 */
const DEFAULT_BATCH = 20;
const MAX_BATCH = 25;

/** A year, immutable — safe because the filename carries a content hash. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * A card needs mirroring when it has both URLs and either was never mirrored,
 * or the large URL no longer ends in the basename we recorded — which is how a
 * content-hashed filename tells us the art changed.
 *
 * Shared by the batch query and the remaining-count so the two can never
 * disagree about what "pending" means.
 */
const NEEDS_MIRROR = `
  image_thumb_url IS NOT NULL
  AND image_large_url IS NOT NULL
  AND (image_mirrored IS NULL OR image_large_url NOT LIKE '%/' || image_mirrored)`;

/**
 * R2 key for a rendition: 'small/ogn-001-298-8de89b4b.webp'.
 * The site Worker derives the same key when serving; keep the two in step.
 */
export function imageKey(size, url) {
  const name = new URL(url).pathname.split('/').pop();
  if (!name) throw new IngestError(`could not derive a filename from ${url}`);
  return `${size}/${name}`;
}

/** Basename of the large rendition — the mirror-state marker stored in D1. */
function markerFor(card) {
  return new URL(card.image_large_url).pathname.split('/').pop();
}

/** Copy one rendition into R2. Returns bytes written, or 0 if already present. */
async function mirrorOne(bucket, size, url) {
  const key = imageKey(size, url);

  const res = await fetch(url, {
    headers: { Accept: 'image/webp,image/*', 'User-Agent': 'Scoutpost/1.0 image mirror' },
  });
  if (!res.ok) throw new IngestError(`${url} → HTTP ${res.status}`);

  const body = await res.arrayBuffer();
  if (body.byteLength === 0) throw new IngestError(`${url} returned an empty body`);

  await bucket.put(key, body, {
    httpMetadata: {
      contentType: res.headers.get('content-type') ?? 'image/webp',
      cacheControl: CACHE_CONTROL,
    },
  });
  return body.byteLength;
}

/**
 * Mirror one batch of not-yet-mirrored cards.
 * @returns {{ mirrored, objects, bytes, failed, remaining }}
 */
export async function mirrorImages(db, bucket, { limit = DEFAULT_BATCH } = {}) {
  if (!bucket) throw new IngestError('no IMAGES binding — is the R2 bucket bound in wrangler.toml?');

  const batch = Math.min(Math.max(1, Number(limit) || DEFAULT_BATCH), MAX_BATCH);

  const { results: pending } = await db
    .prepare(`SELECT id, image_thumb_url, image_large_url FROM cards WHERE ${NEEDS_MIRROR} LIMIT ?`)
    .bind(batch)
    .all();

  let objects = 0;
  let bytes = 0;
  let failed = 0;
  const done = [];

  for (const card of pending ?? []) {
    try {
      // Both renditions must land before the card counts as mirrored, so a
      // partial failure retries the whole card rather than leaving a half-
      // mirrored entry that never gets fixed.
      bytes += await mirrorOne(bucket, 'small', card.image_thumb_url);
      bytes += await mirrorOne(bucket, 'large', card.image_large_url);
      objects += 2;
      done.push({ id: card.id, marker: markerFor(card) });
    } catch (e) {
      // One bad image must not abandon the batch. It stays unmirrored and is
      // picked up next run.
      failed++;
      warn(`images: ${card.id} skipped — ${e.message}`);
    }
  }

  if (done.length) {
    await runBatched(
      db,
      done.map((d) =>
        db.prepare('UPDATE cards SET image_mirrored = ? WHERE id = ?').bind(d.marker, d.id),
      ),
    );
  }

  const remaining = await countPending(db);
  log(
    `images: mirrored ${done.length} card(s), ${objects} object(s), ` +
      `${(bytes / 1024 / 1024).toFixed(2)} MB, ${failed} failed, ${remaining} remaining`,
  );

  return { mirrored: done.length, objects, bytes, failed, remaining };
}

/** How many cards still need mirroring. */
export async function countPending(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE ${NEEDS_MIRROR}`).first();
  return row?.n ?? 0;
}
