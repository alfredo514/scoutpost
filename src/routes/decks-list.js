/**
 * /decks — every imported decklist, ranked by build cost.
 *
 * One table serves two layouts. On a desktop it is a table, because six
 * comparable columns across sixty rows is exactly what a table is for. Below
 * 720px it becomes a stack of cards — CSS only, from the same markup, so there
 * is no second template to keep in sync and no JavaScript.
 *
 * The generic stacked-table fallback the rest of the site uses (a "LABEL …
 * value" row per cell) is wrong for this table specifically: six labelled rows
 * per deck means about four decks per phone screen, and five of the six labels
 * are noise once you know the shape. `.data-table--decks` opts this table out
 * of that fallback and into a grid instead — see the card layout in styles.css.
 *
 * The cells carry `cell-*` classes for that grid, and the units ("Place",
 * "Cards") are marked up as `.unit` spans that only the card layout reveals,
 * so a column headed "Place" still reads "1" on a desktop and "1st Place" on a
 * phone from one string in one place.
 */

import {
  adSlot,
  eraFilterBar,
  esc,
  formatDate,
  hiddenByFilterNote,
  htmlResponse,
  layout,
  money,
  ordinalSuffix,
  url,
} from '../lib/render.js';
import {
  deckEraCounts,
  latestPriceDate,
  legendFacets,
  listDecks,
  setEras,
} from '../lib/queries.js';
import { imageKeyFromUrl, legendMark } from '../lib/images.js';
import { championOf } from '../lib/vocab.js';

/**
 * Default view: the current set only, matching /events.
 *
 * A decklist is only meaningful against the format it was played in. The cost
 * is that everything older is hidden until asked for — see the note under the
 * table, which says how many and links to the full list.
 */
const DEFAULT_ERA = 'newest';

