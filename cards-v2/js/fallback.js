// Static stand-in when WebGL2 is missing (spec §2): the idle hand (fan offset phi = 3, so
// 10 J Q K A with the Q centred) as a CSS fan of the 640 px fronts on the felt, inside .screen.
import { CONFIG } from './config.js';

const F = CONFIG.fallback;

// Resolves with the centre card ({rank, title, sub, accent}) so the caller can caption it.
export async function showFallback(root, { felt = 'green' } = {}) {
  const res = await fetch('data/cards.json');
  if (!res.ok) throw new Error(`fallback: data/cards.json (${res.status})`);
  const manifest = await res.json();
  const byId = new Map(manifest.cards.map((c) => [c.id, c]));
  const n = manifest.ring.length;

  const box = root.getElementById('fallback');
  box.className = 'fallback';
  box.setAttribute('aria-label', 'Polaroids');
  // Absolute, because a url() inside a custom property resolves against the stylesheet that uses it.
  const tile = new URL(`assets/table/lo/felt-${felt === 'charcoal' ? 'charcoal' : 'green'}-512.jpg`, root.baseURI);
  box.style.setProperty('--felt-tile', `url("${tile.href}")`);
  box.style.setProperty('--felt-tile-size', `${F.feltTileVh}vh`);
  box.style.setProperty('--card-w', `min(${F.cardVh}vh, ${F.cardVw}vw)`);
  box.style.setProperty('--fan-deg', `${F.spacingDeg}deg`);
  box.style.setProperty('--fan-pivot', `calc(var(--card-w) * ${F.pivotCardWidths})`);
  box.style.setProperty('--fan-drop', `${F.dropPerSlot2Vh}vh`);
  box.style.setProperty('--fan-bottom', `${F.bottomPct}%`);

  let centre = null;
  const cards = manifest.ring.map((id, i) => {
    const s = ((((i - F.phi) % n) + n + n / 2) % n) - n / 2; // wrapped into [-n/2, n/2)
    if (Math.abs(s) > F.maxSlot) return null;
    const card = byId.get(id);
    if (s === 0) centre = card;
    const el = root.createElement('div');
    el.className = 'fallback-card';
    el.style.setProperty('--s', String(s));
    el.style.zIndex = String(10 + s); // each card lies over its left neighbour
    const img = root.createElement('img');
    img.src = card.files.lo.front;
    img.alt = `${card.rank} · ${card.title}`;
    img.decoding = 'async';
    img.draggable = false;
    el.append(img);
    return el;
  });
  box.replaceChildren(...cards.filter(Boolean));
  root.getElementById('screen').append(box);
  box.hidden = false;
  await Promise.all([...box.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
  return centre && { rank: centre.rank, title: centre.title, sub: centre.sub, accent: centre.accent };
}
