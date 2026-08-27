/**
 * Every top-level section of the site, in nav order.
 *
 * This is the ONE place a section is declared. The header nav, the footer, the
 * router and the sitemap all read from here, so the site's shape is fixed now
 * and shipping a planned page is a two-line change:
 *
 *   1. flip `status` to 'live'
 *   2. point the router at the real handler in src/index.js
 *
 * Nothing about the nav, the footer, the styling or the sitemap needs touching.
 *
 * A planned section is NOT a dead link. It routes to a real page that says what
 * the section will do and sends the reader somewhere useful in the meantime,
 * and it carries `noindex` so a crawler never files a thin page under the site.
 * That is the whole reason planned pages get routes rather than bare hrefs.
 */

export const SECTIONS = [
  {
    path: '/events',
    label: 'Events',
    status: 'live',
    summary: 'Every tournament we cover, newest first, with the cost spread across its top 8.',
  },
  {
    path: '/decks',
    label: 'Decks',
    status: 'live',
    summary: 'Every decklist we hold, ranked by what it costs to build.',
  },
  {
    path: '/cards',
    label: 'Cards',
    status: 'planned',
    summary: 'A page per card: what it costs today and how that price has moved.',
    detail: [
      'Every card in a decklist will link to its own page — the current market price, the price history as a chart, and which top-8 decks are playing it.',
      'The daily price snapshots behind this are already being collected, and have been since the site launched. What is missing is the page that reads them, not the data.',
    ],
  },
  {
    path: '/rankings',
    label: 'Rankings',
    status: 'planned',
    summary: 'The most expensive cards in the game, and the ones moving fastest.',
    detail: [
      'Leaderboards for the priciest cards overall and by set, the signature and showcase printings, and the biggest movers week over week.',
      'This is the same price history the card pages will use, sliced the other way — so it lands alongside them.',
    ],
  },
  {
    path: '/box-ev',
    label: 'Box EV',
    status: 'planned',
    summary: 'What a sealed box is actually worth, against what it costs.',
    detail: [
      'Pull rates and current singles prices, combined into the expected value of a sealed box — so you can see at a glance whether cracking packs beats buying the cards outright.',
      'This one needs pull-rate data the catalogue does not carry yet, so it is the furthest out of the three.',
    ],
  },
];

/** Sections with a real page behind them. */
export const liveSections = () => SECTIONS.filter((s) => s.status === 'live');

/** Sections that route to a placeholder. */
export const plannedSections = () => SECTIONS.filter((s) => s.status === 'planned');

export function findSection(path) {
  return SECTIONS.find((s) => s.path === path);
}
