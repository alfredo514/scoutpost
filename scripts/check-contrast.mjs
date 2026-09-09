/**
 * Measure every text/surface pair in the palette against WCAG AA.
 *
 *   node scripts/check-contrast.mjs
 *
 * §13 records that the palette's contrast was measured rather than eyeballed,
 * and that --text-dim was lightened specifically because a first draft landed
 * at 4.39 on --surface. This is that check, made repeatable: run it after
 * changing any colour token, before believing the result looks fine.
 *
 * Reads the tokens straight out of public/styles.css, so it cannot drift from
 * what the site actually ships.
 */

import fs from 'node:fs';

const css = fs.readFileSync('public/styles.css', 'utf8');
const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));

const tokens = {};
for (const m of root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) tokens[m[1]] = m[2];

const hex = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3) s = [...s].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/* Every pair the site actually renders. Body copy and small labels must clear
 * 4.5:1; text at 24px+ or bold 19px+ may sit at 3:1, and those are marked
 * `large` so a pass is not claimed under the wrong rule. */
const surfaces = ['bg', 'surface', 'surface-2', 'surface-3'];
const inks = [
  ['text', 4.5],
  ['text-mid', 4.5],
  ['text-dim', 4.5],
  ['accent', 4.5],
  ['toxic', 4.5],
  ['pos', 4.5],
  ['neg', 4.5],
];

let fails = 0;
let tightest = { r: Infinity };
const rows = [];

for (const s of surfaces) {
  for (const [ink, min] of inks) {
    if (!tokens[s] || !tokens[ink]) continue;
    const r = ratio(tokens[ink], tokens[s]);
    const ok = r >= min;
    if (!ok) fails++;
    if (r < tightest.r) tightest = { r, pair: `${ink} on ${s}` };
    rows.push(`  ${ink.padEnd(9)} on ${s.padEnd(10)} ${r.toFixed(2).padStart(5)}  ${ok ? 'pass' : `FAIL (needs ${min})`}`);
  }
}

// Fills: text sits on the accent, not under it.
for (const fill of ['accent', 'toxic', 'neg']) {
  if (!tokens[fill] || !tokens.ink) continue;
  const r = ratio(tokens.ink, tokens[fill]);
  const ok = r >= 4.5;
  if (!ok) fails++;
  if (r < tightest.r) tightest = { r, pair: `ink on ${fill}` };
  rows.push(`  ${'ink'.padEnd(9)} on ${fill.padEnd(10)} ${r.toFixed(2).padStart(5)}  ${ok ? 'pass' : 'FAIL (needs 4.5)'}`);
}

console.log(rows.join('\n'));
console.log(`\ntightest pair: ${tightest.pair} at ${tightest.r.toFixed(2)}`);
console.log(fails ? `${fails} pair(s) BELOW AA` : 'all pairs pass WCAG AA');

/* ── The token audit ────────────────────────────────────────────────────────
 *
 * §13 records that there is not one literal colour, radius or shadow anywhere
 * outside :root, and that the audit proving it "lives in the session
 * scratchpad". A check that lives in a scratchpad is a check that has already
 * stopped running, so it lives here now.
 *
 * What it catches is drift: the header once painted itself the OLD background
 * as a literal and survived a whole retheme because nothing looked at it. */
const body = css.slice(css.indexOf('}', css.indexOf(':root')) + 1);
const lines = body.split(/\r?\n/);

const literals = [];
lines.forEach((line, i) => {
  const code = line.replace(/\/\*.*?\*\//g, '').split('/*')[0];
  if (!code.trim()) return;
  // rgba(var(--token), a) is the sanctioned way to get a translucent token.
  const stripped = code.replace(/rgba?\(\s*var\([^)]*\)[^)]*\)/g, '');
  if (/#[0-9a-fA-F]{3,8}\b/.test(stripped)) literals.push([i + 1, 'hex', code.trim()]);
  else if (/\brgba?\(\s*\d/.test(stripped)) literals.push([i + 1, 'rgb', code.trim()]);
  if (/border-radius:[^;]*\b\d+px/.test(code)) literals.push([i + 1, 'radius', code.trim()]);
});

console.log(`\ntoken audit — literals outside :root: ${literals.length}`);
literals.slice(0, 12).forEach(([n, kind, text]) =>
  console.log(`  line ${String(n).padStart(4)}  ${kind.padEnd(6)} ${text.slice(0, 84)}`),
);

/* And the spacing scale: every pad/gap/margin should come from --s1..--s7.
 * Values at or below .2rem are hairline nudges for icon alignment. */
const offScale = [];
for (const m of body.matchAll(/\b(padding|margin|gap|row-gap|column-gap)[a-z-]*:\s*([^;{}]+);/g)) {
  for (const tok of m[2].trim().split(/\s+/)) {
    const n = parseFloat(tok);
    if (/^-?[\d.]+rem$/.test(tok) && n > 0.2) offScale.push(`${m[1]}: ${tok}`);
  }
}
console.log(`spacing off the 8-point scale: ${offScale.length}`);
[...new Set(offScale)].slice(0, 10).forEach((v) => console.log(`  ${v}`));

const clean = fails === 0 && literals.length === 0 && offScale.length === 0;
console.log(clean ? '\ndesign system intact' : '\nsee above');
process.exit(clean ? 0 : 1);
