/**
 * Shared helpers for the ingestion worker.
 *
 * Everything here exists to serve one rule: a missing day is fine, a corrupted
 * day is not. Fetches are bounded and retried, payloads are validated before
 * anything touches the database, and failures are loud.
 */

export const LOG_PREFIX = '[scoutpost:ingest]';

export function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

export function warn(...args) {
  console.warn(LOG_PREFIX, 'WARN', ...args);
}

export function fail(...args) {
  console.error(LOG_PREFIX, 'ERROR', ...args);
}

/** Today's date in UTC as YYYY-MM-DD. TCGCSV publishes on a UTC day boundary. */
export function utcDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** Raised when a payload fails validation. Aborts the run before any write. */
export class IngestError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'IngestError';
    this.detail = detail;
  }
}

/**
 * Fetch JSON with a timeout, bounded retries and strict response checks.
 * Throws IngestError rather than returning a half-usable value.
 */
export async function fetchJson(url, { timeoutMs = 20000, retries = 2, label = url } = {}) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = 500 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
      warn(`retry ${attempt}/${retries} for ${label}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          // Identify ourselves; TCGCSV is one person's mirror, be a good citizen.
          'User-Agent': 'Scoutpost/1.0 (+https://softsauce.co/scoutpost)',
          Accept: 'application/json',
        },
        cf: { cacheTtl: 0 },
      });

      if (!res.ok) {
        lastErr = new IngestError(`HTTP ${res.status} from ${label}`);
        continue;
      }

      const text = await res.text();

      // An HTML error page returned with a 200 is the classic silent corruption.
      const head = text.trimStart().slice(0, 1);
      if (head !== '{' && head !== '[') {
        lastErr = new IngestError(
          `${label} returned non-JSON body (starts with ${JSON.stringify(head)})`,
        );
        continue;
      }

      try {
        return JSON.parse(text);
      } catch (e) {
        lastErr = new IngestError(`${label} returned unparseable JSON: ${e.message}`);
        continue;
      }
    } catch (e) {
      lastErr =
        e.name === 'AbortError'
          ? new IngestError(`${label} timed out after ${timeoutMs}ms`)
          : new IngestError(`${label} fetch failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new IngestError(`${label} failed for an unknown reason`);
}

/** A finite, non-negative number, or null. Rejects NaN, Infinity, negatives, strings. */
export function money(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  // A four-figure single is real (see Vendetta chase cards); six figures is not.
  if (value > 100000) return null;
  return Math.round(value * 100) / 100;
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Split an array into chunks — D1 batches should stay modest in size. */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Run prepared statements in chunked batches.
 * Each chunk is atomic in D1; chunking keeps individual batches within limits.
 */
export async function runBatched(db, statements, { size = 50 } = {}) {
  let written = 0;
  for (const group of chunk(statements, size)) {
    await db.batch(group);
    written += group.length;
  }
  return written;
}

/** Record the outcome of a job so failures are visible after the fact. */
export async function recordRun(db, run) {
  try {
    await db
      .prepare(
        `INSERT INTO ingest_runs
           (started_at, finished_at, job, status, trigger, rows_written, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.startedAt,
        new Date().toISOString(),
        run.job,
        run.status,
        run.trigger ?? null,
        run.rowsWritten ?? 0,
        run.message ?? null,
      )
      .run();
  } catch (e) {
    // Never let bookkeeping failure mask the real error.
    fail('could not write ingest_runs row:', e.message);
  }
}
