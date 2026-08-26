import { absoluteUrl } from './_lib/render.js';
import { allDeckIds, allEventSlugs } from './_lib/queries.js';

/**
 * Sitemap for the Scoutpost section.
 *
 * When deployed under a base path, this lives at <base>/sitemap.xml and lists
 * only URLs at or below that path — which is what the sitemaps protocol
 * requires. Submit this exact URL in Search Console.
 */
export async function onRequestGet({ env }) {
  const [events, decks] = await Promise.all([allEventSlugs(env.DB), allDeckIds(env.DB)]);

  const urls = [
    { loc: absoluteUrl(env, '/'), priority: '1.0', changefreq: 'daily' },
    { loc: absoluteUrl(env, '/events'), priority: '0.9', changefreq: 'daily' },
    { loc: absoluteUrl(env, '/decks'), priority: '0.8', changefreq: 'daily' },
    ...events.map((e) => ({
      loc: absoluteUrl(env, `/events/${e.id}`),
      lastmod: e.date,
      priority: '0.8',
      changefreq: 'weekly',
    })),
    ...decks.map((d) => ({
      loc: absoluteUrl(env, `/decks/${d.id}`),
      priority: '0.6',
      changefreq: 'weekly',
    })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600',
    },
  });
}
