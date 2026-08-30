/* Scoutpost — progressive enhancement.
 *
 * This is the first script on the site, added 2026-08-29. The rule it replaces
 * was "no JavaScript"; the rule it replaces it with is stricter in the way that
 * matters:
 *
 *     NOTHING ON THIS SITE MAY REQUIRE JAVASCRIPT.
 *
 * Every filter is still a link. Every search is still a GET form. Every page
 * still renders completely and correctly with this file blocked, missing, or
 * throwing. What script may do is make something that already works nicer — it
 * may not be the only way to reach anything.
 *
 * Three rules that follow from that, and are worth keeping:
 *
 *   1. **Never render an affordance the server cannot back.** A Copy button
 *      that only works with script must be CREATED by script, not printed by
 *      the server and left dead for anyone without it. That is why the button
 *      below is injected rather than rendered in deck-detail.js.
 *   2. **Feature-detect, then enhance.** No clipboard API, no button — and the
 *      plain-text list is still there to select by hand.
 *   3. **Fail silently.** Everything runs inside try/catch. A bug here must
 *      cost a convenience, never a page.
 *
 * No framework, no build step, no bundler. The file is served from public/ with
 * `must-revalidate` and an ETag, so a deploy invalidates it immediately and
 * there is no cache-busting to maintain.
 */

