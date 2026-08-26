import {
  adSlot,
  esc,
  formatDate,
  htmlResponse,
  layout,
  money,
  notFound,
  placeLabel,
  url,
} from '../_lib/render.js';
import { getDeck, getDeckCards } from '../_lib/queries.js';

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

export async function onRequestGet({ env, params }) {
  const deck = await getDeck(env.DB, params.id);
  if (!deck) return notFound(env, 'Deck');

  const cards = await getDeckCards(env.DB, deck.id);

  const total = cards.reduce((sum, c) => sum + (Number(c.line_total) || 0), 0);
  const cardCount = cards.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);
  const unpriced = cards.filter((c) => c.market_price === null || c.market_price === undefined);
  const priceDate = cards.find((c) => c.price_date)?.price_date ?? null;

  const rows = cards.length
    ? cards
        .map(
          (c) => `<tr>
            <td data-label="Qty" class="num qty">${esc(c.quantity)}×</td>
            <td data-label="Card">
              <span class="card-name">${esc(c.name)}</span>
              <span class="card-code">${esc(c.public_code || `${c.set_id}-${c.collector_number}`)}</span>
            </td>
            <td data-label="Rarity">${esc(c.rarity || '—')}</td>
            <td data-label="Unit price" class="num">${money(c.market_price)}</td>
            <td data-label="Line total" class="num"><b>${money(c.line_total)}</b></td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="5" class="empty-cell">No cards recorded for this deck.</td></tr>`;

  const body = `
<div class="page-head">
  <h1>${esc(deck.legend || deck.player_name || 'Decklist')}</h1>
  <p class="meta-line">
    <span class="place place-${esc(deck.placement)}">${esc(
      ORDINALS[deck.placement] ?? deck.placement,
    )}</span>
    at <a class="strong-link" href="${esc(url(env, `/events/${deck.event_slug}`))}">${esc(
      deck.event_name,
    )}</a>
    · ${esc(formatDate(deck.event_date))}
    ${placeLabel(deck) ? ` · ${esc(placeLabel(deck))}` : ''}
  </p>
  ${deck.player_name && deck.legend ? `<p class="meta-line">Piloted by ${esc(deck.player_name)}</p>` : ''}
  ${deck.notes ? `<p class="notes">${esc(deck.notes)}</p>` : ''}
</div>

<div class="summary-cards">
  <div class="summary big"><span class="label">Build cost</span><b>${money(total)}</b></div>
  <div class="summary"><span class="label">Cards</span><b>${esc(cardCount)}</b></div>
  <div class="summary"><span class="label">Distinct</span><b>${esc(cards.length)}</b></div>
  <div class="summary"><span class="label">Priced</span><b>${esc(
    cards.length - unpriced.length,
  )}/${esc(cards.length)}</b></div>
</div>

${
  unpriced.length
    ? `<p class="notice">
        ${esc(unpriced.length)} card${unpriced.length === 1 ? '' : 's'} in this list
        ${unpriced.length === 1 ? 'has' : 'have'} no market price yet, so the total above is a floor,
        not a final figure.
      </p>`
    : ''
}

${adSlot('leaderboard')}

<div class="table-wrap">
  <table class="data-table">
    <thead>
      <tr>
        <th scope="col" class="num">Qty</th>
        <th scope="col">Card</th>
        <th scope="col">Rarity</th>
        <th scope="col" class="num">Unit price</th>
        <th scope="col" class="num">Line total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="4" class="num">Total</td>
        <td class="num"><b class="cost">${money(total)}</b></td>
      </tr>
    </tfoot>
  </table>
</div>
${priceDate ? `<p class="source-note">Market prices as of ${esc(formatDate(priceDate))}, via TCGplayer.</p>` : ''}`;

  return htmlResponse(
    layout(env, {
      title: `${deck.legend || deck.player_name || 'Decklist'} — ${
        ORDINALS[deck.placement] ?? deck.placement
      } at ${deck.event_name} | Scoutpost`,
      description: `Full decklist and ${money(total)} build cost for the ${
        ORDINALS[deck.placement] ?? deck.placement
      } place deck at ${deck.event_name}, priced with daily TCGplayer market data.`,
      path: `/decks/${deck.id}`,
      crumbs: [
        { name: 'Scoutpost', path: '/' },
        { name: 'Events', path: '/events' },
        { name: deck.event_name, path: `/events/${deck.event_slug}` },
        { name: ORDINALS[deck.placement] ?? String(deck.placement), path: `/decks/${deck.id}` },
      ],
      body,
    }),
  );
}
