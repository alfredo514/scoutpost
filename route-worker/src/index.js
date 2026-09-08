/**
 * Subpath router for softsauce.co/scoutpost.
 *
 * WHY THIS EXISTS
 * softsauce.co is served from an origin (an nginx box behind Cloudflare), while
 * Scoutpost is a separate Worker with static assets. A Worker route lets one
 * path on the existing domain be served by that Worker without touching the
 * origin at all.
 *
 * It strips the /scoutpost prefix before forwarding, so the site Worker sees
 * clean paths (/events) while the app renders links with BASE_PATH=/scoutpost.
 * That keeps its routing normal and makes the eventual move to a dedicated
 * domain a config change: delete this Worker, set BASE_PATH="/".
 *
 * `PAGES_ORIGIN` is a misnomer left from when the site really was a Pages
 * project. It is the site Worker's URL. Renaming it means changing this file
 * and route-worker/wrangler.toml in the same deploy — deploy only one and the
 * whole site 500s — so it stays as it is until there is a reason to touch it.
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
