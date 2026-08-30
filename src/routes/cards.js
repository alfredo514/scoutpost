/**
 * /cards — the card browser.
 *
 * Filters are **links, not scripts**. Every filtered view is a real URL that can
 * be shared, bookmarked, opened in a new tab and crawled, and the page works
 * with JavaScript disabled, which is the site's rule (nothing may REQUIRE
 * script — see public/app.js) and is also simply the better behaviour for a
 * browse page.
 *
 * Search is a plain GET form. Hidden inputs carry the active filters through a
 * submit, so searching narrows what you are looking at rather than throwing it
 * away. Unpriced cards sort last in BOTH price directions — ascending, a card
 * with no price is unknown, not free.
 *
 * The two collapsibles here — advanced filters, and the sort menu — are
 * `<details>` elements. That is native HTML with no script behind it, which is
 * the only way to have a disclosure on this site. Their open state is decided
 * on the server (see `advancedActive`), because a `<details>` cannot remember
 * anything across a navigation and every filter click is a navigation.
 */

import { adSlot, chipLink, esc, htmlResponse, layout, money, url } from '../lib/render.js';
import {
  cardFacets,
  countCards,
  latestPriceDate,
  listCards,
  printingFacets,
} from '../lib/queries.js';
import { cardImageSrc } from '../lib/images.js';
import { COLOR_LABELS, PRINTING_LABELS, domainIconSrc } from '../lib/vocab.js';

const PER_PAGE = 50;

/**
 * Sort orders, in the menu's own order. `price` is the default and is never
 * written into the URL, so the canonical /cards has exactly one address.
 */
const SORTS = [
  ['price', 'Price high'],
  ['price-asc', 'Price low'],
  ['name', 'A–Z'],
  ['name-desc', 'Z–A'],
  ['set', 'Newest set'],
  ['set-asc', 'Oldest set'],
  ['rarity', 'Rarest'],
  ['rarity-asc', 'Commonest'],
];
const SORT_KEYS = SORTS.map(([v]) => v);
const SORT_LABELS = Object.fromEntries(SORTS);

/**
 * Which filters sit behind the disclosure.
 *
 * Type, colour and set are how people actually browse a card pool, and they
 * stay in the open. Rarity, printing and price are refinements — worth having,
 * not worth three permanent rows of chrome above the grid.
 */
const ADVANCED_KEYS = ['rarity', 'printing', 'priced'];

/** Build a /cards URL carrying the current filters, with one of them changed. */
function filterUrl(env, current, change) {
  const next = { ...current, ...change };
  const qs = new URLSearchParams();
  for (const key of ['q', 'type', 'color', 'set', 'rarity', 'printing', 'priced'])
    if (next[key]) qs.set(key, next[key]);
  // The default sort is never written into the URL, so the canonical /cards
  // stays clean and one view has exactly one address.
  if (next.sort && next.sort !== 'price') qs.set('sort', next.sort);
  if (next.page && next.page > 1) qs.set('page', String(next.page));
  const query = qs.toString();
  return url(env, `/cards${query ? `?${query}` : ''}`);
}

/** A filter chip for this page: markup from chipLink, URL policy from here. */
function filterButton(env, current, change, label, count, isActive, icon) {
  return chipLink({
    href: filterUrl(env, current, { ...change, page: 1 }),
    label,
    count,
    isActive,
    // An "All" chip is the one whose change clears its key. Detected rather
    // than declared, so no call site can forget it.
    isDefault: Object.values(change).every((v) => v === ''),
    icon,
  });
}