/** Build a /decks URL carrying the current filters, with one of them changed. */
function decksUrl(env, current, change) {
  const next = { ...current, ...change };
  const qs = new URLSearchParams();
  // 'all' is an explicit choice and has to survive, so set is handled by value
  // rather than by truthiness.
  if (next.set) qs.set('set', next.set);
  if (next.legend) qs.set('legend', next.legend);
  if (next.q) qs.set('q', next.q);
  const query = qs.toString();
  return url(env, `/decks${query ? `?${query}` : ''}`);
}

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const eras = await setEras(env.DB);
  const newest = eras[0]?.id ?? '';

  const searchQ = (params.get('q') || '').trim().slice(0, 80);
  const activeLegend = (params.get('legend') || '').trim().slice(0, 120);

  const requested = params.get('set');
  // No parameter means the default; 'all' is an explicit choice, not the
  // absence of one.
  const selected =
    requested === 'all'
      ? ''
      : requested && eras.some((e) => e.id === requested)
        ? requested
        : DEFAULT_ERA === 'newest'
          ? newest
          : '';

  // The era the URL asked for, kept verbatim so links round-trip '?set=all'.
  const current = { set: requested === 'all' ? 'all' : selected, legend: activeLegend, q: searchQ };

  const [decks, counts, priceDate, legends] = await Promise.all([
    listDecks(env.DB, { limit: 300, era: selected, legend: activeLegend, q: searchQ }),
    deckEraCounts(env.DB),
    latestPriceDate(env.DB),
    legendFacets(env.DB, { era: selected }),
  ]);

  const totalDecks = Object.values(counts).reduce((a, n) => a + n, 0);
  const activeEra = eras.find((e) => e.id === selected);

  const rows = decks.length
    ? decks
        .map(
          (d) => `<tr>
            <td data-label="Deck" class="cell-deck">
              ${legendMark(
                env,
                d,
                `<a class="strong-link" href="${esc(url(env, `/decks/${d.id}`))}">${esc(
                  d.legend || d.player_name || 'Decklist',
                )}</a>${
                  d.legend
                    ? `<a class="legend-tag" href="${esc(
                        decksUrl(env, current, { legend: d.legend }),
                      )}">Legend: ${esc(championOf(d.legend))}</a>`
                    : ''
                }${
                  d.player_name && d.legend
                    ? `<span class="legend">${esc(d.player_name)}</span>`
                    : ''
                }`,
              )}
            </td>
            <td data-label="Event" class="cell-event">
              <a href="${esc(url(env, `/events/${d.event_slug}`))}">${esc(d.event_name)}</a>
            </td>
            <td data-label="Date" class="cell-date">${esc(formatDate(d.event_date))}</td>
            <td data-label="Place" class="num cell-place">${esc(d.placement)}${
              `<span class="unit">${esc(ordinalSuffix(d.placement))} Place</span>`
            }</td>
            <td data-label="Cards" class="num cell-cards">${esc(
              d.card_count ?? 0,
            )}<span class="unit"> Cards</span></td>
            <td data-label="Build cost" class="num cell-cost"><span class="cost">${money(
              d.total_cost,
            )}</span></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" class="empty-cell">
         ${
           activeLegend || searchQ
             ? `Nothing matches ${
                 activeLegend ? `<b>${esc(championOf(activeLegend))}</b>` : ''
               }${activeLegend && searchQ ? ' and ' : ''}${
                 searchQ ? `“${esc(searchQ)}”` : ''
               }${activeEra ? ` in <b>${esc(activeEra.name)}</b>` : ' in any set'}.
               <a href="${esc(decksUrl(env, current, { legend: '', q: '' }))}">Clear filters</a>.`
             : `No decks played under ${esc(activeEra?.name ?? 'this set')} yet.`
         }
       </td></tr>`;

  /* A plain GET form, like /cards. It produces a real URL, so a search is
     shareable, bookmarkable and works with scripting off. Not a typeahead: see
     §21 and §23 — this one is deliberately not a job for script.
     The hidden inputs carry the other filters through a submit. */
  const searchForm = `
<form class="search deck-search" method="get" action="${esc(url(env, '/decks'))}" role="search">
  <label class="sr-only" for="deck-search">Search by Legend or player</label>
  <input id="deck-search" class="search-input" type="search" name="q"
         value="${esc(searchQ)}" placeholder="Search by Legend or Player…"
         autocomplete="off" spellcheck="false"/>
  ${['set', 'legend']
    .filter((k) => current[k])
    .map((k) => `<input type="hidden" name="${k}" value="${esc(current[k])}"/>`)
    .join('')}
  <button class="btn btn-primary" type="submit">Search</button>
  ${
    searchQ
      ? `<a class="chip chip-clear" href="${esc(decksUrl(env, current, { q: '' }))}">Clear</a>`
      : ''
  }
</form>`;

  /* Avatars are links, not buttons. Each is a real filtered URL for exactly the
     same reason the chips above are. Art is cropped to a circle and biased
     upward, because a Riftbound card puts the character's face in the top
     third and a centred crop lands on their chest. */
  const legendRow = legends.length
    ? `<nav class="legend-picker" aria-label="Filter by Legend">
    <span class="filter-label">Legend</span>
    <div class="legend-strip">
      ${[
        `<a class="legend-av${activeLegend ? '' : ' is-on'}" href="${esc(
          decksUrl(env, current, { legend: '' }),
        )}"${activeLegend ? '' : ' aria-current="true"'}>
           <span class="legend-av-art legend-av-all" aria-hidden="true">All</span>
           <span class="legend-av-name">All</span>
         </a>`,
        ...legends.map((l) => {
          const key = imageKeyFromUrl('small', l.thumb);
          const on = activeLegend === l.legend;
          const art = key
            ? `<img class="legend-av-art" src="${esc(url(env, `/card-image/${key}`))}"
                    width="56" height="56" loading="lazy" decoding="async" alt=""/>`
            : '<span class="legend-av-art legend-av-all" aria-hidden="true"></span>';
          return `<a class="legend-av${on ? ' is-on' : ''}" href="${esc(
            decksUrl(env, current, { legend: on ? '' : l.legend }),
          )}" title="${esc(l.legend)} — ${esc(l.n)} deck${l.n === 1 ? '' : 's'}"${
            on ? ' aria-current="true"' : ''
          }>
             ${art}
             <span class="legend-av-name">${esc(championOf(l.legend))}</span>
             <span class="legend-av-n">${esc(l.n)}</span>
           </a>`;
        }),
      ].join('')}
    </div>
  </nav>`
    : '';

  const body = `
<div class="page-head">
  <h1>Decks</h1>
  ${/* Two versions of the same sentence, one shown per breakpoint. The phone
       gets the short one so the first decklist clears the fold; the price date
       moved out of here entirely, to the note under the table. */ ''}
  <p class="lede">
    <span class="lede-long">Every imported top-8 decklist with a live build cost.</span>
    <span class="lede-short">Top-8 decklists, priced daily.</span>
    ${activeEra ? `Showing <b>${esc(activeEra.name)}</b>.` : ''}
    ${activeLegend ? `Filtered to <b>${esc(championOf(activeLegend))}</b>.` : ''}
  </p>
</div>

${/* Above the ad slot, so the reserved leaderboard height is never displaced
     and nothing below it shifts when the filter changes. */ ''}
${eraFilterBar(env, {
  path: '/decks',
  eras,
  counts,
  selected,
  allLabel: 'All decks',
  total: totalDecks,
})}

${searchForm}

${legendRow}

${adSlot('leaderboard')}

<div class="table-wrap">
  <table class="data-table data-table--decks" id="deck-table">
    <thead>
      <tr>
        <th scope="col">Deck</th>
        <th scope="col">Event</th>
        <th scope="col">Date</th>
        <th scope="col" class="num">Place</th>
        <th scope="col" class="num">Cards</th>
        <th scope="col" class="num">Build cost</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>

${hiddenByFilterNote(env, {
  path: '/decks',
  total: totalDecks,
  shown: decks.length,
  noun: 'deck',
})}

${
  priceDate
    ? `<p class="source-note">Build costs use TCGplayer market prices from ${esc(
        formatDate(priceDate),
      )}.</p>`
    : ''
}`;

  return htmlResponse(
    layout(env, {
      title: 'Riftbound decklists by build cost | Scoutpost',
      description:
        'Every Riftbound top-8 decklist tracked by Scoutpost, with a live build cost calculated from daily TCGplayer market prices.',
      path: '/decks',
      crumbs: [
        { name: 'Scoutpost', path: '/' },
        { name: 'Decks', path: '/decks' },
      ],
      robots: activeLegend || searchQ ? 'noindex, follow' : '',
      body,
    }),
  );
}
