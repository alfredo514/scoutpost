/**
 * /cards/<id> — one card: art on one side, its text on the other.
 *
 * The text pane exists for readability and accessibility. Card art is a JPEG of
 * a stylised layout; rules text set inside it cannot be selected, searched,
 * zoomed by a browser, read by a screen reader, or translated. Transcribing it
 * beside the image fixes all of that.
 *
 * **The catalogue API publishes no rules or flavor text.** A card record carries
 * only ids, names, type, faction, rarity, stats and image URLs — the printed
 * words exist solely as pixels. So card_text is populated by hand from
 * data/card-text/, is deliberately sparse, and this page renders the pane only
 * for cards that have a row. A card without one shows its art and the
 * structured fields, and says plainly that the text has not been transcribed.
 * It never invents a rules line.
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

const DOMAINS_WITH_ICONS = new Set(['body', 'calm', 'chaos', 'fury', 'mind', 'order']);

const COLOR_LABELS = {
  body: 'Body',
  calm: 'Calm',
  chaos: 'Chaos',
  fury: 'Fury',
  mind: 'Mind',
  order: 'Order',
  colorless: 'Colourless',
};

/**
 * Render inline Energy symbols. Rules text stores them as `{3}`, matching how
 * the card prints a numeral inside an Energy pip, so the transcription stays
 * readable as plain text and the page can style it.
 */
function withSymbols(text) {
  return esc(text).replace(
    /\{(\d+)\}/g,
    (_, n) => `<span class="energy-pip" aria-label="${n} Energy">${n}</span>`,
  );
}

export async function onRequestGet({ env, params }) {
  const card = await getCard(env.DB, params.id);
  if (!card) return notFound(env, 'Card');

  const decks = await decksPlayingCard(env.DB, card.id);
  const art = cardImageSrc(env, card, 'large');
  const hasText = Boolean(card.rules_text || card.typeline || card.energy_cost !== null);

  const domainIcon = DOMAINS_WITH_ICONS.has(card.faction)
    ? `<img class="stat-domain" src="${esc(url(env, `/domain-${card.faction}.png`))}"
           width="20" height="20" alt="${esc(COLOR_LABELS[card.faction] ?? card.faction)}"/>`
    : '';

  const statRow = [
    card.energy_cost !== null && card.energy_cost !== undefined
      ? `<div class="cardstat"><dt>Energy</dt><dd>${esc(card.energy_cost)}</dd></div>`
      : '',
    card.power !== null && card.power !== undefined
      ? `<div class="cardstat"><dt>Power</dt><dd>${esc(card.power)}</dd></div>`
      : '',
    `<div class="cardstat"><dt>Domain</dt><dd class="dd-domain">${domainIcon}${esc(
      COLOR_LABELS[card.faction] ?? card.faction ?? '—',
    )}</dd></div>`,
    `<div class="cardstat"><dt>Rarity</dt><dd>${esc(card.rarity ?? '—')}</dd></div>`,
  ]
    .filter(Boolean)
    .join('');

  const textPane = hasText
    ? `
      ${card.typeline ? `<p class="card-typeline">${esc(card.typeline)}</p>` : ''}
      <dl class="cardstats">${statRow}</dl>
      ${
        card.rules_text
          ? `<div class="rules-box">
               <p class="rules-text">${withSymbols(card.rules_text)}</p>
               ${
                 card.reminder_text
                   ? `<p class="reminder-text">(${esc(card.reminder_text)})</p>`
                   : ''
               }
             </div>`
          : ''
      }
      ${card.flavor_text ? `<p class="flavor-text">“${esc(card.flavor_text)}”</p>` : ''}`
    : `<dl class="cardstats">${statRow}</dl>
       <p class="notice">
         The rules and flavor text for this card haven't been transcribed yet.
         The catalogue we ingest doesn't publish them, so they're added by hand —
         everything printed on the card is readable in the art.
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
    ${card.artist ? ` · Art by ${esc(card.artist)}` : ''}
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
    ${card.subtitle ? `<p class="card-subtitle">${esc(card.subtitle)}</p>` : ''}
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
