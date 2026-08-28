#!/usr/bin/env node
/**
 * Cut a domain icon for each colour out of that domain's Rune card.
 *
 *   node scripts/make-domain-icons.mjs
 *
 * Riftscribe publishes no icon assets — a card carries only `faction: "fury"`
 * and `domains: ["Fury"]` as text. But every domain has a Rune card whose art
 * IS its symbol: a large light glyph, centred, on the domain's own colour. So
 * the icons are cut from the real cards rather than drawn from imagination,
 * which matters — a player already knows these symbols, and an invented glyph
 * would be worse than none.
 *
 * Writes public/domain-<faction>.png (64px). The icons carry each domain's own
 * colour, so nothing else needs tinting.
 *
 * Colourless has no Rune card and therefore no icon; its chip stays text-only.
 *
 * Re-run after a set introduces new art. Output is deterministic.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public');
const UA = { 'User-Agent': 'Scoutpost/1.0 (softsauce.co/scoutpost)' };

/** Rune card art per domain, from the catalogue. */
const RUNES = {
  body: 'ogn-126-298-81aa9af0b356e2f8',
  calm: 'ogn-042-298-c134ca519b13627e',
  chaos: 'ogn-166-298-b544b8deb6333fd3',
  fury: 'ogn-007-298-868b5cd63536371d',
  mind: 'ogn-089-298-9f906f6d7e0d957f',
  order: 'ogn-214-298-dc37e3e8a6f6c946',
};

const SIZE = 64;

/**
 * Find the glyph by looking for near-white pixels inside the art window.
 *
 * The window matters more than the threshold. A Riftbound card has a light
 * frame around its whole edge and a near-white title band below the art, and
 * both are as bright as the glyph — searching the full card returns the full
 * card, which is exactly what the first attempt did. So the search is inset
 * past the frame on all sides and stops above the title band.
 */
async function glyphBox(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const x0 = Math.floor(width * 0.14);
  const x1 = Math.floor(width * 0.86);
  const y0 = Math.floor(height * 0.11);
  const y1 = Math.floor(height * 0.56);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      if (data[i] < 205 || data[i + 1] < 195 || data[i + 2] < 180) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('no glyph found');

  // Square, centred, with room around it so the symbol is not cropped tight
  // against the edge of the icon.
  const side = Math.min(Math.round(Math.max(maxX - minX, maxY - minY) * 1.28), Math.min(width, height));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    left: Math.max(0, Math.min(Math.round(cx - side / 2), width - side)),
    top: Math.max(0, Math.min(Math.round(cy - side / 2), height - side)),
    side,
  };
}

for (const [faction, file] of Object.entries(RUNES)) {
  const res = await fetch(`https://cdn.riftscribe.gg/cards/thumbnails/large/${file}.webp`, {
    headers: UA,
  });
  if (!res.ok) throw new Error(`${faction}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const box = await glyphBox(buf);
  const icon = sharp(buf).extract({
    left: box.left,
    top: box.top,
    width: box.side,
    height: box.side,
  });

  await icon
    .clone()
    .resize(SIZE, SIZE)
    .png({ palette: true, quality: 92, effort: 10 })
    .toFile(resolve(OUT, `domain-${faction}.png`));

  console.log(`domain-${faction}.png  ${SIZE}x${SIZE}  from a ${box.side}px crop`);
}

console.log(`\n${Object.keys(RUNES).length} icons written to public/`);
