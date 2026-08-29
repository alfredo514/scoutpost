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
<meta property="og:image" content="${esc(absoluteUrl(env, '/og-image.png'))}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:image:alt" content="Scoutpost — Riftbound top 8s with the build cost attached"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="theme-color" content="#0A1410"/>
${/* The tab icon is the artwork, at the sizes it survives. It is declared
     ahead of anything else because softsauce.co/favicon.ico exists — it belongs
     to the portfolio on the NAS — and a browser falls back to that origin-root
     icon whenever a page does not name its own. */ ''}
<link rel="icon" type="image/png" sizes="32x32" href="${esc(url(env, '/favicon-32.png'))}"/>
<link rel="icon" type="image/png" sizes="48x48" href="${esc(url(env, '/favicon-48.png'))}"/>
<link rel="icon" type="image/png" sizes="96x96" href="${esc(url(env, '/favicon-96.png'))}"/>
<link rel="apple-touch-icon" href="${esc(url(env, '/apple-touch-icon.png'))}"/>
<link rel="icon" type="image/png" sizes="512x512" href="${esc(url(env, '/icon-512.png'))}"/>
${/* Two families, three roles. Chakra Petch is angular and technical for
     headings; IBM Plex Sans and Mono carry body text and every number. The mono
     is not decorative — prices are the point of this site and tabular figures
     keep columns of them aligned. preconnect because the fonts sit on a second
     origin, and display=swap so text is readable before they arrive. */ ''}
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"/>
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

/**
 * The set-era filter bar, shared by /events and /decks.
 *
 * One implementation rather than two copies, because the requirement is that
 * the two bars look and behave identically — and two copies of markup drift the
 * moment either page is touched.
 *
 * Filters are links, like every other filter on this site, so each view is a
 * real shareable URL and none of it needs JavaScript.
 *
 * @param {object} opts
 *   path      base path, e.g. '/decks'
 *   eras      [{ id, name }] newest first, from setEras()
 *   counts    { [eraId]: n } for the badges
 *   selected  active era id, or '' for everything
 *   allLabel  wording of the first pill ('All events' / 'All decks')
 *   total     count for the first pill
 */
/**
 * One filter chip.
 *
 * Every filter on this site is a link, so a chip is an anchor and nothing more.
 * The same markup was written out three times — /cards, /rankings and the set
 * bar below — which is three chances for the active state or the count badge to
 * drift apart. The href is built by the caller, because the URL policy is the
 * one part that really is per-page (which keys survive, whether a page resets).
 *
 * `isDefault` marks a chip that is on because nobody has chosen anything yet.
 * Those get a quiet outline rather than the accent fill, so the green on a page
 * always means "you narrowed this" — see .chip.is-default in styles.css.
 */
export function chipLink({ href, label, count, isActive = false, isDefault = false, icon = null }) {
  const state = isActive ? (isDefault ? ' is-default' : ' is-on') : '';
  return `<a class="chip${state}" href="${esc(href)}"${
    isActive ? ' aria-current="true"' : ''
  }>${
    icon ? `<img class="chip-icon" src="${esc(icon)}" width="16" height="16" alt=""/>` : ''
  }${esc(label)}${
    count === undefined ? '' : `<span class="chip-count">${esc(count)}</span>`
  }</a>`;
}

/**
 * Ordinal suffix for a top-8 placement.
 *
 * Only ever 1-8 here, so this is the whole rule rather than the general case
 * with its 11th/12th/13th exceptions. Both forms are exported because a table
 * column headed "Place" wants a bare `1` with ` st Place` as a separate span,
 * while prose wants `1st` in one piece.
 */
export function ordinalSuffix(n) {
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n] ?? 'th';
}

export function ordinal(n) {
  return `${n}${ordinalSuffix(n)}`;
}

export function eraFilterBar(env, { path, eras, counts, selected, allLabel, total }) {
  const href = (id) => url(env, `${path}${id ? `?set=${id}` : '?set=all'}`);

  /* No chip here is ever `isDefault`. On /events and /decks the no-choice
     default is the newest set, not "All" — so an active "All decks" is an
     explicit choice and earns the accent. */
  const pill = (id, label, count, isActive) =>
    chipLink({ href: href(id), label, count, isActive });

  const pills = [
    pill('', allLabel, total, !selected),
    ...eras.map((e) => pill(e.id, e.name, counts[e.id] ?? 0, selected === e.id)),
  ].join('');

  return `<nav class="era-filter" aria-label="Filter by set">
  <span class="filter-label">Set</span>
  <div class="chips">${pills}</div>
</nav>`;
}

/**
 * The "N older … are hidden" note that sits under a filtered table.
 * Shown only when a filter is actually hiding something.
 */
export function hiddenByFilterNote(env, { path, total, shown, noun }) {
  const hidden = total - shown;
  if (!hidden || hidden <= 0) return '';
  return `<p class="source-note">
      ${esc(hidden)} older ${esc(noun)}${hidden === 1 ? '' : 's'} from earlier sets
      ${hidden === 1 ? 'is' : 'are'} hidden.
      <a href="${esc(url(env, `${path}?set=all`))}">Show all ${esc(noun)}s</a>.
    </p>`;
}
