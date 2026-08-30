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

  var ENHANCEMENTS = [enhanceDeckExport];

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
