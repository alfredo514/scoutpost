/**
 * Card catalog ingestion — Riftscribe.
 *
 * Verified API behaviour (checked against the live endpoint):
 *   GET https://riftscribe.gg/api/cards?limit=200&offset=0
 *   → a BARE JSON ARRAY. No envelope, no total count, no next-page pointer.
 *   → `limit` is capped: 200 works, 500 silently returns an EMPTY array.
 *     That is the dangerous failure mode here — an over-large page size looks
 *     like "no cards left" rather than an error, so PAGE_SIZE stays at 200 and
 *     a zero-length first page is treated as a hard failure, never as "done".
 *
 * Each card also carries `image_blur_data_url`, a multi-kilobyte base64 blob.
 * It is deliberately never stored.
 */

import { IngestError, fetchJson, log, nonEmptyString, runBatched, warn } from './util.js';

const API = 'https://riftscribe.gg/api/cards';
const PAGE_SIZE = 200;
const MAX_PAGES = 100; // hard stop: 20k cards, far beyond the real catalogue
const MIN_EXPECTED_CARDS = 100; // below this, assume a broken feed and abort

/** Validate one card. Returns a normalised row, or null if unusable. */
function normaliseCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!nonEmptyString(raw.id)) return null;
  if (!nonEmptyString(raw.name)) return null;
  if (!nonEmptyString(raw.set_id)) return null;

  const number = Number(raw.collector_number);
  if (!Number.isInteger(number) || number < 0) return null;

  // Riftscribe publishes four renditions. Sizes measured 2026-08-27 on
  // OGN-001: small 25 KB (300x418), medium 71 KB (600x837), large 97 KB
  // (744x1039), original PNG 778 KB.
  //
  // We keep small for list rows and large for previews and card pages. Large
  // is 8x lighter than the original at ample resolution, and the webp
  // renditions are served `immutable` with a one-year cache while the original
  // gets only max-age=14400 — so the PNG is both the heaviest and the worst
  // cached. Its URL is still recorded in image_url as the canonical source,
  // but no page should ever serve it.
  const thumbs = raw.image_thumb && typeof raw.image_thumb === 'object' ? raw.image_thumb : {};
  const thumb = thumbs.small ?? thumbs.medium ?? null;
  const large = thumbs.large ?? thumbs.medium ?? thumbs.small ?? null;

  // Riftscribe exposes finish through variant/rarity naming rather than a field.
  const rarity = typeof raw.rarity === 'string' ? raw.rarity : null;
  const finish = /foil|showcase|signature/i.test(`${rarity ?? ''}`) ? 'foil' : 'normal';

  return {
    id: String(raw.id),
    name: String(raw.name),
    set_id: String(raw.set_id).toUpperCase(),
    collector_number: number,
    variant: nonEmptyString(raw.variant) ? String(raw.variant) : '',
    rarity,
    finish,
    card_type: typeof raw.type === 'string' ? raw.type : null,
    faction: typeof raw.faction === 'string' ? raw.faction : null,
    public_code: nonEmptyString(raw.public_code) ? String(raw.public_code) : null,
    image_url: nonEmptyString(raw.image) ? String(raw.image) : null,
    image_thumb_url: nonEmptyString(thumb) ? String(thumb) : null,
    image_large_url: nonEmptyString(large) ? String(large) : null,
  };
}

/** Page through the whole catalogue, validating as we go. Nothing is written yet. */
export async function fetchCatalog() {
  const cards = [];
  const seen = new Set();
  let rejected = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const url = `${API}?limit=${PAGE_SIZE}&offset=${offset}`;
    const body = await fetchJson(url, { label: `riftscribe cards@${offset}` });

    if (!Array.isArray(body)) {
      throw new IngestError('Riftscribe returned a non-array payload', {
        offset,
        got: typeof body,
      });
    }

    if (body.length === 0) {
      if (page === 0) {
        // An empty FIRST page means the feed is broken, not that there are no
        // cards. Never treat this as a successful empty catalogue.
        throw new IngestError('Riftscribe returned zero cards on the first page');
      }
      break; // genuine end of pagination
    }

    for (const raw of body) {
      const card = normaliseCard(raw);
      if (!card) {
        rejected++;
        continue;
      }
      if (seen.has(card.id)) continue; // defend against overlapping pages
      seen.add(card.id);
      cards.push(card);
    }

    if (body.length < PAGE_SIZE) break; // last page
  }

  if (rejected > 0) warn(`catalog: skipped ${rejected} malformed card record(s)`);

  if (cards.length < MIN_EXPECTED_CARDS) {
    throw new IngestError(
      `catalog too small: got ${cards.length} cards, expected at least ${MIN_EXPECTED_CARDS}`,
    );
  }

  log(`catalog: validated ${cards.length} cards across ${new Set(cards.map((c) => c.set_id)).size} sets`);
  return cards;
}

/**
 * Write the catalogue. Only called once the payload has fully validated.
 * Cards are upserted: the catalogue is authoritative and safe to refresh,
 * unlike prices which are append-only history.
 */
export async function writeCatalog(db, cards, setNames = new Map()) {
  const setIds = [...new Set(cards.map((c) => c.set_id))];

  const setStmts = setIds.map((id) => {
    const meta = setNames.get(id) ?? {};
    return db
      .prepare(
        `INSERT INTO sets (id, code, name, release_date, tcgcsv_group_id, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name            = COALESCE(excluded.name, sets.name),
           release_date    = COALESCE(excluded.release_date, sets.release_date),
           tcgcsv_group_id = COALESCE(excluded.tcgcsv_group_id, sets.tcgcsv_group_id),
           updated_at      = datetime('now')`,
      )
      .bind(id, id, meta.name ?? id, meta.releaseDate ?? null, meta.groupId ?? null);
  });

  const cardStmts = cards.map((c) =>
    db
      .prepare(
        `INSERT INTO cards
           (id, name, set_id, collector_number, variant, rarity, finish,
            card_type, faction, public_code, image_url, image_thumb_url,
            image_large_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name             = excluded.name,
           set_id           = excluded.set_id,
           collector_number = excluded.collector_number,
           variant          = excluded.variant,
           rarity           = excluded.rarity,
           finish           = excluded.finish,
           card_type        = excluded.card_type,
           faction          = excluded.faction,
           public_code      = excluded.public_code,
           image_url        = excluded.image_url,
           image_thumb_url  = excluded.image_thumb_url,
           image_large_url  = excluded.image_large_url,
           updated_at       = datetime('now')`,
      )
      .bind(
        c.id,
        c.name,
        c.set_id,
        c.collector_number,
        c.variant,
        c.rarity,
        c.finish,
        c.card_type,
        c.faction,
        c.public_code,
        c.image_url,
        c.image_thumb_url,
        c.image_large_url,
      ),
  );

  // Sets first — cards reference them.
  await runBatched(db, setStmts);
  const written = await runBatched(db, cardStmts);
  log(`catalog: wrote ${setIds.length} sets, ${written} cards`);
  return written;
}
