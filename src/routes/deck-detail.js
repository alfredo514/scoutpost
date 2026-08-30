import {
  adSlot,
  esc,
  formatDate,
  htmlResponse,
  layout,
  money,
  notFound,
  ordinal,
  placeLabel,
  url,
} from '../lib/render.js';
import { deckSiblings, getDeck, getDeckCards } from '../lib/queries.js';
import { cardImageSrc, cardMark } from '../lib/images.js';
import { championOf } from '../lib/vocab.js';

/**
 * Reading order for a decklist.
 *
 * The Legend leads because it is the deck's leader — it decides what the rest
 * of the list is allowed to be, so a player identifies a deck by it before
 * anything else. Then the body of the deck, then the resources it runs on.
 *
 * Sorting purely by price, which is what this page used to do, buried the
 * Legend wherever its market price happened to put it. That is the wrong
 * answer for a reader even on a site about prices. Cost order is kept *within*
 * each group, so the expensive cards still surface where they matter.
 */
const TYPE_ORDER = ['Legend', 'Unit', 'Spell', 'Gear', 'Battlefield', 'Rune'];

const TYPE_LABELS = {
  Legend: 'Legend',
  Unit: 'Units',
  Spell: 'Spells',
  Gear: 'Gear',
  Battlefield: 'Battlefields',
  Rune: 'Runes',
};

/**
 * The decklist as plain text, in the same reading order as the table.
 *
 * Built on the server rather than scraped from the DOM at click time: the
 * format is then testable, it survives any change to the table markup, and the
 * text exists on the page whether or not a script ever runs — which is what
 * lets the block below work by selecting it manually.
 *
 * Deliberately NOT claiming to be an import format for any particular
 * deckbuilder. It is the conventional "quantity, name, printing" shape that
 * reads correctly to a human and pastes into a message; if a real importer
 * format is ever confirmed, this is the one function to change.
 */
function deckAsText(deck, groups, side) {
  const line = (c) =>
    `${c.quantity} ${c.name}${
      c.public_code ? ` (${c.public_code})` : ''
    }`;

  const blocks = groups.map(([type, list]) =>
    [TYPE_LABELS[type] ?? type, ...list.map(line)].join('\n'),
  );

  if (side.length) blocks.push(['Sideboard', ...side.map(line)].join('\n'));

  const header = [
    deck.legend || deck.player_name || 'Decklist',
    [deck.player_name, deck.event_name].filter(Boolean).join(' · '),
  ]
    .filter(Boolean)
    .join('\n');

  return `${header}\n\n${blocks.join('\n\n')}\n`;
}

