import {
  adSlot,
  absoluteUrl,
  esc,
  formatDate,
  htmlResponse,
  layout,
  money,
  notFound,
  placeLabel,
  url,
} from '../lib/render.js';
import { getEvent, getEventDecks, latestPriceDate } from '../lib/queries.js';

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

export async function onRequestGet({ env, params }) {
  const slug = params.slug;
  const event = await getEvent(env.DB, slug);
  if (!event) return notFound(env, 'Event');

  const [decks, priceDate] = await Promise.all([
    getEventDecks(env.DB, event.id),
    latestPriceDate(env.DB),
  ]);

  const costs = decks.map((d) => Number(d.total_cost) || 0).filter((c) => c > 0);
  const maxCost = costs.length ? Math.max(...costs) : 0;
  const minCost = costs.length ? Math.min(...costs) : 0;
  const spread = maxCost - minCost;
  const multiple = minCost > 0 ? maxCost / minCost : null;

  // The cost spread across placements is the story worth surfacing.
  const spreadStory = costs.length >= 2
    ? `<p class="spread-story">
         The most expensive deck in this top 8 cost <b>${money(maxCost)}</b>; the
         cheapest cost <b>${money(minCost)}</b> — a <b>${money(spread)}</b> gap${
           multiple && multiple >= 1.15 ? `, or <b>${multiple.toFixed(1)}×</b> the price` : ''
         }.
       </p>`
    : '';

  const deckRows = decks.length
    ? decks
        .map((d) => {
          const cost = Number(d.total_cost) || 0;
          const pct = maxCost > 0 ? Math.max(2, Math.round((cost / maxCost) * 100)) : 0;
          const unpriced = Number(d.distinct_cards ?? 0) - Number(d.priced_cards ?? 0);
          return `<tr>
            <td data-label="Place"><span class="place place-${esc(d.placement)}">${esc(
              ORDINALS[d.placement] ?? d.placement,
            )}</span></td>
            <td data-label="Player">
              <a class="strong-link" href="${esc(url(env, `/decks/${d.id}`))}">${esc(
                d.player_name || 'Unknown player',
              )}</a>
              ${d.legend ? `<span class="legend">${esc(d.legend)}</span>` : ''}
            </td>
            <td data-label="Cards" class="num">${esc(d.card_count ?? 0)}</td>
            <td data-label="Build cost" class="num">
              <span class="cost">${money(cost)}</span>
              ${
                unpriced > 0
                  ? `<span class="warn-note" title="${esc(
                      unpriced,
                    )} card(s) have no price yet">${esc(unpriced)} unpriced</span>`
                  : ''
              }
            </td>
            <td data-label="Relative" class="bar-cell">
              <span class="bar" style="--pct:${pct}%"><span class="bar-fill"></span></span>
            </td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="empty-cell">No decklists imported for this event yet.</td></tr>`;

  const jsonLd = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: event.name,
    startDate: event.date,
    eventStatus: 'https://schema.org/EventScheduled',
    url: absoluteUrl(env, `/events/${event.id}`),
    location: {
      '@type': 'Place',
      name: event.store || placeLabel(event) || 'Unknown venue',
      address: {
        '@type': 'PostalAddress',
        addressLocality: event.city || undefined,
        addressRegion: event.state || undefined,
        addressCountry: event.country || undefined,
      },
    },
  }).replace(/</g, '\\u003c')}</script>`;

  const body = `
<div class="page-head">
  <h1>${esc(event.name)}</h1>
  <p class="meta-line">
    ${esc(formatDate(event.date))}
    ${placeLabel(event) ? ` · ${esc(placeLabel(event))}` : ''}
    ${event.store ? ` · ${esc(event.store)}` : ''}
    ${event.format ? ` · <span class="tag">${esc(event.format)}</span>` : ''}
  </p>
  ${spreadStory}
</div>

<div class="summary-cards">
  <div class="summary"><span class="label">Most expensive</span><b>${money(maxCost)}</b></div>
  <div class="summary"><span class="label">Cheapest</span><b>${money(minCost)}</b></div>
  <div class="summary"><span class="label">Spread</span><b>${money(spread)}</b></div>
  <div class="summary"><span class="label">Decks</span><b>${esc(decks.length)}</b></div>
</div>

${adSlot('leaderboard')}

<section>
  <div class="section-head">
    <h2>Top 8 by build cost</h2>
    ${priceDate ? `<span class="as-of">Prices as of ${esc(formatDate(priceDate))}</span>` : ''}
  </div>
  <div class="table-wrap">
    <table class="data-table deck-table">
      <thead>
        <tr>
          <th scope="col">Place</th>
          <th scope="col">Player</th>
          <th scope="col" class="num">Cards</th>
          <th scope="col" class="num">Build cost</th>
          <th scope="col" class="bar-head">Relative cost</th>
        </tr>
      </thead>
      <tbody>${deckRows}</tbody>
    </table>
  </div>
  ${
    event.source_url
      ? `<p class="source-note">Decklists published at
         <a href="${esc(event.source_url)}" rel="nofollow noopener" target="_blank">the event organiser’s page</a>.</p>`
      : ''
  }
</section>`;

  return htmlResponse(
    layout(env, {
      title: `${event.name} top 8 — decklists and build costs | Scoutpost`,
      description: `Top-8 Riftbound decklists from ${event.name} (${formatDate(
        event.date,
      )}), each with a live build cost from daily TCGplayer market prices.`,
      path: `/events/${event.id}`,
      crumbs: [
        { name: 'Scoutpost', path: '/' },
        { name: 'Events', path: '/events' },
        { name: event.name, path: `/events/${event.id}` },
      ],
      jsonLd,
      body,
    }),
  );
}
