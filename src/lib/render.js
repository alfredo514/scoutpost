import { SECTIONS } from './sections.js';

/**
 * Shared rendering for Scoutpost pages.
 *
 * Every internal link is built through url() from a single configurable base
 * path, so moving from softsauce.co/scoutpost to a dedicated domain is a config
 * change (BASE_PATH="/") and nothing else. No absolute URLs are hardcoded.
 */

/** Riot "Legal Jibber Jabber" disclaimer. Required verbatim — do not reword. */
export const DISCLAIMER =
  'Scoutpost was created under Riot Games’ "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.';

export function basePath(env) {
  const raw = (env && env.BASE_PATH) || '/scoutpost';
  if (raw === '/' || raw === '') return '';
  return raw.replace(/\/+$/, '');
}

/** Build an internal link: url(env, '/events') → '/scoutpost/events' */
export function url(env, path = '/') {
  const p = path.startsWith('/') ? path : `/${path}`;
  const joined = `${basePath(env)}${p}`;
  return joined === '' ? '/' : joined;
}

/** Absolute URL, for canonical tags and the sitemap only. */
export function absoluteUrl(env, path = '/') {
  const origin = (env && env.SITE_ORIGIN) || 'https://softsauce.co';
  return `${origin.replace(/\/+$/, '')}${url(env, path)}`;
}

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function money(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `$${Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function placeLabel(event) {
  const parts = [event.city, event.state, event.country].filter(Boolean);
  return parts.join(', ');
}

/** Fixed-height ad container. Reserved now so adding ads later cannot shift layout. */
export function adSlot(kind = 'leaderboard') {
  const sizes = { leaderboard: 'ad-slot--leaderboard', rectangle: 'ad-slot--rectangle' };
  const cls = sizes[kind] ?? sizes.leaderboard;
  return `<div class="ad-slot ${cls}" aria-hidden="true" data-ad-slot="${esc(kind)}"></div>`;
}

/** schema.org BreadcrumbList. crumbs: [{ name, path }] — last item is the current page. */
function breadcrumbJsonLd(env, crumbs) {
  if (!crumbs || crumbs.length === 0) return '';
  const items = crumbs.map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: c.name,
    item: absoluteUrl(env, c.path),
  }));
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items,
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(
    /</g,
    '\\u003c',
  )}</script>`;
}

function breadcrumbNav(env, crumbs) {
  if (!crumbs || crumbs.length < 2) return '';
  const parts = crumbs.map((c, i) =>
    i === crumbs.length - 1
      ? `<span aria-current="page">${esc(c.name)}</span>`
      : `<a href="${esc(url(env, c.path))}">${esc(c.name)}</a>`,
  );
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.join(
    '<span class="crumb-sep" aria-hidden="true">/</span>',
  )}</nav>`;
}

/**
 * Full page shell.
 * @param {object} env  Pages env (BASE_PATH, SITE_ORIGIN)
 * @param {object} opts { title, description, path, crumbs, body, jsonLd }
 */
export function layout(env, opts) {
  const {
    title,
    description = 'Riftbound top-8 decklists with live build costs, card prices and event coverage.',
    path = '/',
    crumbs = [],
    body = '',
    jsonLd = '',
    robots = '',
  } = opts;

  // The nav's shape is fixed by SECTIONS, planned pages included. Planned ones
  // route to a real placeholder rather than 404, and are marked so a reader can
  // tell before clicking that there is nothing to read yet.
  const navHtml = SECTIONS.map((s) => {
    const current = path === s.path || path.startsWith(`${s.path}/`);
    const cls = [current ? 'active' : '', s.status === 'planned' ? 'is-planned' : '']
      .filter(Boolean)
      .join(' ');
    return `<a href="${esc(url(env, s.path))}"${cls ? ` class="${cls}"` : ''}${
      current ? ' aria-current="page"' : ''
    }>${esc(s.label)}${
      s.status === 'planned' ? '<span class="soon" aria-label="coming soon">soon</span>' : ''
    }</a>`;
  }).join('');

  const footerNavHtml = [{ path: '/', label: 'Home' }, ...SECTIONS]
    .map(
      (s) =>
        `<a href="${esc(url(env, s.path))}">${esc(s.label)}${
          s.status === 'planned' ? '<span class="soon">soon</span>' : ''
        }</a>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
${robots ? `<meta name="robots" content="${esc(robots)}"/>\n` : ''}<link rel="canonical" href="${esc(absoluteUrl(env, path))}"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="Scoutpost"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${esc(absoluteUrl(env, path))}"/>
<meta name="twitter:card" content="summary"/>
<meta name="theme-color" content="#08150e"/>
<link rel="icon" href="${esc(url(env, '/favicon.svg'))}" type="image/svg+xml"/>
<link rel="stylesheet" href="${esc(url(env, '/styles.css'))}"/>
${breadcrumbJsonLd(env, crumbs)}
${jsonLd}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${esc(url(env, '/'))}">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-name">Scoutpost</span>
    </a>
    <nav class="site-nav" aria-label="Primary">${navHtml}</nav>
  </div>
</header>
<main id="main" class="wrap">
${breadcrumbNav(env, crumbs)}
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <nav class="footer-nav" aria-label="Footer">${footerNavHtml}</nav>
    <p class="sources">
      Card data from Riftscribe. Price data from TCGCSV, sourced from TCGplayer
      market prices and updated daily.
    </p>
    <p class="disclaimer">${esc(DISCLAIMER)}</p>
  </div>
</footer>
</body>
</html>`;
}

export function htmlResponse(html, { status = 200, maxAge = 300 } = {}) {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short edge cache: prices move once a day, but pages must not go stale
      // for long after a new event is imported.
      'cache-control': `public, max-age=60, s-maxage=${maxAge}`,
    },
  });
}

export function notFound(env, what = 'Page') {
  return htmlResponse(
    layout(env, {
      title: `Not found — Scoutpost`,
      path: '/',
      body: `<section class="panel empty">
        <h1>${esc(what)} not found</h1>
        <p>That page doesn’t exist, or the data hasn’t been imported yet.</p>
        <p><a class="btn" href="${esc(url(env, '/events'))}">Browse events</a></p>
      </section>`,
    }),
    { status: 404, maxAge: 60 },
  );
}
