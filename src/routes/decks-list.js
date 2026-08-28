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
            <td data-label="Deck">
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
            <td data-label="Event">
              <a href="${esc(url(env, `/events/${d.event_slug}`))}">${esc(d.event_name)}</a>
            </td>
            <td data-label="Date">${esc(formatDate(d.event_date))}</td>
            <td data-label="Place" class="num">${esc(d.placement)}</td>
            <td data-label="Cards" class="num">${esc(d.card_count ?? 0)}</td>
            <td data-label="Build cost" class="num"><span class="cost">${money(d.total_cost)}</span></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" class="empty-cell">
         No decks played under ${esc(activeEra?.name ?? 'this set')} yet.
       </td></tr>`;

  const body = `
<div class="page-head">
  <h1>Decks</h1>
  <p class="lede">
    Every imported top-8 decklist with a live build cost.
    ${activeEra ? `Showing decks played under <b>${esc(activeEra.name)}</b>.` : ''}
    ${priceDate ? `Prices as of ${esc(formatDate(priceDate))}.` : ''}
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
  <table class="data-table" id="deck-table">
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
})}`;

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
