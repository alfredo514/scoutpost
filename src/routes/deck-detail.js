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
} from '../lib/render.js';
import { getDeck, getDeckCards } from '../lib/queries.js';
import { cardImageSrc } from '../lib/images.js';

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

/**
 * One row's card cell: thumbnail, name, printed code, and a full-size
 * enlargement shown on hover or keyboard focus.
 *
 * The enlargement carries **no JavaScript**. Its art is a `background-image`
 * on an element that is `display: none` until `:hover`/`:focus`, and browsers
 * do not fetch a background for an unrendered element — so the ~100 KB large
 * rendition costs nothing on page load and is fetched once, on first hover,
 * then served from cache for a year. That is what lets a 31-row decklist carry
 * a readable preview per row without weighing anything.
 *
 * The thumbnail is a real <img> with explicit dimensions and `loading="lazy"`,
 * so rows below the fold cost nothing and none of them shift the layout.
 *
 * A card with no mirrored art degrades to an empty frame rather than a broken
 * image, and the row still reads correctly.
 */
function cardCell(env, c) {
  const thumb = cardImageSrc(env, c, 'small');
  const large = cardImageSrc(env, c, 'large');
  const code = c.public_code || `${c.set_id}-${c.collector_number}`;

  const art = thumb
    ? `<img class="card-thumb" src="${esc(thumb)}" width="40" height="56"
             loading="lazy" decoding="async" alt=""/>`
    : '<span class="card-thumb card-thumb--empty" aria-hidden="true"></span>';

  // aria-hidden: the enlargement is the same card the row already names, so a
  // screen reader gains nothing from it.
  const zoom = large
    ? `<span class="card-zoom" aria-hidden="true" style="--art:url('${esc(large)}')"></span>`
    : '';

  return `<span class="card-cell"${large ? ' tabindex="0"' : ''}>
          ${art}
          <span class="card-text">
            <span class="card-name">${esc(c.name)}</span>
            <span class="card-code">${esc(code)}</span>
          </span>
          ${zoom}
        </span>`;
}

export async function onRequestGet({ env, params }) {
  const deck = await getDeck(env.DB, params.id);
  if (!deck) return notFound(env, 'Deck');

  const cards = await getDeckCards(env.DB, deck.id);

  const total = cards.reduce((sum, c) => sum + (Number(c.line_total) || 0), 0);
  const cardCount = cards.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);
  const unpriced = cards.filter((c) => c.market_price === null || c.market_price === undefined);
  const priceDate = cards.find((c) => c.price_date)?.price_date ?? null;

  const main = cards.filter((c) => c.section !== 'sideboard');
  const side = cards.filter((c) => c.section === 'sideboard');
  const sum = (list) => list.reduce((t, c) => t + (Number(c.line_total) || 0), 0);
  const qty = (list) => list.reduce((t, c) => t + (Number(c.quantity) || 0), 0);

  const cardRow = (c) => `<tr>
      <td data-label="Qty" class="num qty">${esc(c.quantity)}×</td>
      <td data-label="Card">
        ${cardCell(env, c)}
      </td>
      <td data-label="Rarity">${esc(c.rarity || '—')}</td>
      <td data-label="Unit price" class="num">${money(c.market_price)}</td>
      <td data-label="Line total" class="num"><b>${money(c.line_total)}</b></td>
    </tr>`;

  const sectionRow = (label, list) =>
    `<tr class="section-row"><td colspan="5">${esc(label)} <span class="section-meta">${esc(
      qty(list),
    )} cards · ${money(sum(list))}</span></td></tr>`;

  const rows = cards.length
    ? [
        main.length ? sectionRow('Maindeck', main) + main.map(cardRow).join('') : '',
        side.length ? sectionRow('Sideboard', side) + side.map(cardRow).join('') : '',
      ].join('')
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
  <div class="summary"><span class="label">Maindeck</span><b>${money(sum(main))}</b></div>
  ${
    side.length
      ? `<div class="summary"><span class="label">Sideboard</span><b>${money(sum(side))}</b></div>`
      : ''
  }
  <div class="summary"><span class="label">Cards</span><b>${esc(cardCount)}</b></div>
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
