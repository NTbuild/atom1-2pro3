// Boot: URL flags, quality tier, WebGL2 or the CSS fallback, asset load, the fixed-step loop, and the
// wiring of the World to the view, the chrome and the input.

import { CONFIG } from './config.js';
import { seedFrom } from './rng.js';
import { World } from './sim.js';
import { MODE } from './spin.js';
import { createChrome } from './chrome.js';
import { InputController } from './input.js';

const HZ = CONFIG.sim.hz;
const TL = CONFIG.timeline;
const P = CONFIG.perf;

function readFlags(search) {
  const q = new URLSearchParams(search);
  const num = (key, fallback) => (q.has(key) && Number.isFinite(Number(q.get(key))) ? Number(q.get(key)) : fallback);
  return {
    debug: q.has('debug'),
    windArrows: q.get('debug') === 'wind',
    seed: seedFrom(q.get('seed'), CONFIG.seed),
    seekTo: q.has('t') ? num('t', 0) : null,
    paused: q.has('paused') || q.has('t'),
    rate: num('rate', 1),
    quality: q.get('quality'),
    reduced: q.has('reduced') ? q.get('reduced') !== '0' : matchMedia('(prefers-reduced-motion: reduce)').matches,
    felt: q.get('felt') === 'charcoal' ? 'charcoal' : 'green',
    dust: q.get('dust') === '1',          // motes only read against a dark table; off on the cream one
    live9: q.get('live9') === '1',
    size: q.has('w') && q.has('h') ? [num('w', 0), num('h', 0)] : null,
  };
}

// WebGL2 support and the largest texture, from a throwaway context.
function probeGL() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return null;
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { maxTexture };
}

function detectTier(flags, gl) {
  if (flags.quality === 'lite' || flags.quality === 'high') return flags.quality === 'lite' ? 'lite' : 'hi';
  const coarse = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < P.liteScreen;
  const weak = (navigator.hardwareConcurrency || 8) <= P.liteCores || (navigator.deviceMemory || 8) <= P.liteMemory;
  return coarse || weak || gl.maxTexture < P.liteTexture ? 'lite' : 'hi';
}

// Wall clock -> sim steps: a fixed 240 Hz step, at most 16 per frame (beyond that, time is dropped).
// Hurry mode speeds the deal up when someone tries to touch it before it is interactive.
class Clock {
  constructor(rate, paused) {
    this.rate = rate; this.paused = paused;
    this.acc = 0; this.scale = 1; this.hurrying = false;
  }
  hurry() { this.hurrying = true; }
  steps(dt, world) {
    if (this.hurrying && world.t >= world.interactiveAt) this.hurrying = false;
    const target = this.hurrying ? TL.hurryScale : 1;
    this.scale += (target - this.scale) * Math.min(1, dt / TL.hurryEase);
    if (this.paused) return 0;
    this.acc += dt * this.rate * this.scale;
    let n = Math.floor(this.acc * HZ);
    this.acc -= n / HZ;
    if (n > CONFIG.sim.maxStepsPerFrame) { n = CONFIG.sim.maxStepsPerFrame; this.acc = 0; }
    return n;
  }
}

// The card the fan is bringing to s = 0, once the closing gust has set the hand (always, under reduced motion).
function captionCard(world) {
  if (!world.reduced && !world.g.closingStarted) return null;
  const n = world.cards.length, L = world.leader.k;
  const c = world.cards[((Math.round(L.mode === MODE.idle ? L.phi : L.target) % n) + n) % n];
  return { rank: c.rank, title: c.title, sub: c.sub, accent: c.accent };
}

async function boot() {
  const flags = readFlags(location.search);
  const chrome = createChrome(document);
  const gl = probeGL();
  if (!gl) {
    const { showFallback } = await import('./fallback.js');
    const centre = await showFallback(document, { felt: flags.felt });
    chrome.setPowerOn(1);
    chrome.setCaption(centre);
    chrome.setPhase('idle');
    chrome.setReady();
    return;
  }
  const tier = detectTier(flags, gl);
  chrome.setTier(tier);

  const manifest = await (await fetch('data/cards.json')).json();
  const deck = manifest.ring.map((id) => ({ ...manifest.cards.find((c) => c.id === id) }));
  const { createView } = await import('./render/view.js');
  const canvas = document.getElementById('table');
  const screenEl = document.getElementById('screen');
  let world = null;
  const view = await createView({
    canvas, manifest, tier, reduced: flags.reduced, felt: flags.felt, seed: flags.seed,
    parallax: !flags.debug && !flags.reduced && matchMedia('(pointer: fine)').matches,
    liveVideo: !flags.reduced && (!flags.debug || flags.live9),
    fixedSize: flags.size,
    onVideoStart: (c) => world.emit('video-start', c),
  });

  world = new World({
    deck, seed: flags.seed, reduced: flags.reduced,
    dust: flags.dust, dustCount: tier === 'lite' ? CONFIG.dust.countLite : CONFIG.dust.count,
  });
  world.projector = view.screenProjector;

  const clock = new Clock(flags.rate, flags.paused);
  const input = new InputController(screenEl, world, view, {
    hurry: () => clock.hurry(),
    onPointer: (e) => {
      const r = view.rect;
      if (e.pointerType === 'mouse') view.setParallax(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
    },
  });

  let debug = null;
  if (flags.debug) {
    const { installDebug } = await import('./debug.js');
    debug = await installDebug({ world, view, clock, flags });
  }

  const present = (dt) => {
    chrome.setTime(world.t);
    chrome.setPowerOn(flags.reduced ? 1 : world.t / TL.powerOn[1]);
    chrome.setPhase(world.phase);
    chrome.setProgress(flags.reduced ? 1 : TL.loadShare + (1 - TL.loadShare) * Math.min(1, world.t / TL.loadedAt));
    chrome.setCaption(captionCard(world));
    view.render(world, dt);
  };

  // The deal starts once the cards are on the GPU, or after the timeout. Meanwhile the counter
  // climbs toward the share it gives the page load; the deal counts the rest.
  const loadStart = performance.now();
  const loadTick = setInterval(() => {
    chrome.setProgress(TL.loadShare * (1 - Math.exp(-(performance.now() - loadStart) / 700)));
  }, 50);
  const timeout = new Promise((resolve) => setTimeout(resolve, TL.readyTimeout * 1000));
  await Promise.race([view.cardsReady, timeout]);
  clearInterval(loadTick);
  if (flags.seekTo !== null) {
    if (debug) debug.seek(flags.seekTo);
    else world.step(Math.round(flags.seekTo * HZ));
  }
  present(0);
  chrome.setReady();
  debug?.markReady();

  let last = performance.now();
  document.addEventListener('visibilitychange', () => { last = performance.now(); });
  const frame = (now) => {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (!document.hidden) {
      const n = clock.steps(dt, world);
      const simStart = performance.now();
      for (let i = 0; i < n; i++) {
        input.sample();
        world.stepOnce();
        debug?.onStep();
      }
      const simMs = performance.now() - simStart;
      present(dt);
      debug?.onFrame();
      view.governor(dt * 1000, simMs);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
  document.documentElement.dataset.ready = 'error';
});
