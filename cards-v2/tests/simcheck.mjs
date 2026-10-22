// Headless §15 motion checks in Node (no browser): criteria 1-6 (deal) and 6-11 (closing, idle, spin, wrap)
// for a seed sweep, on the real card manifest. The same code runs in the page as window.__deal.verify().
//
//   node cards/tests/simcheck.mjs                 seeds 1-20 at the 1440 x 900 screen (1371 x 853)
//   node cards/tests/simcheck.mjs seeds=7331,1-5  w=366 h=800  deal-only
//
// Exits non-zero when any check fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { verifyDeal, verifySpin } = await import(path.join(root, 'js/debug.js'));
const { fitCamera, projector } = await import(path.join(root, 'js/fan.js'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => (a.includes('=') ? a.split('=') : [a, true])));
const seeds = String(args.seeds || '1-20').split(',').flatMap((part) => {
  const [a, b] = part.split('-').map(Number);
  return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
});
const W = Number(args.w || 1371), H = Number(args.h || 853);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data/cards.json'), 'utf8'));
const deck = manifest.ring.map((id) => manifest.cards.find((c) => c.id === id));
const proj = projector(fitCamera(W / H), W, H);

let failed = 0;
for (const seed of seeds) {
  const opts = { deck, seed, dust: false };
  const deal = verifyDeal(opts, proj);
  const spin = args['deal-only'] ? { failures: [] } : verifySpin(opts, proj);
  const failures = [...deal.failures, ...spin.failures];
  if (failures.length) failed++;
  console.log(`seed ${seed}: ${failures.length ? 'FAIL' : 'ok'}`);
  for (const f of failures) console.log(`  ${f}`);
}
console.log(`${seeds.length - failed}/${seeds.length} seeds pass (${W} x ${H})`);
process.exit(failed ? 1 : 0);
