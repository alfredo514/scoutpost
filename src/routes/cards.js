/**
 * /cards — the card browser.
 *
 * Filters are **links, not scripts**. Every filtered view is a real URL that can
 * be shared, bookmarked, opened in a new tab and crawled, and the page works
 * with JavaScript disabled — which keeps the site's no-JS rule intact and is
 * also simply the better behaviour for a browse page.
 *
 * Cards are ordered by price descending because that is this site's angle: the
 * first question anyone brings to a card list is which ones are expensive.
 * Unpriced cards sort last rather than appearing to be free.
 */

import {
  adSlot,
  esc,
  htmlResponse,
  layout,
  money,
  url,
} from '../lib/render.js';
import { cardFacets, countCards, latestPriceDate, listCards } from '../lib/queries.js';
import { cardImageSrc } from '../lib/images.js';

const PER_PAGE = 50;

/** Colour names as printed, from the lowercase values the catalogue stores. */
const COLOR_LABELS = {
  body: 'Body',
  calm: 'Calm',
  chaos: 'Chaos',
  fury: 'Fury',
  mind: 'Mind',
  order: 'Order',
  colorless: 'Colourless',
};

/** Build a /cards URL carrying the current filters, with one of them changed. */
function filterUrl(env, current, change) {
  const next = { ...current, ...change };
  const qs = new URLSearchParams();
  for (const key of ['type', 'color', 'set']) if (next[key]) qs.set(key, next[key]);
  // The default sort is never written into the URL, so the canonical /cards
  // stays clean and one view has exactly one address.
  if (next.sort && next.sort !== 'price') qs.set('sort', next.sort);
  if (next.page && next.page > 1) qs.set('page', String(next.page));
  const query = qs.toString();
  return url(env, `/cards${query ? `?${query}` : ''}`);
}

function filterButton(env, current, change, label, count, isActive) {
  return `<a class="chip${isActive ? ' is-on' : ''}" href="${esc(
    filterUrl(env, current, { ...change, page: 1 }),
  )}"${isActive ? ' aria-current="true"' : ''}>${esc(label)}${
    count === undefined ? '' : `<span class="chip-count">${esc(count)}</span>`
  }</a>`;
}

function cardTile(env, c) {
  const thumb = cardImageSrc(env, c, 'small');
  const large = cardImageSrc(env, c, 'large');
  const code = c.public_code || `${c.set_id}-${c.collector_number}`;

  // Same hover enlargement as everywhere else on the site: a background on an
  // element that is display:none until hover, so none of these ~100 KB images
  // load until one is actually asked for.
  const zoom = large
    ? `<span class="card-zoom" aria-hidden="true" style="--art:url('${esc(large)}')"></span>`
    : '';

  const art = thumb
    ? `<img src="${esc(thumb)}" width="300" height="418" loading="lazy" decoding="async"
           alt="${esc(c.name)}"/>`
    : '<span class="tile-art--empty" aria-hidden="true"></span>';

  return `<li class="card-tile"${large ? ' tabindex="0"' : ''}>
      <span class="tile-art">${art}</span>
      <span class="tile-name">${esc(c.name)}</span>
      <span class="tile-meta">${esc(code)}</span>
      <span class="tile-set">${esc(c.set_name || c.set_id)}</span>
      <span class="tile-price${c.market_price === null ? ' is-unpriced' : ''}">${
        c.market_price === null ? 'No price' : money(c.market_price)
      }</span>
      ${zoom}
    </li>`;
}

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const SORTS = ['price', 'set', 'name'];
  const requestedSort = params.get('sort') || 'price';
  const current = {
    type: params.get('type') || '',
    color: params.get('color') || '',
    set: params.get('set') || '',
    sort: SORTS.includes(requestedSort) ? requestedSort : 'price',
    page: Math.max(1, Number(params.get('page')) || 1),
  };

  const [facets, total, priceDate] = await Promise.all([
    cardFacets(env.DB),
    countCards(env.DB, current),
    latestPriceDate(env.DB),
  ]);

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(current.page, pages);
  const cards = await listCards(env.DB, {
    ...current,
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
  });

  const typeChips = [
    filterButton(env, current, { type: '' }, 'All', undefined, !current.type),
    ...facets.types.map((t) =>
      filterButton(env, current, { type: t.v }, t.v, t.n, current.type === t.v),
    ),
  ].join('');

  const colorChips = [
    filterButton(env, current, { color: '' }, 'All', undefined, !current.color),
    ...facets.colors.map((c) =>
      filterButton(
        env,
        current,
        { color: c.v },
        COLOR_LABELS[c.v] ?? c.v,
        c.n,
        current.color === c.v,
      ),
    ),
  ].join('');

  const setChips = [
    filterButton(env, current, { set: '' }, 'All', undefined, !current.set),
    ...facets.sets.map((s) =>
      filterButton(env, current, { set: s.v }, s.label, s.n, current.set === s.v),
    ),
  ].join('');

  // Sort keeps the current filters and resets to page 1, since page 3 of a
  // price-sorted list is meaningless once the order changes.
  const sortChips = [
    ['price', 'Price'],
    ['set', 'Set order'],
    ['name', 'Name'],
  ]
    .map(([v, label]) =>
      filterButton(env, current, { sort: v }, label, undefined, current.sort === v),
    )
    .join('');

  const setLabel = facets.sets.find((s) => s.v === current.set)?.label;
  const active = [
    current.type ? current.type : null,
    current.color ? (COLOR_LABELS[current.color] ?? current.color) : null,
    current.set ? (setLabel ?? current.set) : null,
  ].filter(Boolean);

  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="Pagination">
          ${
            page > 1
              ? `<a class="btn" href="${esc(filterUrl(env, current, { page: page - 1 }))}">← Previous</a>`
              : '<span class="btn is-disabled" aria-disabled="true">← Previous</span>'
          }
          <span class="pager-at">Page ${esc(page)} of ${esc(pages)}</span>
          ${
            page < pages
              ? `<a class="btn" href="${esc(filterUrl(env, current, { page: page + 1 }))}">Next →</a>`
              : '<span class="btn is-disabled" aria-disabled="true">Next →</span>'
          }
        </nav>`
      : '';

  const body = `
