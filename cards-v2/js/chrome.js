// Page chrome around the table: the Amsterdam clock, the caption crossfade, the page fade-in and the
// <html> state. The API matches what main.js drives.
import { CONFIG } from './config.js';

const C = CONFIG.chrome;

export function createChrome(root) {
  const html = root.documentElement;
  const screen = root.getElementById('screen');
  const caption = root.getElementById('caption');
  const capParts = ['rank', 'title', 'sub'].map((name) => caption.querySelector(`.${name}`));

  // ?reduced=1|0 overrides the media query, as it does for the sim.
  const flags = new URLSearchParams(root.defaultView.location.search);
  const reduced = flags.has('reduced')
    ? flags.get('reduced') !== '0'
    : root.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const frozen = flags.has('nofx');
  html.classList.toggle('reduced', reduced);

  // Wall clock, as in the footer of the reference.
  const clock = root.getElementById('clock');
  if (clock) {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: C.clockZone, hour: '2-digit', minute: '2-digit', hour12: false });
    const tick = () => { clock.textContent = fmt.format(new Date()); };
    tick();
    root.defaultView.setInterval(tick, C.clockEveryMs);
  }

  let shown = null;
  let power = -1;
  const pctEl = root.getElementById('pct');
  let pct = -1;
  let loaded = false;

  function fade(el, from, to) {
    if (frozen) return null;
    return el.animate([{ opacity: from }, { opacity: to }], { duration: C.captionFadeMs, easing: 'ease-out' });
  }

  return {
    setTime() {},

    setCaption(card) {
      const key = card ? `${card.rank}|${card.title}` : null;
      if (key === shown) return;
      shown = key;
      // The outgoing text fades on a detached copy while the new text fades in underneath it.
      if (!caption.classList.contains('is-empty')) {
        const ghost = root.createElement('div');
        ghost.className = 'caption-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        ghost.append(...capParts.map((el) => el.cloneNode(true)));
        caption.append(ghost);
        const anim = fade(ghost, 1, 0);
        if (anim) anim.finished.then(() => ghost.remove(), () => ghost.remove());
        else ghost.remove();
      }
      caption.classList.toggle('is-empty', !card);
      const text = card ? [card.rank, card.title, card.sub] : ['', '', ''];
      capParts.forEach((el, i) => {
        el.textContent = text[i];
        if (card) fade(el, 0, 1);
      });
    },

    // 0..1 over the opening beat: the table fades up from the cream page.
    setPowerOn(k) {
      const p = Math.min(1, Math.max(0, k));
      if (p === power) return;
      power = p;
      screen.style.setProperty('--power', (1 - (1 - p) ** 2).toFixed(4));
    },

    // Loading counter, 0..1. It only ever climbs, and the hero settles into its panel at 100 %.
    setProgress(p) {
      if (loaded) return;
      const v = Math.min(100, Math.max(pct, Math.floor(p * 100)));
      if (v === pct) return;
      pct = v;
      if (pctEl) pctEl.textContent = String(v);
      if (v >= 100) {
        loaded = true;
        html.classList.add('loaded');
      }
    },

    setPhase(phase) {
      html.dataset.phase = phase;
    },

    setReady() {
      html.dataset.ready = '1';
    },

    setTier(tier) {
      html.classList.toggle('lite', tier === 'lite');
    },

    onBW() {},
  };
}
