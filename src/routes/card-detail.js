/**
 * /cards/<id> — one card: art on one side, its text on the other.
 *
 * The text pane exists for readability and accessibility. Card art is a JPEG of
 * a stylised layout; rules text set inside it cannot be selected, searched,
 * zoomed by a browser, read by a screen reader, or translated. Transcribing it
 * beside the image fixes all of that.
 *
 * The text comes from TCGplayer, not the card catalogue. Riftscribe publishes
 * no rules or flavor text at all, but TCGplayer's product data carries
 * Description, Flavor Text, Energy Cost, Power Cost, Might, Card Type, Tag and
 * Domain — and the price job already walks those products daily, so the text
 * arrives free and stays current. See writeCardText in ingest/src/prices.js.
 *
 * Coverage is 96% for rules text and 65% for flavor. A card with neither shows
 * its art and structured fields and says so; it never invents a rules line.
 */

import {
  adSlot,
  esc,
  formatDate,
  htmlResponse,
  layout,
  money,
  notFound,
  url,
} from '../lib/render.js';
import { decksPlayingCard, getCard } from '../lib/queries.js';
import { cardImageSrc } from '../lib/images.js';
import { COLOR_LABELS, domainIconSrc } from '../lib/vocab.js';




/**
 * Render card text safely.
 *
 * TCGplayer wraps reminder text and flavor text in <em>. Everything is escaped
 * first and then exactly that one tag is allowed back — a strict whitelist, so
 * no markup arriving from the feed can reach the page as anything else.
 */
function cardMarkup(text) {
  return esc(text)
    .replace(/&lt;em&gt;/g, '<em>')
    .replace(/&lt;\/em&gt;/g, '</em>');
}

export async function onRequestGet({ env, params }) {
  const card = await getCard(env.DB, params.id);
  if (!card) return notFound(env, 'Card');

  const decks = await decksPlayingCard(env.DB, card.id);
  const art = cardImageSrc(env, card, 'large');
  const hasText = Boolean(card.rules_text || card.type_line || card.energy_cost !== null);

  // "Fizz, Trickster" prints as Fizz with TRICKSTER beneath it, so the
  // subtitle is simply the part of the name after the comma.
  const subtitle = card.name.includes(',') ? card.name.split(',').slice(1).join(',').trim() : '';

  const domainIcon = domainIconSrc(env, card.faction)
    ? `<img class="stat-domain" src="${esc(url(env, `/domain-${card.faction}.png`))}"
           width="20" height="20" alt="${esc(COLOR_LABELS[card.faction] ?? card.faction)}"/>`
    : '';

  const stat = (label, value) =>
    value === null || value === undefined
      ? ''
      : `<div class="cardstat"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

  const statRow = [
    stat('Energy', card.energy_cost),
    stat('Power', card.power_cost),
    stat('Might', card.might),
    `<div class="cardstat"><dt>Domain</dt><dd class="dd-domain">${domainIcon}${esc(
      COLOR_LABELS[card.faction] ?? card.faction ?? '—',
    )}</dd></div>`,
    `<div class="cardstat"><dt>Rarity</dt><dd>${esc(card.rarity ?? '—')}</dd></div>`,
  ]
    .filter(Boolean)
    .join('');

  const textPane = hasText
    ? `
      ${
        card.type_line || card.tags
          ? `<p class="card-typeline">${esc(
              [card.type_line, ...(card.tags ? card.tags.split(';') : [])]
                .filter(Boolean)
                .join(' · '),
            )}</p>`
          : ''
      }
      <dl class="cardstats">${statRow}</dl>
      ${
        card.rules_text
          ? `<div class="rules-box">
               <p class="rules-text">${cardMarkup(card.rules_text)}</p>
             </div>`
          : ''
      }
      ${card.flavor_text ? `<p class="flavor-text">${cardMarkup(card.flavor_text)}</p>` : ''}`
    : `<dl class="cardstats">${statRow}</dl>
       <p class="notice">
         TCGplayer publishes no printed text for this card, so there is nothing
         to show beside the art. Everything on the card is readable in the image.
       </p>`;

  const playedIn = decks.length
    ? `<ul class="jump-list">${decks
        .map(
          (d) => `<li><a href="${esc(url(env, `/decks/${d.id}`))}">
            <b>${esc(d.quantity)}× — ${esc(d.legend || d.player_name || 'Decklist')}</b>
            <span>${esc(d.player_name)} · ${esc(d.event_name)} · ${esc(
              formatDate(d.event_date),
            )} · ${esc(d.section === 'sideboard' ? 'sideboard' : 'maindeck')}</span>
          </a></li>`,
        )
        .join('')}</ul>`
    : `<p class="lede">No top-8 deck we track is playing this card.</p>`;

  const body = `
<div class="page-head">
  <h1>${esc(card.name)}</h1>
  <p class="meta-line">
    ${esc(card.public_code || `${card.set_id}-${card.collector_number}`)}
    · ${esc(card.set_name || card.set_id)}
    · ${esc(card.card_type ?? '')}
  </p>
</div>

<div class="card-detail">
  <div class="card-detail-art">
    ${
      art
        ? `<img src="${esc(art)}" width="744" height="1039"
               alt="${esc(card.name)}" decoding="async"/>`
        : '<div class="tile-art--empty" aria-hidden="true"></div>'
    }
  </div>

  <div class="card-detail-text">
    ${subtitle ? `<p class="card-subtitle">${esc(subtitle)}</p>` : ''}
    ${textPane}

    <div class="summary-cards card-price-row">
      <div class="summary big">
        <span class="label">Market price</span>
        <b>${card.market_price === null ? '—' : money(card.market_price)}</b>
      </div>
      ${
        card.low_price !== null && card.low_price !== undefined
          ? `<div class="summary"><span class="label">Low</span><b>${money(card.low_price)}</b></div>`
          : ''
      }
    </div>
    ${
      card.price_date
        ? `<p class="source-note">Price as of ${esc(
            formatDate(card.price_date),
          )}, via TCGplayer.</p>`
        : ''
    }
  </div>
</div>

${adSlot('leaderboard')}

<section>
  <div class="section-head"><h2>Played in</h2></div>
  ${playedIn}
</section>`;

  return htmlResponse(
    layout(env, {
      title: `${card.name} — price and card text | Scoutpost`,
      description: `${card.name} (${
        card.public_code ?? card.set_id
      }): current TCGplayer market price, card text, and the top-8 decks playing it.`,
      path: `/cards/${card.id}`,
      crumbs: [
        { name: 'Scoutpost', path: '/' },
        { name: 'Cards', path: '/cards' },
        { name: card.name, path: `/cards/${card.id}` },
      ],
      body,
    }),
  );
}