(function () {
  'use strict';

  var COPY_IDLE = 'Copy decklist';
  var RESET_MS = 2500;

  /* ─────────────────────────── The collection ───────────────────────────
   *
   * Which cards the reader owns, in localStorage. This is the one feature on
   * the site that genuinely cannot be server-rendered: it is per-person, and
   * Scoutpost has no accounts and wants none (§8).
   *
   * It is deliberately a plain array of card ids and nothing else. No
   * quantities, no condition, no acquisition price — "I have the copies this
   * deck needs" is the question a build cost actually turns on, and every
   * extra field is a migration waiting to happen.
   *
   * Every access is wrapped: localStorage throws outright in some privacy
   * modes rather than being merely empty, and a deck page must not die because
   * a browser refused to remember something.
   */
  var STORE_KEY = 'scoutpost:owned:v1';

  function readOwned() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      var list = JSON.parse(raw);
      if (!Array.isArray(list)) return {};
      var map = {};
      for (var i = 0; i < list.length; i++) map[list[i]] = true;
      return map;
    } catch (e) {
      return {};
    }
  }

  function writeOwned(map) {
    try {
      var list = [];
      for (var id in map) if (map[id]) list.push(id);
      window.localStorage.setItem(STORE_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      // Quota, or storage disabled. The toggles still work for this page view;
      // they simply will not be remembered, which is better than an error.
      return false;
    }
  }

  /** Is storage usable at all? If not, the feature is not offered. */
  function storageWorks() {
    try {
      var k = STORE_KEY + ':probe';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /** A small pressed-state toggle. Created here, never rendered by the server. */
  function ownToggle(label, pressed) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'own-toggle';
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  }

  /**
   * Adds a Copy button to the decklist's plain-text block.
   *
   * The text itself is rendered by the server into `.deck-export-text`, so this
   * never has to scrape the table — the format lives in one testable place and
   * survives any change to the markup.
   */
  function enhanceDeckExport() {
    var wrap = document.querySelector('.deck-export-wrap');
    if (!wrap) return;

    var pre = wrap.querySelector('.deck-export-text');
    if (!pre) return;

    // Secure-context API. Absent on http:// and in some embedded views, in
    // which case the disclosure below is still perfectly usable by hand.
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-copy';
    btn.textContent = COPY_IDLE;
    // The label is the only feedback, so it has to reach a screen reader too.
    btn.setAttribute('aria-live', 'polite');

    var timer = null;
    function reset() {
      btn.textContent = COPY_IDLE;
      btn.classList.remove('is-done');
    }

    btn.addEventListener('click', function () {
      window.clearTimeout(timer);
      navigator.clipboard.writeText(pre.textContent).then(
        function () {
          btn.textContent = 'Copied';
          btn.classList.add('is-done');
          timer = window.setTimeout(reset, RESET_MS);
        },
        function () {
          // Permission denied, or a browser that refuses outside a gesture it
          // recognises. Open the list and select it so the manual path is one
          // keystroke rather than a dead end.
          btn.textContent = 'Select and copy';
          var details = wrap.querySelector('.deck-export');
          if (details) details.open = true;
          try {
            var range = document.createRange();
            range.selectNodeContents(pre);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          } catch (e) {
            /* selection is a nicety; the text is on screen either way */
          }
          timer = window.setTimeout(reset, RESET_MS * 2);
        },
      );
    });

    wrap.appendChild(btn);
  }

  /**
   * Collection tracking on a decklist.
   *
   * Marks rows the reader owns and shows what the deck still costs THEM, which
   * is the number they actually care about on a site whose headline is build
   * cost. Retail stays on screen next to it — the point is the comparison.
   *
   * Reads `data-line` off each row rather than parsing the rendered "$12.34".
   * A script that parses its own page's formatting breaks the first time the
   * formatting changes, and here it would break silently, inside a total.
   */
  function enhanceDeckCollection() {
    var table = document.querySelector('.deck-list .data-table');
    var summary = document.querySelector('[data-deck-summary]');
    if (!table || !summary || !storageWorks()) return;

    var rows = table.querySelectorAll('tr[data-card]');
    if (!rows.length) return;

    var owned = readOwned();

    var card = document.createElement('div');
    card.className = 'summary summary-own';
    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Your cost';
    var value = document.createElement('b');
    var note = document.createElement('span');
    note.className = 'summary-own-note';
    card.appendChild(label);
    card.appendChild(value);
    card.appendChild(note);
    summary.appendChild(card);

    function recount() {
      var toBuy = 0;
      var ownedCount = 0;
      for (var i = 0; i < rows.length; i++) {
        var id = rows[i].getAttribute('data-card');
        var line = parseFloat(rows[i].getAttribute('data-line'));
        if (owned[id]) {
          ownedCount++;
        } else if (!isNaN(line)) {
          toBuy += line;
        }
      }
      value.textContent = money(toBuy);
      note.textContent = ownedCount
        ? 'you own ' + ownedCount + ' of ' + rows.length
        : 'mark what you own';
      card.classList.toggle('is-active', ownedCount > 0);
    }

    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var id = row.getAttribute('data-card');
        var cell = row.querySelector('td[data-label="Card"]');
        if (!cell) return;
        var name = row.querySelector('.card-name');
        var btn = ownToggle('I own ' + (name ? name.textContent : 'this card'), !!owned[id]);

        btn.addEventListener('click', function () {
          owned[id] = !owned[id];
          btn.setAttribute('aria-pressed', owned[id] ? 'true' : 'false');
          row.classList.toggle('is-owned', !!owned[id]);
          writeOwned(owned);
          recount();
        });

        cell.classList.add('has-own-toggle');
        cell.insertBefore(btn, cell.firstChild);
        if (owned[id]) row.classList.add('is-owned');
      })(rows[i]);
    }

    recount();
  }

  /** The same toggle on a card's own page, so one card can be marked in place. */
  function enhanceCardCollection() {
    var row = document.querySelector('.card-price-row[data-card]');
    if (!row || !storageWorks()) return;

    var id = row.getAttribute('data-card');
    var owned = readOwned();

    var box = document.createElement('div');
    box.className = 'summary summary-own';
    var btn = ownToggle('I own this card', !!owned[id]);
    var text = document.createElement('span');
    text.className = 'label';

    function paint() {
      text.textContent = owned[id] ? 'In your collection' : 'Mark as owned';
      box.classList.toggle('is-active', !!owned[id]);
    }

    btn.addEventListener('click', function () {
      owned[id] = !owned[id];
      btn.setAttribute('aria-pressed', owned[id] ? 'true' : 'false');
      writeOwned(owned);
      paint();
    });

    paint();
    box.appendChild(btn);
    box.appendChild(text);
    row.appendChild(box);
  }

  /**
   * Clips a long board to its first N rows and offers the rest in steps.
   *
   * Note the direction: the server renders every row and this REMOVES some.
   * Doing it the other way — hiding rows in CSS and revealing them with script
   * — would hide content from anyone without script and from crawlers, which
   * on a data site is the content itself. The class that does the hiding is
   * added here, so no script means no hiding.
   *
   * Not pagination. There is no round trip and no URL: the rows are already on
   * the page, and §23's rule about pagination staying link-based is about
   * fetching more, which this never does.
   */
  function enhanceBoardClipping() {
    var tables = document.querySelectorAll('table[data-clip]');

    for (var t = 0; t < tables.length; t++) {
      (function (table) {
        var initial = parseInt(table.getAttribute('data-clip'), 10);
        var step = parseInt(table.getAttribute('data-clip-step'), 10) || initial;
        var rows = table.querySelectorAll('tbody tr');
        if (!initial || rows.length <= initial) return;

        var shown = initial;

        var wrap = document.createElement('div');
        wrap.className = 'board-more';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        var status = document.createElement('span');
        status.className = 'board-more-count';
        // Politely, not assertively: the reader pressed the button, so they
        // know something happened; this is for anyone who cannot see it.
        status.setAttribute('aria-live', 'polite');
        wrap.appendChild(btn);
        wrap.appendChild(status);

        function paint() {
          for (var i = 0; i < rows.length; i++) {
            rows[i].classList.toggle('is-clipped', i >= shown);
          }
          status.textContent = 'Showing ' + shown + ' of ' + rows.length;
          if (shown >= rows.length) {
            btn.remove();
          } else {
            btn.textContent = 'Show ' + Math.min(step, rows.length - shown) + ' more';
          }
        }

        btn.addEventListener('click', function () {
          shown = Math.min(shown + step, rows.length);
          paint();
          if (shown >= rows.length) status.focus && status.focus();
        });

        paint();
        var host = table.closest('.table-wrap') || table.parentNode;
        host.parentNode.insertBefore(wrap, host.nextSibling);
      })(tables[t]);
    }
  }

  var ENHANCEMENTS = [
    enhanceDeckExport,
    enhanceDeckCollection,
    enhanceCardCollection,
    enhanceBoardClipping,
  ];

  function run() {
    for (var i = 0; i < ENHANCEMENTS.length; i++) {
      // Each enhancement is isolated: one throwing must not stop the others,
      // and none of them may take the page down.
      try {
        ENHANCEMENTS[i]();
      } catch (e) {
        if (window.console && console.warn) console.warn('[scoutpost] enhancement failed', e);
      }
    }
  }

  // `defer` already guarantees the document is parsed, but this file is served
  // from public/ and could be pulled in some other way later.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
