#!/usr/bin/env node
/**
 * Generate the site's icon and social-preview images from one source artwork.
 *
 *   node scripts/make-icons.mjs path/to/artwork.jpg
 *
 * Outputs into public/:
 *   apple-touch-icon.png  180x180  home-screen icon on iOS
 *   icon-512.png          512x512  Android / PWA / general high-res
 *   og-image.png         1200x630  link previews in Slack, Discord, social
 *
 * The browser-tab icons come from here too. An earlier hand-drawn SVG favicon
 * was dropped once the real artwork existed: rendering it at 16/32/48 side by
 * side showed 32 is perfectly legible, and 32 is what modern browsers request.
 * One artwork everywhere beats two marks that drift apart.
 *
 * The source is expected to be the icon artwork sitting on a flat field. The
 * icon's bounds are detected rather than hardcoded, so a re-generated artwork
 * with different margins still crops correctly.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public');

/* This artwork is flat, vector-style colour, so a 256-colour palette costs
 * nothing visible and saves ~78% — icon-512 goes 478 KB to 107 KB. Verify by
 * eye after regenerating if the source ever becomes more photographic. */
const PNG_OPTS = { palette: true, quality: 92, effort: 10 };

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/make-icons.mjs <source-image>');
  process.exit(1);
}

/**
 * Locate the artwork by finding its neon glow.
 *
 * The obvious approach — sample the corner colour and take everything that
 * differs — does not work on this source. The field carries a vignette that is
 * brighter on the left (G≈49) than the right (G≈28), and that spread is larger
 * than the difference between the field and the icon's own dark panel. Any
 * threshold loose enough to catch the panel also catches the whole vignette.
 *
 * The acid-green glow has no such ambiguity: nothing else in frame is a
 * saturated green. Find its bounds, then pad outward to recover the panel
 * around it. On the current artwork this puts the left edge at x=239, which
 * matches the panel edge measured by hand at ~240.
 */
const GLOW_PAD = 1.12;

async function detectIcon(path) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const at = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };

  const corners = [at(2, 2), at(width - 3, 2), at(2, height - 3), at(width - 3, height - 3)];
  const bg = [0, 1, 2].map((c) =>
    Math.round(corners.reduce((a, p) => a + p[c], 0) / corners.length),
  );

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (!(g > 140 && g > r * 1.4 && g > b * 2)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('found no glow — is this the right artwork?');

  // Square, centred on the glow. The artwork is square, so a square crop keeps
  // every downstream resize distortion-free.
  const side = Math.min(
    Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * GLOW_PAD),
    Math.min(width, height),
  );
  const cx = minX + (maxX - minX + 1) / 2;
  const cy = minY + (maxY - minY + 1) / 2;
  const left = Math.max(0, Math.min(Math.round(cx - side / 2), width - side));
  const top = Math.max(0, Math.min(Math.round(cy - side / 2), height - side));

  return { left, top, side, bg, source: { width, height } };
}

const found = await detectIcon(src);
const bgHex = `#${found.bg.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
console.log(
  `source ${found.source.width}x${found.source.height}, field ${bgHex}, ` +
    `icon ${found.side}x${found.side} at ${found.left},${found.top}`,
);

await mkdir(OUT, { recursive: true });

const square = () =>
  sharp(src).extract({ left: found.left, top: found.top, width: found.side, height: found.side });

for (const size of [180, 512]) {
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  await square().resize(size, size, { fit: 'cover' }).png(PNG_OPTS).toFile(resolve(OUT, name));
  console.log(`  ${name}  ${size}x${size}`);
}

/* Browser-tab icons.
 *
 * 32 is the smallest size this artwork survives — at 16 it collapses into a
 * green smudge, verified by rendering all three magnified side by side. That
 * is fine in practice: 32 is what modern browsers ask for, and 16 is legacy.
 * 48 and 96 cover HiDPI, where a browser picks the largest it can use. */
for (const size of [32, 48, 96]) {
  await square()
    .resize(size, size, { fit: 'cover' })
    .png(PNG_OPTS)
    .toFile(resolve(OUT, `favicon-${size}.png`));
  console.log(`  favicon-${size}.png  ${size}x${size}`);
}

/* Link preview: 1200x630 is the size Slack, Discord and the rest crop to.
 * The icon sits left with the name beside it, on the same field colour as the
 * artwork so the card reads as one piece rather than a pasted-on logo. */
const OG_W = 1200;
const OG_H = 630;
const ART = 440;

const icon = await square().resize(ART, ART).png().toBuffer();

/* Keep every line inside x=620..1150. There is no text measurement here, so the
 * sizes below are chosen to leave slack rather than to fill the space — an
 * overflowing line is silently clipped, which is worse than one a little small.
 * Re-check the output image after changing any of this copy. */
const text = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}">
     <text x="620" y="282" font-family="Segoe UI, Helvetica, Arial, sans-serif"
           font-size="80" font-weight="700" fill="#e8f6ea">Scoutpost</text>
     <text x="622" y="338" font-family="Segoe UI, Helvetica, Arial, sans-serif"
           font-size="28" fill="#A3E635">Top 8s with the build cost attached.</text>
     <text x="622" y="384" font-family="Segoe UI, Helvetica, Arial, sans-serif"
           font-size="24" fill="#a3bfab">Priced daily against TCGplayer.</text>
   </svg>`,
);

await sharp({
  create: { width: OG_W, height: OG_H, channels: 4, background: bgHex },
})
  .composite([
    { input: icon, left: 96, top: Math.round((OG_H - ART) / 2) },
    { input: text, left: 0, top: 0 },
  ])
  .png(PNG_OPTS)
  .toFile(resolve(OUT, 'og-image.png'));

console.log(`  og-image.png  ${OG_W}x${OG_H}`);
