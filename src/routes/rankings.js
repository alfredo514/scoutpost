/**
 * /rankings — the market boards.
 *
 * This page exists to answer what /cards cannot. /cards is a browser: it finds
 * a card. This is a leaderboard: it says where the money in the format is and
 * what moved. Two things here are impossible on a browse page —
 *
 *   1. aggregates (catalogue value, median card, how much of it sits in each
 *      set), which are properties of the whole slice rather than of any row;
 *   2. movement, which needs two dates and so needs the price history.
 *
 * Everything else deliberately delegates. Each board links back into /cards
 * with the equivalent filter rather than growing pagination and sorting of its
 * own, because /cards already does that well and two half-browsers would be
 * worse than one whole one.
 *
 * Filters are links. No JavaScript, like every other page.
 */

import {
  adSlot,
  esc,
  formatDate,
  htmlResponse,
  layout,
  money,
  url,
} from '../lib/render.js';
import {
  cardFacets,
  marketStats,
  moverWindow,
  printingFacets,
  setValueTable,
  topCards,
  topMovers,
} from '../lib/queries.js';
import { cardMark } from '../lib/images.js';

/** How many rows each board shows before deferring to /cards. */
const BOARD_ROWS = 25;
const MOVER_ROWS = 8;

/** Printing groups, named the way players talk about them — as on /cards. */
const PRINTING_LABELS = {
  standard: 'Standard',
  showcase: 'Showcase',
  signature: 'Signature',
  promo: 'Promo',
};

/** The printing a card belongs to, from the variant the catalogue records. */
function printingOf(card) {
  if (card.variant === '') return 'standard';
  if (card.variant === 'a') return 'showcase';
  if (card.variant === 'star') return 'signature';
  return 'promo';
}

/** Build a /rankings URL with one filter changed. */
function filterUrl(env, current, change) {
  const next = { ...current, ...change };
  const qs = new URLSearchParams();
  for (const key of ['set', 'printing']) if (next[key]) qs.set(key, next[key]);
  const query = qs.toString();
  return url(env, `/rankings${query ? `?${query}` : ''}`);
}

function chip(env, current, change, label, count, isActive) {
  return `<a class="chip${isActive ? ' is-on' : ''}" href="${esc(
    filterUrl(env, current, change),
  )}"${isActive ? ' aria-current="true"' : ''}>${esc(label)}${
    count === undefined ? '' : `<span class="chip-count">${esc(count)}</span>`
  }</a>`;
}

/** The matching /cards view, so a board is always one click from the full list. */
function cardsUrl(env, extra = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) qs.set(k, v);
  const query = qs.toString();
  return url(env, `/cards${query ? `?${query}` : ''}`);
}

/**
 * A signed percentage, coloured by direction.
 *
 * Lime for a rise and pink for a fall, matching the palette's existing meaning
 * — but the sign is written out too, because colour alone is not a readable
 * distinction for everyone.
 */
function pctCell(pct) {
  const value = Number(pct) * 100;
  const sign = value > 0 ? '+' : '';
  return `<span class="move ${value > 0 ? 'move-up' : 'move-down'}">${esc(
    `${sign}${value.toFixed(1)}%`,
  )}</span>`;
}

