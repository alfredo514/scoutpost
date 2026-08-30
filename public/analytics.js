/* Scoutpost — GA4 event placeholder.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS NOT LOADED BY ANY PAGE, AND THAT IS DELIBERATE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Scoutpost ships exactly one script, public/app.js, and it is an enhancement:
 * nothing on any page requires it (see §22 of docs/HANDOFF.md). Loading this
 * file would be different in kind — it exists to feed a third-party tracker
 * rather than to improve the page, and the reader gets nothing for it. So the
 * wiring is written here and left disconnected, for whoever decides that
 * tradeoff is worth making.
 *
 *
 * READ THIS BEFORE YOU CONNECT IT — you probably do not need to.
 *
 * Every control on /decks already produces a distinct URL:
 *
 *     /decks?legend=Irelia%2C+Blade+Dancer
 *     /decks?q=draven
 *     /decks?set=all&legend=Azir%2C+Emperor+of+the+Sands
 *
 * GA4 records the full path and query string on every page_view. "Which Legends
 * do people filter by" is therefore already answerable in GA4 out of the box —
 * report on Page path + query string, or build a custom dimension from the
 * `legend` and `q` parameters. No event wiring, no extra script from us, and it
 * keeps working for readers who block scripts, which event-based tracking does
 * not.
 *
 * The gtag snippet itself is a third-party script and is a separate decision
 * from this file. If it is already on the page, the above works today.
 *
 *
 * IF YOU STILL WANT EXPLICIT EVENTS
 *
 * 1. Add the GA4 gtag snippet in `layout()` (src/lib/render.js).
 * 2. Add `<script src="/analytics.js" defer></script>` after it.
 * 3. Update §21 of docs/HANDOFF.md to say it is wired.
 *
 * Everything below degrades silently when gtag is absent, so loading it before
 * step 1 is harmless — it simply does nothing.
 */

(function () {
  'use strict';

  /** Send an event to GA4 if it is present. No gtag, no-op, no error. */
  function track(name, params) {
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', name, params || {});
  }

  /**
   * A Legend avatar was clicked.
   *
   * Note this fires on a real navigation, so the browser may unload the page
   * before the request goes out. GA4's transport uses sendBeacon where it can,
   * which survives unload; if events go missing this is the first thing to
   * check, and the URL-based approach at the top of this file does not have
   * the problem at all.
   */
  function onLegendFilter(legend) {
    track('filter_legend', {
      legend: legend,
      // The champion's own name, which is the half people actually search for.
      champion: String(legend || '').split(',')[0].trim(),
    });
  }

  /** The deck search form was submitted. */
  function onDeckSearch(query) {
    var q = String(query || '').trim();
    if (!q) return;
    track('search_decks', { search_term: q.toLowerCase().slice(0, 100) });
  }

  document.addEventListener('click', function (e) {
    var avatar = e.target.closest && e.target.closest('.legend-av');
    if (!avatar) return;
    var name = avatar.querySelector('.legend-av-name');
    onLegendFilter(name ? name.textContent.trim() : '');
  });

  var form = document.querySelector('.deck-search');
  if (form) {
    form.addEventListener('submit', function () {
      var input = form.querySelector('input[name="q"]');
      onDeckSearch(input ? input.value : '');
    });
  }

  // Exposed so a console or a future module can call them directly.
  window.scoutpostAnalytics = { onLegendFilter: onLegendFilter, onDeckSearch: onDeckSearch };
})();
