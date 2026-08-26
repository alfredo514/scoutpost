import {
  adSlot,
  esc,
  formatDate,
  htmlResponse,
  layout,
  money,
  placeLabel,
  url,
} from '../lib/render.js';
import { listEvents } from '../lib/queries.js';

export async function onRequestGet({ env }) {
  const events = await listEvents(env.DB, { limit: 200 });

  const rows = events.length
    ? events
        .map(
          (e) => `<tr>
            <td data-label="Event">
              <a class="strong-link" href="${esc(url(env, `/events/${e.id}`))}">${esc(e.name)}</a>
              ${e.format ? `<span class="tag">${esc(e.format)}</span>` : ''}
            </td>
            <td data-label="Date">${esc(formatDate(e.date))}</td>
            <td data-label="Location">${esc(placeLabel(e)) || '—'}</td>
            <td data-label="Decks" class="num">${esc(e.deck_count ?? 0)}</td>
            <td data-label="Top deck" class="num">${money(e.max_cost)}</td>
            <td data-label="Cheapest" class="num">${money(e.min_cost)}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" class="empty-cell">No events imported yet.</td></tr>`;

  const body = `
<div class="page-head">
  <h1>Events</h1>
  <p class="lede">Every event with a published top 8, and what those decks cost to build today.</p>
</div>

${adSlot('leaderboard')}

<div class="table-wrap">
  <table class="data-table">
    <thead>
      <tr>
        <th scope="col">Event</th>
        <th scope="col">Date</th>
        <th scope="col">Location</th>
        <th scope="col" class="num">Decks</th>
        <th scope="col" class="num">Top deck</th>
        <th scope="col" class="num">Cheapest</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;

  return htmlResponse(
    layout(env, {
      title: 'Riftbound events — top-8 decklists and build costs | Scoutpost',
      description:
        'Every Riftbound event with published top-8 decklists, sorted by date, with the most and least expensive deck in each top 8.',
      path: '/events',
      crumbs: [
        { name: 'Scoutpost', path: '/' },
        { name: 'Events', path: '/events' },
      ],
      body,
    }),
  );
}
