import { adSlot, esc, formatDate, htmlResponse, layout, money, placeLabel, url } from '../lib/render.js';
import { listEvents, siteStats } from '../lib/queries.js';

export async function onRequestGet({ env }) {
  const [events, stats] = await Promise.all([listEvents(env.DB, { limit: 6 }), siteStats(env.DB)]);

  const eventCards = events.length
    ? events
        .map(
          (e) => `<a class="event-card" href="${esc(url(env, `/events/${e.id}`))}">
            <div class="event-card-top">
              <h3>${esc(e.name)}</h3>
              <span class="date">${esc(formatDate(e.date))}</span>
            </div>
            <p class="meta">${esc(placeLabel(e))}${e.format ? ` · ${esc(e.format)}` : ''}</p>
            <div class="spread">
              <span><span class="label">Top deck</span><b>${money(e.max_cost)}</b></span>
              <span><span class="label">Cheapest</span><b>${money(e.min_cost)}</b></span>
              <span><span class="label">Decks</span><b>${esc(e.deck_count ?? 0)}</b></span>
            </div>
          </a>`,
        )
        .join('')
    : `<div class="panel empty">
         <h3>No events imported yet</h3>
         <p>Drop a JSON file into <code>data/events/</code> and run the import to publish a top 8.</p>
       </div>`;

  const body = `
<section class="hero">
  <h1>Riftbound top 8s, with the <em>build cost</em> attached.</h1>
  <p class="lede">
    Every decklist from major events, priced against daily TCGplayer market data.
    See what the winning deck actually costs to build — and what the cheapest deck
    in the same top 8 got there for.
  </p>
  <div class="hero-actions">
    <a class="btn btn-primary" href="${esc(url(env, '/events'))}">Browse events</a>
    <a class="btn" href="${esc(url(env, '/decks'))}">All decks by cost</a>
  </div>
  <dl class="stat-row">
    <div><dt>Cards tracked</dt><dd>${esc(stats.cards.toLocaleString('en-US'))}</dd></div>
    <div><dt>Events</dt><dd>${esc(stats.events)}</dd></div>
    <div><dt>Decks priced</dt><dd>${esc(stats.decks)}</dd></div>
    <div><dt>Prices as of</dt><dd>${esc(stats.priceDate ? formatDate(stats.priceDate) : '—')}</dd></div>
  </dl>
</section>

${adSlot('leaderboard')}

<section>
  <div class="section-head">
    <h2>Recent events</h2>
    <a class="more" href="${esc(url(env, '/events'))}">All events →</a>
  </div>
  <div class="event-grid">${eventCards}</div>
</section>

<section class="panel about">
  <h2>How the cost is calculated</h2>
  <p>
    Build cost is the sum of every card in the list multiplied by its most recent
    TCGplayer market price. Prices come from a daily snapshot, and each card falls
    back to its own last known price if it was missing from the latest run — so a
    gap in the feed never silently drops a card from a total.
  </p>
  <p>
    Costs are recalculated on every page view, not stored. Where a card has no
    price yet, the deck shows how many of its cards are priced so you can judge
    the number for yourself.
  </p>
</section>`;

  return htmlResponse(
    layout(env, {
      title: 'Scoutpost — Riftbound top-8 decklists with live build costs',
      description:
        'Riftbound TCG top-8 decklists from major events, each priced with daily TCGplayer market data. Card prices, deck costs and event coverage.',
      path: '/',
      crumbs: [{ name: 'Scoutpost', path: '/' }],
      body,
    }),
  );
}