<div class="page-head">
  <h1>Cards</h1>
  <p class="lede">
    Every card in the catalogue, priced daily against TCGplayer.
    ${active.length ? `Showing <b>${esc(active.join(' · '))}</b>.` : ''}
  </p>
</div>

<div class="filters">
  <div class="filter-row">
    <span class="filter-label">Type</span>
    <div class="chips">${typeChips}</div>
  </div>
  <div class="filter-row">
    <span class="filter-label">Colour</span>
    <div class="chips">${colorChips}</div>
  </div>
  <div class="filter-row">
    <span class="filter-label">Set</span>
    <div class="chips">${setChips}</div>
  </div>
  <div class="filter-row filter-row--sort">
    <span class="filter-label">Sort</span>
    <div class="chips">${sortChips}</div>
  </div>
  ${
    current.type || current.color || current.set
      ? `<div class="filter-row">
          <span class="filter-label"></span>
          <a class="chip chip-clear" href="${esc(url(env, '/cards'))}">Clear filters</a>
        </div>`
      : ''
  }
</div>

<div class="section-head">
  <h2>${esc(total.toLocaleString('en-US'))} card${total === 1 ? '' : 's'}</h2>
  ${priceDate ? `<span class="as-of">Prices ${esc(priceDate)}</span>` : ''}
</div>

${adSlot('leaderboard')}

${
  cards.length
    ? `<ul class="card-grid">${cards.map((c) => cardTile(env, c)).join('')}</ul>`
    : `<section class="panel empty">
         <h3>Nothing matches that combination</h3>
         <p>Try a different type or colour.</p>
         <p><a class="btn" href="${esc(url(env, '/cards'))}">Clear filters</a></p>
       </section>`
}

${pager}`;

  return htmlResponse(
    layout(env, {
      title: `${active.length ? `${active.join(' ')} cards` : 'Cards'} — Scoutpost`,
      description: `Browse every Riftbound card with daily market prices${
        active.length ? `, filtered to ${active.join(' and ')}` : ''
      }.`,
      path: '/cards',
      crumbs: [
        { name: 'Scoutpost', path: '/' },
        { name: 'Cards', path: '/cards' },
      ],
      // A filtered or paged view is a slice of the same catalogue, so only the
      // unfiltered first page is worth indexing.
      robots:
        current.type || current.color || current.set || current.sort !== 'price' || page > 1
          ? 'noindex, follow'
          : '',
      body,
    }),
  );
}