function cardTile(env, c) {
  const thumb = cardImageSrc(env, c, 'small');
  const code = c.public_code || `${c.set_id}-${c.collector_number}`;

  const art = thumb
    ? `<img src="${esc(thumb)}" width="300" height="418" loading="lazy" decoding="async"
           alt="${esc(c.name)}"/>`
    : '<span class="tile-art--empty" aria-hidden="true"></span>';

  // Clicking a tile goes to the card's own page, which carries the large art
  // plus its transcribed text — strictly more than the old in-page overlay.
  const open = url(env, `/cards/${esc(c.id)}`);

  return `<li class="card-tile">
      <a class="tile-open" href="${esc(open)}" aria-label="${esc(c.name)}">
      <span class="tile-art">${art}</span>
      <span class="tile-body">
        <span class="tile-name">${esc(c.name)}</span>
        <span class="tile-meta">${esc(code)}</span>
        <span class="tile-set">${
          domainIconSrc(env, c.faction)
            ? `<img class="tile-domain" src="${esc(domainIconSrc(env, c.faction))}" width="14" height="14"
                   alt="${esc(c.faction)}" loading="lazy"/>`
            : ''
        }${esc(c.set_name || c.set_id)}</span>
        <span class="tile-price${c.market_price === null ? ' is-unpriced' : ''}">${
          c.market_price === null ? 'No price' : money(c.market_price)
        }</span>
      </span>
      </a>
    </li>`;
}

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const requestedSort = params.get('sort') || 'price';
  const current = {
    q: (params.get('q') || '').trim().slice(0, 80),
    type: params.get('type') || '',
    color: params.get('color') || '',
    set: params.get('set') || '',
    rarity: params.get('rarity') || '',
    printing: params.get('printing') || '',
    priced: params.get('priced') || '',
    sort: SORT_KEYS.includes(requestedSort) ? requestedSort : 'price',
    page: Math.max(1, Number(params.get('page')) || 1),
  };

  const [facets, printings, total, priceDate] = await Promise.all([
    cardFacets(env.DB),
    printingFacets(env.DB),
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
        domainIconSrc(env, c.v),
      ),
    ),
  ].join('');

  const setChips = [
    filterButton(env, current, { set: '' }, 'All', undefined, !current.set),
    ...facets.sets.map((s) =>
      filterButton(env, current, { set: s.v }, s.label, s.n, current.set === s.v),
    ),
  ].join('');

  const rarityChips = [
    filterButton(env, current, { rarity: '' }, 'All', undefined, !current.rarity),
    ...facets.rarities.map((r) =>
      filterButton(env, current, { rarity: r.v }, r.v, r.n, current.rarity === r.v),
    ),
  ].join('');

  const printingChips = [
    filterButton(env, current, { printing: '' }, 'All', undefined, !current.printing),
    ...printings.map((pr) =>
      filterButton(
        env, current, { printing: pr.v },
        PRINTING_LABELS[pr.v] ?? pr.v, pr.n, current.printing === pr.v,
      ),
    ),
  ].join('');

  const pricedChips = [
    filterButton(env, current, { priced: '' }, 'All', undefined, !current.priced),
    filterButton(env, current, { priced: 'yes' }, 'Priced', undefined, current.priced === 'yes'),
    filterButton(env, current, { priced: 'no' }, 'Unpriced', undefined, current.priced === 'no'),
  ].join('');

  const setLabel = facets.sets.find((s) => s.v === current.set)?.label;
  const active = [
    current.q ? '“' + current.q + '”' : null,
    current.type || null,
    current.color ? (COLOR_LABELS[current.color] ?? current.color) : null,
    current.set ? (setLabel ?? current.set) : null,
    current.rarity || null,
    current.printing ? (PRINTING_LABELS[current.printing] ?? current.printing) : null,
    current.priced === 'no' ? 'unpriced' : current.priced === 'yes' ? 'priced' : null,
  ].filter(Boolean);

  // The disclosure opens itself whenever something inside it is doing work.
  // Without this, narrowing by rarity would collapse the panel on the very
  // navigation that applied it, hiding the control the reader just used.
  const advancedActive = ADVANCED_KEYS.filter((k) => current[k]).length;

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

  // Sort belongs with the results, not with the filters: it reorders what you
  // have rather than changing what you have. Sitting opposite the count, it is
  // also one control instead of a row of eight.
  const sortMenu = `<details class="sortmenu">
      ${/* The summary itself stays a plain block and all the layout lives on an
           inner span. Setting `display: flex` directly on a <summary> has broken
           the toggle in shipped browsers, and a disclosure that will not open is
           not a thing to be clever about. */ ''}
      <summary><span class="sortmenu-trigger">Sort<span class="sortmenu-current">${esc(
        SORT_LABELS[current.sort],
      )}</span></span></summary>
      <div class="sortmenu-panel">
        ${SORTS.map(
          ([v, label]) =>
            `<a class="sortmenu-item${v === current.sort ? ' is-on' : ''}" href="${esc(
              filterUrl(env, current, { sort: v, page: 1 }),
            )}"${v === current.sort ? ' aria-current="true"' : ''}>${esc(label)}</a>`,
        ).join('')}
      </div>
    </details>`;

  const body = `
