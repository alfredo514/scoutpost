import {
  adSlot,
  eraFilterBar,
  esc,
  formatDate,
  hiddenByFilterNote,
  htmlResponse,
  layout,
  money,
  placeLabel,
  url,
} from '../lib/render.js';
import { eventEraCounts, listEvents, setEras } from '../lib/queries.js';

/**
 * Default view: the current set only.
 *
 * A tournament result is only useful against the format it was played in, so
 * the newest set is the right thing to show first. The cost is that older
 * events are hidden until asked for — with four events across two sets, this
 * currently means one is visible by default. "All events" is one click away and
 * is what the nav's own link points to when the filter is on anything else.
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

  const [events, counts] = await Promise.all([
    listEvents(env.DB, { limit: 200, era: selected }),
    eventEraCounts(env.DB),
  ]);

  const totalEvents = Object.values(counts).reduce((a, b) => a + b, 0);
  const activeEra = eras.find((e) => e.id === selected);

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
    : `<tr><td colspan="6" class="empty-cell">
         No events played under ${esc(activeEra?.name ?? 'this set')} yet.
       </td></tr>`;

  const body = `
<div class="page-head">
  <h1>Events</h1>
  <p class="lede">
    Every event with a published top 8, and what those decks cost to build today.
    ${activeEra ? `Showing events played under <b>${esc(activeEra.name)}</b>.` : ''}
  </p>
</div>

${/* Above the table and above the ad slot, so the reserved leaderboard height
     is untouched and nothing below it shifts when the filter changes. */ ''}
${eraFilterBar(env, {
  path: '/events',
  eras,
  counts,
  selected,
  allLabel: 'All events',
  total: totalEvents,
})}

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
</div>

${hiddenByFilterNote(env, {
  path: '/events',
  total: totalEvents,
  shown: events.length,
  noun: 'event',
})}`;

  return htmlResponse(
    layout(env, {
      title: `${activeEra ? `${activeEra.name} events` : 'Riftbound events'} — top-8 decklists and build costs | Scoutpost`,
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
