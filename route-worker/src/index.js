/**
 * Subpath router for softsauce.co/scoutpost.
 *
 * WHY THIS EXISTS
 * softsauce.co is served from an origin (an nginx box behind Cloudflare), while
 * Scoutpost lives on Cloudflare Pages. A Worker route lets one path on the
 * existing domain be served by Pages without touching the origin at all.
 *
 * It strips the /scoutpost prefix before forwarding, so the Pages project sees
 * clean paths (/events) while the app renders links with BASE_PATH=/scoutpost.
 * That keeps Pages Functions routing normal and makes the eventual move to a
 * dedicated domain a config change: delete this Worker, set BASE_PATH="/".
 *
 * Deploy:  cd route-worker && npx wrangler deploy
 * Route:   softsauce.co/scoutpost*   (configured in wrangler.toml)
 */

const PREFIX = '/scoutpost';

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    // Everything outside the prefix belongs to the existing site.
    if (incoming.pathname !== PREFIX && !incoming.pathname.startsWith(`${PREFIX}/`)) {
      return fetch(request);
    }

    const target = new URL(env.PAGES_ORIGIN);
    const stripped = incoming.pathname.slice(PREFIX.length) || '/';
    target.pathname = stripped;
    target.search = incoming.search;

    const proxied = new Request(target, request);
    // Let the Pages app know which host the visitor actually used.
    proxied.headers.set('X-Forwarded-Host', incoming.host);

    const res = await fetch(proxied);

    // Rewrite any absolute redirect back into the public path space.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        const to = new URL(location, target);
        if (to.host === target.host) {
          const headers = new Headers(res.headers);
          headers.set('location', `${PREFIX}${to.pathname}${to.search}`);
          return new Response(res.body, { status: res.status, headers });
        }
      }
    }

    return res;
  },
};