/** [[type, cards], …] in TYPE_ORDER; anything unrecognised sorts last. */
function groupByType(list) {
  const groups = new Map();
  for (const c of list) {
    const type = c.card_type || 'Other';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(c);
  }
  const rank = (t) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

export async function onRequestGet({ env, params }) {
  const deck = await getDeck(env.DB, params.id);
  if (!deck) return notFound(env, 'Deck');

  const [cards, { siblings, sameLegend }] = await Promise.all([
    getDeckCards(env.DB, deck.id),
    deckSiblings(env.DB, {
      eventId: deck.event_id,
      deckId: deck.id,
      legend: deck.legend,
    }),
  ]);

  const total = cards.reduce((sum, c) => sum + (Number(c.line_total) || 0), 0);
  const cardCount = cards.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);
  const unpriced = cards.filter((c) => c.market_price === null || c.market_price === undefined);
  const priceDate = cards.find((c) => c.price_date)?.price_date ?? null;

  const main = cards.filter((c) => c.section !== 'sideboard');
  const side = cards.filter((c) => c.section === 'sideboard');
  const sum = (list) => list.reduce((t, c) => t + (Number(c.line_total) || 0), 0);
  const qty = (list) => list.reduce((t, c) => t + (Number(c.quantity) || 0), 0);

  /* The data attributes are for public/app.js's collection tracking. Numbers
     rather than the rendered "$12.34", because a script that parses its own
     page's formatting breaks the first time the formatting changes — and would
     break silently, in a total. The row is inert without script. */
  const cardRow = (c) => `<tr data-card="${esc(c.id)}" data-qty="${esc(c.quantity)}"${
    c.market_price === null || c.market_price === undefined
      ? ''
      : ` data-line="${esc(c.line_total)}"`
  }>
      <td data-label="Qty" class="num qty">${esc(c.quantity)}×</td>
      <td data-label="Card">
        ${cardMark(env, c)}
      </td>
      <td data-label="Rarity">${esc(c.rarity || '—')}</td>
      <td data-label="Unit price" class="num">${money(c.market_price)}</td>
      <td data-label="Line total" class="num"><b>${money(c.line_total)}</b></td>
    </tr>`;

  const sectionRow = (label, list) =>
    `<tr class="section-row"><td colspan="5">${esc(label)} <span class="section-meta">${esc(
      qty(list),
    )} card${qty(list) === 1 ? '' : 's'} · ${money(sum(list))}</span></td></tr>`;

  const groups = groupByType(main);

  const mainRows = groups
    .map(([type, list]) => sectionRow(TYPE_LABELS[type] ?? type, list) + list.map(cardRow).join(''))
    .join('');

  const rows = cards.length
    ? [
        mainRows,
        side.length ? sectionRow('Sideboard', side) + side.map(cardRow).join('') : '',
      ].join('')
    : `<tr><td colspan="5" class="empty-cell">No cards recorded for this deck.</td></tr>`;

  // The deck's leader, shown alongside the list the way a player thinks of it.
  const legendCard = main.find((c) => c.card_type === 'Legend');
  const legendArt = legendCard ? cardImageSrc(env, legendCard, 'large') : null;

  /* Reading a top 8 meant returning to the event page between every deck.
     Prev/next covers reading them in order; the strip covers jumping straight
     to 7th, which prev/next would make five clicks. Both are plain links. */
  const here = siblings.findIndex((d) => d.id === deck.id);
  const prev = here > 0 ? siblings[here - 1] : null;
  const next = here >= 0 && here < siblings.length - 1 ? siblings[here + 1] : null;

  const arrow = (d, dir) => {
    const label = dir === 'prev' ? '←' : '→';
    if (!d) {
      return `<span class="btn is-disabled" aria-disabled="true">${label}</span>`;
    }
    const who = championOf(d.legend) || d.player_name || 'Decklist';
    return `<a class="btn sib-arrow" href="${esc(url(env, `/decks/${d.id}`))}"${
      dir === 'prev' ? ' rel="prev"' : ' rel="next"'
    }>${dir === 'prev' ? `${label} ` : ''}<span class="sib-arrow-place">${esc(
      ordinal(d.placement),
    )}</span><span class="sib-arrow-who">${esc(who)}</span>${
      dir === 'next' ? ` ${label}` : ''
    }</a>`;
  };

  const strip = siblings.length > 1
    ? `<ol class="sib-strip">${siblings
        .map((d) => {
          const on = d.id === deck.id;
          const title = `${ordinal(d.placement)} — ${
            championOf(d.legend) || d.player_name || 'Decklist'
          }`;
          return `<li>${
            on
              ? `<span class="sib-pill is-on" aria-current="page" title="${esc(
                  title,
                )}">${esc(d.placement)}</span>`
              : `<a class="sib-pill" href="${esc(
                  url(env, `/decks/${d.id}`),
                )}" title="${esc(title)}"><span class="sr-only">${esc(
                  title,
                )}</span><span aria-hidden="true">${esc(d.placement)}</span></a>`
          }</li>`;
        })
        .join('')}</ol>`
    : '';

  const siblingNav = siblings.length > 1
    ? `<nav class="deck-siblings" aria-label="Other decks in this top 8">
  ${arrow(prev, 'prev')}
  ${strip}
  ${arrow(next, 'next')}
</nav>
${
  sameLegend
    ? `<p class="source-note sib-legend-note">
        <a href="${esc(
          url(env, `/decks?set=all&legend=${encodeURIComponent(deck.legend)}`),
        )}">${esc(sameLegend)} other ${esc(
        championOf(deck.legend),
      )} deck${sameLegend === 1 ? '' : 's'}</a> across every event.
      </p>`
    : ''
}`
    : '';

  const body = `
<div class="page-head">
  <h1>${esc(deck.legend || deck.player_name || 'Decklist')}</h1>
  <p class="meta-line">
    <span class="place place-${esc(deck.placement)}">${esc(
      ordinal(deck.placement),
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

<div class="summary-cards" data-deck-summary>
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

<div class="deck-layout">
  <div class="deck-list">
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
    ${/* Useful with no script at all — open it and select the text. app.js
         upgrades it with a Copy button when the clipboard API is available,
         and adds nothing when it is not, so there is never a button that
         does not work. */ ''}
    ${
      cards.length
        ? `<div class="deck-export-wrap">
      <details class="deck-export">
      <summary><span class="deck-export-trigger">Plain text list</span></summary>
      <div class="deck-export-body">
        <pre class="deck-export-text" id="deck-export-text">${esc(
          deckAsText(deck, groups, side),
        )}</pre>
      </div>
      </details>
    </div>`
        : ''
    }
    ${priceDate ? `<p class="source-note">Market prices as of ${esc(formatDate(priceDate))}, via TCGplayer.</p>` : ''}
    ${siblingNav}
  </div>
  ${
    legendArt
      ? `<aside class="legend-panel" aria-label="Legend">
    <h2 class="legend-panel-title">Legend</h2>
    <img class="legend-art" src="${esc(legendArt)}" width="744" height="1039"
         alt="${esc(legendCard.name)}" decoding="async"/>
    <p class="legend-panel-name">${esc(legendCard.name)}</p>
    <p class="legend-panel-meta">${esc(
      legendCard.public_code || `${legendCard.set_id}-${legendCard.collector_number}`,
    )} · ${money(legendCard.market_price)}</p>
  </aside>`
      : ''
  }
</div>`;

  return htmlResponse(
    layout(env, {
      title: `${deck.legend || deck.player_name || 'Decklist'} — ${
        ordinal(deck.placement)
      } at ${deck.event_name} | Scoutpost`,
      description: `Full decklist and ${money(total)} build cost for the ${
        ordinal(deck.placement)
      } place deck at ${deck.event_name}, priced with daily TCGplayer market data.`,
      path: `/decks/${deck.id}`,
      crumbs: [
        { name: 'Scoutpost', path: '/' },
        { name: 'Events', path: '/events' },
        { name: deck.event_name, path: `/events/${deck.event_slug}` },
        { name: ordinal(deck.placement), path: `/decks/${deck.id}` },
      ],
      body,
    }),
  );
}