<div class="page-head">
  <h1>Cards</h1>
  <p class="lede">
    Every card in the catalogue, priced daily against TCGplayer.
    ${active.length ? `Showing <b>${esc(active.join(' · '))}</b>.` : ''}
  </p>
</div>

${/* A GET form, so searching produces a real URL and needs no JavaScript. The
     hidden inputs carry the current filters through, otherwise submitting a
     search would silently throw them away. */ ''}
<form class="search" method="get" action="${esc(url(env, '/cards'))}" role="search">
  <label class="sr-only" for="card-search">Search cards</label>
  <input id="card-search" class="search-input" type="search" name="q"
         value="${esc(current.q)}" placeholder="Search by name or code — Baron Nashor, UNL-147"
         autocomplete="off" spellcheck="false"/>
  ${['type', 'color', 'set', 'rarity', 'printing', 'priced', 'sort']
    .filter((k) => current[k] && !(k === 'sort' && current[k] === 'price'))
    .map((k) => `<input type="hidden" name="${k}" value="${esc(current[k])}"/>`)
    .join('')}
  <button class="btn btn-primary" type="submit">Search</button>
  ${
    current.q
      ? `<a class="chip chip-clear" href="${esc(filterUrl(env, current, { q: '', page: 1 }))}">Clear search</a>`
      : ''
  }
</form>

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

  ${
    active.length
      ? `<div class="filter-row">
          <span class="filter-label"></span>
          <a class="chip chip-clear" href="${esc(url(env, '/cards'))}">Reset everything</a>
        </div>`
      : ''
  }

  ${/* Native <details>, and the LAST child of .filters on purpose: the toggle
       is styled as a full-width bar across the foot of the panel, which only
       works if nothing follows it. Reset moved above it for that reason — and
       it reads better there anyway, next to the filters it clears. */ ''}
  <details class="filters-more"${advancedActive ? ' open' : ''}>
    <summary>
      <span class="filters-more-trigger">
        <span class="filters-more-label">Advanced filters</span>
        ${
          advancedActive
            ? `<span class="chip-count">${esc(advancedActive)} on</span>`
            : '<span class="filters-more-hint">rarity, printing, price</span>'
        }
      </span>
    </summary>
    <div class="filters-more-body">
      <div class="filter-row">
        <span class="filter-label">Rarity</span>
        <div class="chips">${rarityChips}</div>
      </div>
      <div class="filter-row">
        <span class="filter-label">Printing</span>
        <div class="chips">${printingChips}</div>
      </div>
      <div class="filter-row">
        <span class="filter-label">Price</span>
        <div class="chips">${pricedChips}</div>
      </div>
    </div>
  </details>
</div>

<div class="section-head section-head--results">
  <h2>${esc(total.toLocaleString('en-US'))} card${total === 1 ? '' : 's'}</h2>
  <div class="results-tools">
    ${priceDate ? `<span class="as-of">Prices ${esc(priceDate)}</span>` : ''}
    ${sortMenu}
  </div>
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
        active.length || current.sort !== 'price' || page > 1 ? 'noindex, follow' : '',
      body,
    }),
  );
}
