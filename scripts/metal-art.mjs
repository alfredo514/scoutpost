/**
 * Generate the SQL that gives Metal prize cards their borrowed art.
 *
 *   node scripts/metal-art.mjs --local     # against the local database
 *   node scripts/metal-art.mjs --remote    # against production
 *
 * Writes build/metal-art.sql and prints the mapping for review. It does NOT
 * apply anything — read the mapping first, then:
 *
 *   npx wrangler d1 execute scoutpost --remote --file=build/metal-art.sql -y
 *
 * The catalog job does this automatically every night (ingest/src/catalog.js).
 * This script exists for the first backfill and for re-checking the mapping by
 * hand, because a wrong picture here would be wrong quietly — see §5, and the
 * long comment in ingest/src/metal-art.js about which printings a name can
 * match.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { METAL_ART_SQL, isMetalName, resolveMetalArt } from '../ingest/src/metal-art.js';

const remote = process.argv.includes('--remote');
const flag = remote ? '--remote' : '--local';

const sql =
  'SELECT id, name, variant, rarity, public_code, collector_number, image_large_url FROM cards';
// shell:true is needed for npx on Windows, and it means the SQL has to carry
// its own quotes or the shell splits it on the commas.
const raw = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'scoutpost', flag, '--json', '--command', `"${sql}"`],
  { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 },
);

// wrangler prints a banner before the JSON; take from the first bracket.
const cards = JSON.parse(raw.slice(raw.indexOf('[')))[0].results;
console.log(`${flag}: ${cards.length} cards`);

const { pairs, unmatched, ambiguous } = resolveMetalArt(cards);
const metal = cards.filter((c) => isMetalName(c.name));
const blank = metal.filter((c) => !c.image_large_url);
const blankIds = new Set(blank.map((c) => c.id));
const byId = new Map(cards.map((c) => [c.id, c]));

console.log(`metal cards ${metal.length}, of which blank ${blank.length}`);
console.log(`resolved ${pairs.length} · unmatched ${unmatched.length} · ambiguous ${ambiguous.length}`);
console.log(`blank cards covered: ${pairs.filter((p) => blankIds.has(p.metalId)).length}/${blank.length}`);

if (unmatched.length) {
  console.log('\nUNMATCHED (left blank):');
  unmatched.forEach((u) => console.log(`  ${u}`));
}
if (ambiguous.length) {
  console.log('\nAMBIGUOUS (left blank rather than guessed):');
  ambiguous.forEach((a) => console.log(`  ${a}`));
}

// Every pick must be a base printing. Re-checked here rather than trusted,
// because this is the failure §5 is about.
const suspect = pairs.filter((p) => {
  const s = byId.get(p.sourceId);
  const size = /\/(\d+)$/.exec(s.public_code ?? '');
  return (
    (size && Number(s.collector_number) > Number(size[1])) ||
    String(s.public_code ?? '').includes('*') ||
    s.variant ||
    /showcase|signature/i.test(s.rarity ?? '')
  );
});
console.log(`\npicks that are secret rares / signatures / variants: ${suspect.length}`);
suspect.forEach((p) => console.log(`  !! ${p.metalName} -> ${byId.get(p.sourceId).public_code}`));

console.log('\nMAPPING:');
for (const p of pairs) {
  const mark = blankIds.has(p.metalId) ? 'fill' : 'skip';
  console.log(
    `  ${mark}  ${p.metalName.padEnd(52)} -> ${(byId.get(p.sourceId).public_code ?? p.sourceId).padEnd(14)} ${p.sourceName}`,
  );
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const statements = pairs.map((p) => {
  let i = 0;
  const binds = [p.sourceId, p.sourceId, p.sourceId, p.sourceId, p.metalId];
  return METAL_ART_SQL.replace(/\?/g, () => q(binds[i++]));
});

fs.mkdirSync('build', { recursive: true });
const out = path.join('build', 'metal-art.sql');
fs.writeFileSync(out, `${statements.join(';\n')};\n`);
console.log(`\nwrote ${out} (${statements.length} statements)`);
console.log(`apply with:\n  npx wrangler d1 execute scoutpost ${flag} --file=${out} -y`);