function moverBoard(env, { rows, title, note, emptyText }) {
  const body = rows.length
    ? rows
        .map(
          (c) => `<tr>
            <td data-label="Card">${cardMark(env, c, { href: url(env, `/cards/${c.id}`) })}</td>
            <td data-label="Was" class="num">${money(c.old_price)}</td>
            <td data-label="Now" class="num"><span class="cost">${money(c.new_price)}</span></td>
            <td data-label="Change" class="num">${pctCell(c.pct)}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="empty-cell">${esc(emptyText)}</td></tr>`;

  return `<div class="board">
  <div class="section-head">
    <h3>${esc(title)}</h3>
    <span class="as-of">${esc(note)}</span>
  </div>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th scope="col">Card</th>
          <th scope="col" class="num">Was</th>
          <th scope="col" class="num">Now</th>
          <th scope="col" class="num">Change</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>
</div>`;
}

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const requestedPrinting = params.get('printing') || '';

  const [facets, printings] = await Promise.all([cardFacets(env.DB), printingFacets(env.DB)]);

  const requestedSet = params.get('set') || '';
  const current = {
    set: facets.sets.some((s) => s.v === requestedSet) ? requestedSet : '',
    printing: PRINTING_LABELS[requestedPrinting] ? requestedPrinting : '',
  };

  const moveWindow = await moverWindow(env.DB);

  const [stats, top, sets, risers, fallers] = await Promise.all([
    marketStats(env.DB, current),
    topCards(env.DB, { ...current, limit: BOARD_ROWS }),
    setValueTable(env.DB),
    moveWindow
      ? topMovers(env.DB, { ...moveWindow, ...current, direction: 'up', limit: MOVER_ROWS })
      : [],
    moveWindow
      ? topMovers(env.DB, { ...moveWindow, ...current, direction: 'down', limit: MOVER_ROWS })
      : [],
  ]);

  const setLabel = facets.sets.find((s) => s.v === current.set)?.label;
  const active = [
    current.set ? (setLabel ?? current.set) : null,
    current.printing ? PRINTING_LABELS[current.printing] : null,
  ].filter(Boolean);

  const setChips = [
    chip(env, current, { set: '' }, 'All sets', undefined, !current.set),
    ...facets.sets.map((s) => chip(env, current, { set: s.v }, s.label, s.n, current.set === s.v)),
  ].join('');

  const printingChips = [
    chip(env, current, { printing: '' }, 'All', undefined, !current.printing),
    ...printings.map((p) =>
      chip(
        env,
        current,
        { printing: p.v },
        PRINTING_LABELS[p.v] ?? p.v,
        p.n,
        current.printing === p.v,
      ),
    ),
  ].join('');

  const unpriced = stats.cards - stats.priced;

  const topRows = top.length
    ? top
        .map(
          (c, i) => `<tr>
            <td data-label="Rank" class="num"><span class="rank">${esc(i + 1)}</span></td>
            <td data-label="Card">${cardMark(env, c, { href: url(env, `/cards/${c.id}`) })}</td>
            <td data-label="Set">${esc(c.set_name || c.set_id)}</td>
            <td data-label="Printing">
              <span class="tag">${esc(PRINTING_LABELS[printingOf(c)])}</span>
            </td>
            <td data-label="Price" class="num"><span class="cost">${money(c.market_price)}</span></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="5" class="empty-cell">No priced cards match that filter.</td></tr>`;

  const setRows = sets
    .map(
      (s) => `<tr>
        <td data-label="Set">
          <a class="strong-link" href="${esc(cardsUrl(env, { set: s.id }))}">${esc(
            s.name || s.id,
          )}</a>
          ${s.release_date ? `<span class="legend">${esc(formatDate(s.release_date))}</span>` : ''}
        </td>
        <td data-label="Cards" class="num">${esc(Number(s.cards).toLocaleString('en-US'))}</td>
        <td data-label="Priced" class="num">${esc(Number(s.priced).toLocaleString('en-US'))}</td>
        <td data-label="Set value" class="num"><span class="cost">${money(s.total)}</span></td>
        <td data-label="Priciest card">
          ${
            s.top_id
              ? `<a href="${esc(url(env, `/cards/${s.top_id}`))}">${esc(s.top_name)}</a>
                 <span class="legend">${money(s.top_price)}</span>`
              : '—'
          }
        </td>
      </tr>`,
    )
    .join('');

  // The movers moveWindow is whatever history exists, not a fixed week — the page
  // prints the real dates so nobody reads a three-day swing as a weekly trend.
  const windowNote = moveWindow
    ? `${formatDate(moveWindow.from)} → ${formatDate(moveWindow.to)}`
    : 'Not enough history yet';

  const body = `
<div class="page-head">
  <h1>Rankings</h1>
  <p class="lede">
    Where the money in Riftbound sits today, and what moved.
    ${active.length ? `Showing <b>${esc(active.join(' · '))}</b>.` : ''}
    ${stats.priced ? `Prices as of ${esc(formatDate(moveWindow ? moveWindow.to : ''))}.` : ''}
  </p>
</div>

<div class="filters">
  <div class="filter-row">
    <span class="filter-label">Set</span>
    <div class="chips">${setChips}</div>
  </div>
  <div class="filter-row">
    <span class="filter-label">Printing</span>
    <div class="chips">${printingChips}</div>
  </div>
  ${
    active.length
      ? `<div class="filter-row">
          <span class="filter-label"></span>
          <a class="chip chip-clear" href="${esc(url(env, '/rankings'))}">Reset</a>
        </div>`
      : ''
  }
</div>

${/* Aggregates first: they frame every board below, and they are the numbers
     that cannot be got from /cards at all. */ ''}
<dl class="stat-row">
  <div><dt>Cards priced</dt><dd>${esc(Number(stats.priced).toLocaleString('en-US'))}</dd></div>
  <div><dt>Combined value</dt><dd>${money(stats.total)}</dd></div>
  <div><dt>Median card</dt><dd>${money(stats.median)}</dd></div>
  <div><dt>Over $50</dt><dd>${esc(Number(stats.over50).toLocaleString('en-US'))}</dd></div>
</dl>

${
  unpriced > 0
    ? `<p class="source-note">
        Combined value covers the ${esc(Number(stats.priced).toLocaleString('en-US'))} priced
        card${stats.priced === 1 ? '' : 's'} in this slice.
        ${esc(Number(unpriced).toLocaleString('en-US'))} more
        ${unpriced === 1 ? 'has' : 'have'} no TCGplayer counterpart and count for nothing here.
        <a href="${esc(cardsUrl(env, { ...current, priced: 'no' }))}">See which</a>.
      </p>`
    : ''
}

${adSlot('leaderboard')}

<section>
  <div class="section-head">
    <h2>Most valuable</h2>
    <a class="more" href="${esc(cardsUrl(env, current))}">All cards by price →</a>
  </div>
  <div class="table-wrap">
    <table class="data-table" id="top-cards">
      <thead>
        <tr>
          <th scope="col" class="num">#</th>
          <th scope="col">Card</th>
          <th scope="col">Set</th>
          <th scope="col">Printing</th>
          <th scope="col" class="num">Market price</th>
        </tr>
      </thead>
      <tbody>${topRows}</tbody>
    </table>
  </div>
  ${
    !current.printing && top.some((c) => printingOf(c) === 'signature')
      ? `<p class="source-note">
          Signature printings dominate this board — they are the game's chase
          cards and a handful sell for four figures.
          <a href="${esc(filterUrl(env, current, { printing: 'standard' }))}">Standard printings only</a>,
          or <a href="${esc(filterUrl(env, current, { printing: 'signature' }))}">signatures alone</a>.
        </p>`
      : ''
  }
</section>

<section>
  <div class="section-head">
    <h2>Biggest movers</h2>
    <span class="as-of">${esc(windowNote)}</span>
  </div>
  <div class="boards">
    ${moverBoard(env, {
      rows: risers,
      title: 'Risers',
      note: 'Market price up',
      emptyText: 'Nothing rose in this slice over the moveWindow.',
    })}
    ${moverBoard(env, {
      rows: fallers,
      title: 'Fallers',
      note: 'Market price down',
      emptyText: 'Nothing fell in this slice over the moveWindow.',
    })}
  </div>
  <p class="source-note">
    ${
      moveWindow
        ? `Measured between the snapshots of ${esc(formatDate(moveWindow.from))} and
           ${esc(formatDate(moveWindow.to))}, and only for cards priced on both days — a
           card we started pricing partway through has not moved, we simply could
           not see it before. Cards under ${money(moveWindow.floor)} are left out:
           TCGplayer quotes bulk in whole cents, so a penny of rounding on a
           ten-cent common reads as a double-digit swing.`
        : `Price history goes back one day so far, which is not enough to measure a
           movement. This board fills in as the daily snapshots accumulate.`
    }
  </p>
</section>

<section>
  <div class="section-head">
    <h2>Value by set</h2>
    <span class="as-of">Whole catalogue, filters aside</span>
  </div>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th scope="col">Set</th>
          <th scope="col" class="num">Cards</th>
          <th scope="col" class="num">Priced</th>
          <th scope="col" class="num">Combined value</th>
          <th scope="col">Priciest card</th>
        </tr>
      </thead>
      <tbody>${setRows}</tbody>
    </table>
  </div>
  <p class="source-note">
    This board always covers every set and every printing — it is a comparison
    between sets, so filtering it to one would leave nothing to compare. Combined
    value is the sum of one copy of every priced card in the set at today's market
    price: a measure of where the money is, not what a set costs to complete.
  </p>
</section>`;

  return htmlResponse(
    layout(env, {
      title: `${
        active.length ? `${active.join(' ')} rankings` : 'Riftbound card rankings by price'
      } | Scoutpost`,
      description:
        'The most valuable Riftbound cards, the biggest price movers, and where the value sits by set — from daily TCGplayer market prices.',
      path: '/rankings',
      crumbs: [
        { name: 'Scoutpost', path: '/' },
        { name: 'Rankings', path: '/rankings' },
      ],
      // A filtered board is a slice of the same data, so only the unfiltered
      // page is worth indexing — same rule as /cards.
      robots: active.length ? 'noindex, follow' : '',
      body,
    }),
  );
}
