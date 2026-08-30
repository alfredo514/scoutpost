/**
 * Scoutpost ingestion worker.
 *
 * A STANDALONE Worker, deliberately separate from the site. It binds to the
 * same D1 database but deploys on its own.
 *
 * The split is historical AND still wanted. Originally the site was a Pages
 * project, which cannot run cron triggers at all. The site is now a Worker and
 * could carry the schedule itself — but keeping them apart means a slow or
 * failing data pull cannot touch request serving, and either side ships without
 * redeploying the other. Do not merge them back on the grounds that Workers
 * support cron; that was never the only reason.
 *
 * Triggers
 *   cron   — daily, after TCGCSV publishes (~20:00 UTC)
 *   manual — POST /run?job=all  with  Authorization: Bearer <INGEST_TOKEN>
 *
 * Failure policy: every job fails closed. A job that cannot validate its
 * payload throws before touching the database and records the reason in
 * ingest_runs. A missing day is acceptable; a corrupted day is not.
 */

import { fetchCatalog, writeCatalog } from './catalog.js';
import { fetchPromoCards, promoSetMeta } from './promos.js';
import {
  collectPrices,
  fetchGroups,
  snapshotDeckCosts,
  writeCardText,
  writePrices,
  writeProductLinks,
} from './prices.js';
import { countPending, mirrorImages } from './images.js';
import { fail, log, recordRun, utcDate, warn } from './util.js';

/** Refresh the card catalogue from Riftscribe. */
async function runCatalog(env, trigger) {
  const startedAt = new Date().toISOString();
  try {
    // Set names/dates come from TCGplayer groups; the catalogue itself is
    // Riftscribe's. If groups are unavailable we still ingest cards.
    let setMeta = new Map();
    let groups = [];
    try {
      groups = await fetchGroups();
      setMeta = new Map(
        groups.map((g) => [
          g.abbreviation,
          { name: g.name, releaseDate: g.releaseDate, groupId: g.groupId },
        ]),
      );
      // Promo sets override their own entries: shorter names, and a NULL
      // release date so they stay out of the era machinery. See promos.js.
      for (const [id, meta] of promoSetMeta(groups)) setMeta.set(id, meta);
    } catch (e) {
      log(`catalog: proceeding without TCGplayer set metadata (${e.message})`);
    }

    const cards = await fetchCatalog();

    // Riftscribe has no promos; TCGplayer does. A failure here must not lose
    // the 1,180 real cards we already fetched, so it is caught and logged.
    try {
      const promos = await fetchPromoCards(groups);
      if (promos.length) {
        cards.push(...promos);
        log(`catalog: +${promos.length} promo cards from TCGplayer`);
      }
    } catch (e) {
      warn(`catalog: promo pull failed, continuing without them — ${e.message}`);
    }
    const rowsWritten = await writeCatalog(env.DB, cards, setMeta);
    await recordRun(env.DB, { startedAt, job: 'catalog', status: 'ok', trigger, rowsWritten });
    return { job: 'catalog', status: 'ok', rowsWritten };
  } catch (e) {
    fail('catalog job failed:', e.message, e.detail ?? '');
    await recordRun(env.DB, {
      startedAt,
      job: 'catalog',
      status: 'failed',
      trigger,
      message: e.message,
    });
    return { job: 'catalog', status: 'failed', message: e.message };
  }
}

/** Pull today's prices and snapshot deck costs. */
async function runPrices(env, trigger) {
  const startedAt = new Date().toISOString();
  try {
    const groups = await fetchGroups();
    const collected = await collectPrices(env.DB, groups);
    const rowsWritten = await writePrices(env.DB, collected);
    await writeProductLinks(env.DB, collected.productLinks);
    // Card text rides along with the same product walk — see writeCardText.
    const textRows = await writeCardText(env.DB, collected.cardText ?? []);
    await snapshotDeckCosts(env.DB, collected.date);

    await recordRun(env.DB, {
      startedAt,
      job: 'prices',
      status: 'ok',
      trigger,
      rowsWritten,
      message: `${collected.unmatched} unmatched singles, ${textRows} card texts`,
    });
    return { job: 'prices', status: 'ok', rowsWritten };
  } catch (e) {
    // Expected, survivable outcomes (source down, payload malformed, floors not
    // met) all land here. Nothing was written.
    fail('price job skipped/failed:', e.message, e.detail ?? '');
    await recordRun(env.DB, {
      startedAt,
      job: 'prices',
      status: 'skipped',
      trigger,
      message: e.message,
    });
    return { job: 'prices', status: 'skipped', message: e.message };
  }
}

/**
 * Mirror a batch of card art into R2.
 *
 * One batch per invocation, by necessity — see the subrequest note in
 * images.js. The nightly cron therefore catches up gradually after a new set
 * rather than in one run, which is fine: nothing is user-visible until the art
 * lands, and a missing image degrades to a placeholder.
 *
 * Bytes and object counts go into ingest_runs so a runaway shows up as an
 * anomalous row in data we already keep, not only on a bill.
 */
async function runImages(env, trigger, { limit } = {}) {
  const startedAt = new Date().toISOString();
  try {
    const r = await mirrorImages(env.DB, env.IMAGES, { limit });
    await recordRun(env.DB, {
      startedAt,
      job: 'images',
      status: 'ok',
      trigger,
      rowsWritten: r.objects,
      message: `${(r.bytes / 1024 / 1024).toFixed(2)} MB, ${r.failed} failed, ${r.remaining} remaining`,
    });
    return { job: 'images', status: 'ok', ...r };
  } catch (e) {
    fail('images job failed:', e.message, e.detail ?? '');
    await recordRun(env.DB, {
      startedAt,
      job: 'images',
      status: 'failed',
      trigger,
      message: e.message,
    });
    return { job: 'images', status: 'failed', message: e.message };
  }
}

async function runAll(env, trigger) {
  log(`run start (${trigger}) for ${utcDate()}`);
  const catalog = await runCatalog(env, trigger);
  const prices = await runPrices(env, trigger);
  // Runs last and only when there is something to do, so the catalogue and
  // prices — the jobs the site actually depends on — never lose subrequest
  // budget to image mirroring.
  const pending = await countPending(env.DB).catch(() => 0);
  const images = pending > 0 ? await runImages(env, trigger) : { job: 'images', status: 'idle' };
  log('run complete', JSON.stringify({ catalog, prices, images }));
  return { date: utcDate(), catalog, prices, images };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const last = await env.DB.prepare(
        'SELECT job, status, started_at, rows_written, message FROM ingest_runs ORDER BY id DESC LIMIT 5',
      ).all();
      return Response.json({ ok: true, recentRuns: last.results ?? [] });
    }

    if (url.pathname !== '/run') {
      return new Response('Not found', { status: 404 });
    }

    // Manual runs are privileged: they write to the production database.
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    const job = url.searchParams.get('job') ?? 'all';
    let result;
    if (job === 'catalog') result = await runCatalog(env, 'manual');
    else if (job === 'prices') result = await runPrices(env, 'manual');
    else if (job === 'images') {
      // ?limit= lets a backfill loop pick its batch size. Repeat until the
      // returned `remaining` is 0.
      result = await runImages(env, 'manual', { limit: url.searchParams.get('limit') });
    } else result = await runAll(env, 'manual');

    return Response.json(result);
  },
};
