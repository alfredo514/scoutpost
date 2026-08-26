import { adSlot, esc, formatDate, htmlResponse, layout, money, url } from '../lib/render.js';
import { latestPriceDate, listDecks } from '../lib/queries.js';

export async function onRequestGet({ env }) {
  const [decks, priceDate] = await Promise.all([
    listDecks(env.DB, { limit: 300 }),
    latestPriceDate(env.DB),
  ]);

  const rows = decks.length
    ? decks
        .map(
          (d) => `<tr>
            <td data-label="Deck">
              <a class="strong-link" href="${esc(url(env, `/decks/${d.id}`))}">${esc(
                d.legend || d.player_name || 'Decklist',
              )}</a>
              ${d.player_name && d.legend ? `<span class="legend">${esc(d.player_name)}</span>` : ''}
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
    : `<tr><td colspan="6" class="empty-cell">No decks imported yet.</td></tr>`;

  const body = `
<div class="page-head">
  <h1>Decks</h1>
  <p class="lede">
    Every imported top-8 decklist with a live build cost.
    ${priceDate ? `Prices as of ${esc(formatDate(priceDate))}.` : ''}
  </p>
</div>

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
</div>`;

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
