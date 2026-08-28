/**
 * Scoutpost — Worker entrypoint.
 *
 * Cloudflare serves anything in public/ as a static asset first; whatever
 * doesn't match a file falls through to this router. So /styles.css comes
 * straight off the edge, and /events lands here.
 *
 * Paths arriving here are always base-path free. When the site is served at
 * softsauce.co/scoutpost, route-worker/ strips the prefix before forwarding,
 * and the app renders its own links back with BASE_PATH. Moving to a dedicated
 * domain means setting BASE_PATH="/" and deleting that Worker — nothing here
 * changes.
 */

import { notFound } from './lib/render.js';
import { onRequestGet as home } from './routes/home.js';
import { onRequestGet as eventsList } from './routes/events-list.js';
import { onRequestGet as eventDetail } from './routes/event-detail.js';
import { onRequestGet as decksList } from './routes/decks-list.js';
import { onRequestGet as deckDetail } from './routes/deck-detail.js';
import { onRequestGet as sitemap } from './routes/sitemap.js';
import { onRequestGet as cardImage } from './routes/card-image.js';
import { onRequestGet as cards } from './routes/cards.js';
import { onRequestGet as cardDetail } from './routes/card-detail.js';
import { onRequestGet as rankings } from './routes/rankings.js';
import { plannedHandler } from './routes/planned.js';
import { plannedSections } from './lib/sections.js';

/** [pattern, handler, ...capture group names] */
const ROUTES = [
  [/^\/$/, home],
  [/^\/events$/, eventsList],
  [/^\/events\/([A-Za-z0-9._-]+)$/, eventDetail, 'slug'],
  [/^\/decks$/, decksList],
  [/^\/decks\/([A-Za-z0-9._-]+)$/, deckDetail, 'id'],
  [/^\/cards$/, cards],
  [/^\/cards\/([A-Za-z0-9._-]+)$/, cardDetail, 'id'],
  [/^\/rankings$/, rankings],
  [/^\/sitemap\.xml$/, sitemap],
  [/^\/card-image\/([a-z]+)\/([A-Za-z0-9._-]+)$/, cardImage, 'size', 'file'],

  // Planned sections get a real route so the nav can show the site's final
  // shape without a dead link. To ship one: set its status to 'live' in
  // sections.js and replace its entry here with the real handler.
  ...plannedSections().map((s) => [
    new RegExp(`^${s.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    plannedHandler(s.path),
  ]),
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Normalise a trailing slash so /events/ and /events are the same page
    // rather than two URLs serving identical content.
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.replace(/\/+$/, '');
      return Response.redirect(`${url.origin}${path}${url.search}`, 308);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    for (const [pattern, handler, ...names] of ROUTES) {
      const match = pattern.exec(path);
      if (!match) continue;

      const params = {};
      names.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });

      try {
        return await handler({ request, env, ctx, params });
      } catch (err) {
        // A database hiccup should show a real page, not a raw stack trace.
        console.error('[scoutpost] route error', path, err?.stack || err?.message || err);
        return new Response('Something went wrong on our end.', {
          status: 500,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
    }

    return notFound(env);
  },
};
