/**
 * The page behind every planned section.
 *
 * One handler serves all of them, driven by SECTIONS. It exists so the nav can
 * carry the site's final shape today without any link going nowhere: a reader
 * who clicks "Cards" gets a straight answer about what that page will be and a
 * route back to something they can actually use.
 *
 * Deliberately `noindex`: these pages are thin by definition, and a crawler
 * filing three of them under the site would dilute the pages that matter. When
 * a section ships, flip its status in sections.js and point the router at the
 * real handler — this file needs no edit, and the noindex leaves with it.
 */

import { esc, htmlResponse, layout, url } from '../lib/render.js';
import { SECTIONS, findSection, liveSections } from '../lib/sections.js';

export function plannedHandler(sectionPath) {
  return async function onRequestGet({ env }) {
    const section = findSection(sectionPath);
    if (!section) throw new Error(`no section registered for ${sectionPath}`);

    const detail = (section.detail ?? [])
      .map((p) => `<p>${esc(p)}</p>`)
      .join('\n        ');

    // Point at what does work, so this is a junction rather than a dead end.
    const elsewhere = liveSections()
      .map(
        (s) =>
          `<li><a href="${esc(url(env, s.path))}"><b>${esc(s.label)}</b><span>${esc(
            s.summary,
          )}</span></a></li>`,
      )
      .join('\n        ');

    // The other things still to come, so the roadmap reads as a whole.
    const alsoPlanned = SECTIONS.filter((s) => s.status === 'planned' && s.path !== section.path)
      .map(
        (s) =>
          `<li><a href="${esc(url(env, s.path))}"><b>${esc(s.label)}</b><span>${esc(
            s.summary,
          )}</span></a></li>`,
      )
      .join('\n        ');

    const body = `
      <div class="page-head">
        <p class="eyebrow">Planned</p>
        <h1>${esc(section.label)}</h1>
        <p class="lede">${esc(section.summary)}</p>
      </div>

      <section class="panel planned-detail">
        ${detail}
      </section>

      <section>
        <div class="section-head"><h2>Available now</h2></div>
        <ul class="jump-list">
        ${elsewhere}
        </ul>
      </section>

      ${
        alsoPlanned
          ? `<section>
        <div class="section-head"><h2>Also on the way</h2></div>
        <ul class="jump-list jump-list--muted">
        ${alsoPlanned}
        </ul>
      </section>`
          : ''
      }
    `;

    return htmlResponse(
      layout(env, {
        title: `${section.label} — Scoutpost`,
        description: section.summary,
        path: section.path,
        robots: 'noindex, follow',
        crumbs: [
          { name: 'Scoutpost', path: '/' },
          { name: section.label, path: section.path },
        ],
        body,
      }),
      { maxAge: 3600 },
    );
  };
}
