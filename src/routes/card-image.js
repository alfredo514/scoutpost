/**
 * Serve mirrored card art out of R2.
 *
 * Keys are `<size>/<content-hashed-filename>.webp`, written by the ingest
 * Worker's mirror job (ingest/src/images.js). Because the filename carries a
 * content hash, a given key's bytes never change — so this can be cached
 * immutably for a year, and Cloudflare's edge answers almost every request
 * without touching R2 at all. That is what keeps Class B operations far below
 * raw page-view maths.
 *
 * A miss returns 404 rather than falling back to the Riftscribe CDN. Silently
 * hotlinking on miss would put their bandwidth back in the serving path and
 * hide mirror failures; a visible gap is better, and the ingest retries the
 * card on its next run.
 */


const SIZES = new Set(['small', 'large']);

export async function onRequestGet({ request, env, params }) {
  const { size, file } = params;

  if (!SIZES.has(size)) return new Response('Not found', { status: 404 });
  // Keys are flat; a slash or traversal segment means a malformed request.
  if (!file || file.includes('/') || file.includes('..')) {
    return new Response('Not found', { status: 404 });
  }
  if (!env.IMAGES) return new Response('Image storage unavailable', { status: 503 });

  const key = `${size}/${file}`;
  const object = await env.IMAGES.get(key, {
    onlyIf: request.headers.get('if-none-match')
      ? { etagDoesNotMatch: request.headers.get('if-none-match').replace(/"/g, '') }
      : undefined,
  });

  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');

  // onlyIf matched: the client's copy is current, send no body.
  if (!object.body) return new Response(null, { status: 304, headers });

  return new Response(object.body, { headers });
}
