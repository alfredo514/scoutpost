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
  url,
} from '../lib/render.js';
import { deckEraCounts, latestPriceDate, listDecks, setEras } from '../lib/queries.js';
import { legendMark } from '../lib/images.js';

/**
 * Default view: the current set only, matching /events.
 *
 * A decklist is only meaningful against the format it was played in. The cost
 * is that everything older is hidden until asked for — see the note under the
 * table, which says how many and links to the full list.
 */
const DEFAULT_ERA = 'newest';

/**
 * Ordinal suffix for a top-8 placement.
 *
 * Only ever 1–8 here, so this is the whole rule rather than the general case
 * with its 11th/12th/13th exceptions. It is rendered as a separate span the
 * desktop column hides: "Place | 1" reads correctly as a column, and "1st
 * Place" reads correctly as a line of inline metadata.
 */
const ORDINAL_SUFFIX = { 1: 'st', 2: 'nd', 3: 'rd' };
const ordinal = (n) => ORDINAL_SUFFIX[n] ?? 'th';

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const eras = await setEras(env.DB);
  const newest = eras[0]?.id ?? '';

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

  const [decks, counts, priceDate] = await Promise.all([
    listDecks(env.DB, { limit: 300, era: selected }),
    deckEraCounts(env.DB),
    latestPriceDate(env.DB),
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
              `<span class="unit">${esc(ordinal(d.placement))} Place</span>`
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
         No decks played under ${esc(activeEra?.name ?? 'this set')} yet.
       </td></tr>`;

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
      body,
    }),
  );
}
