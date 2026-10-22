// The renderer: camera fit and parallax, resize and dynamic resolution, painter's order, World state
// copied onto the card meshes, lamp-projected shadows (table decals and card-on-card occluders), dust,
// and the 9's live video window.

import * as THREE from '../../vendor/three.module.min.js';
import { CONFIG } from '../config.js';
import { DEG, clamp, cardBasis, quatFromBasis, cardPoint } from '../math.js';
import { fitCamera, riseCamera, projector, slotPx, ndcToPlane } from '../fan.js';
import { surfaceD } from '../contact.js';
import { createTable } from './table.js';
import { createCardMesh } from './cardMesh.js';
import { createDustPoints } from './dust.js';
import { createVortex } from './vortex.js';

const R = CONFIG.render;
const P = CONFIG.perf;
const CAM = CONFIG.camera;
const HW = CONFIG.card.w / 2, HH = CONFIG.card.h / 2, HT = CONFIG.card.thick / 2;
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

async function bitmap(url, flip) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`view: ${url} (${res.status})`);
  return createImageBitmap(await res.blob(), {
    imageOrientation: flip ? 'flipY' : 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
}

function texture(renderer, bmp, srgb, repeat) {
  const tex = new THREE.Texture(bmp);
  tex.flipY = false;          // flipped at decode; WebGL ignores UNPACK_FLIP_Y for ImageBitmap
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = Math.min(R.anisotropy, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

// RGBA pixels of an image, top row first (for tracing the silhouette on the CPU).
function pixels(bmp) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

export async function createView({ canvas, manifest, tier, reduced, felt, seed, parallax, liveVideo, fixedSize, onVideoStart }) {
  const lite = tier === 'lite';
  const dprCap = lite ? P.dpr.lite : P.dpr.hi;
  let dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: dpr < 1.5, powerPreference: 'high-performance', alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = R.exposure;
  renderer.setClearColor(R.clear);
  renderer.setPixelRatio(dpr);
  renderer.sortObjects = true;

  const vortex = createVortex(THREE, renderer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAM.fovDeg, 1, CAM.near, CAM.far);
  const table = await createTable(THREE, { renderer, scene, tier, seed, reduced, count: manifest.ring.length });

  // ---- cards: loaded after the table, so the surface can be lit while they arrive ----
  const res = lite ? 'lo' : 'hi';
  const ring = manifest.ring.map((id) => manifest.cards.find((c) => c.id === id));
  const nine = manifest.ring.indexOf('9');
  const v9 = manifest.video9;
  const videoEl = liveVideo && v9 ? Object.assign(document.createElement('video'), { muted: true, loop: true, playsInline: true, preload: 'auto', src: v9.file }) : null;
  if (videoEl) {
    // In the document (but invisible) so it keeps decoding and tests can find it.
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('aria-hidden', 'true');
    videoEl.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(videoEl);
  }
  const videoTex = videoEl ? new THREE.VideoTexture(videoEl) : null;
  if (videoTex) videoTex.colorSpace = THREE.SRGBColorSpace;
  let cards = [];

  async function loadCards() {
    const [backBmp, dimpleBmp] = await Promise.all([bitmap(manifest.back[res], true), bitmap(manifest.dimple, true)]);
    const backTex = texture(renderer, backBmp, true, false);
    const dimpleTex = texture(renderer, dimpleBmp, false, true);
    const loaded = await Promise.all(ring.map(async (card, i) => {
      const f = card.files[res];
      const [front, wear, gloss, wearRaw] = await Promise.all([bitmap(f.front, true), bitmap(f.wear, true), bitmap(f.gloss, true), bitmap(f.wear, false)]);
      const tex = {
        front: texture(renderer, front, true, false), wear: texture(renderer, wear, false, false),
        gloss: texture(renderer, gloss, false, false), back: backTex, dimple: dimpleTex,
        dimpleTileCm: manifest.dimpleTileCm, wearPixels: pixels(wearRaw),
      };
      wearRaw.close();
      const video = videoTex && i === nine ? { texture: videoTex, windowUV: v9.windowUV } : null;
      const mesh = createCardMesh(THREE, { card, tex, lite, envMap: table.envMap, video });
      for (const t of [tex.front, tex.wear, tex.gloss]) renderer.initTexture(t);
      return { card, mesh, tex };
    }));
    renderer.initTexture(backTex); renderer.initTexture(dimpleTex);
    for (const c of loaded) scene.add(c.mesh.group);
    // Compile every card program now, not at the first throw.
    await renderer.compileAsync(scene, camera);
    cards = loaded;
    order.length = 0;
    cards.forEach((_, i) => order.push(i));
  }
  const cardsReady = loadCards();

  // ---- dust ----
  let dust = null;

  // ---- layout ----
  let width = 1, height = 1, rect = { left: 0, top: 0, width: 1, height: 1 };
  let baseCam = fitCamera(16 / 10);
  let cam = baseCam;
  let proj = projector(cam, 1, 1);
  let baseProj = proj;
  let spx = 1;
  let rise = 0;
  const orbit = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };

  function applyCamera() {
    camera.fov = cam.fovDeg;
    camera.aspect = cam.aspect;
    camera.position.set(...cam.eye);
    camera.up.set(0, 1, 0);
    camera.lookAt(...cam.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  // Camera for the current rise and parallax; drag maps through the risen view too.
  function placeCamera() {
    cam = riseCamera(baseCam, rise, orbit.x, orbit.y);
    proj = projector(cam, width, height);
    baseProj = projector(riseCamera(baseCam, rise), width, height);
    spx = slotPx(baseProj);
    applyCamera();
  }

  function setRise(t) {
    const R = CAM.rise;
    const x = reduced ? 1 : Math.min(1, Math.max(0, (t - R.start) / R.duration));
    const k = x * x * x * (x * (6 * x - 15) + 10);   // smootherstep: leaves and lands without a kick
    if (k === rise) return;
    rise = k;
    placeCamera();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    width = Math.max(1, Math.round(fixedSize ? fixedSize[0] : r.width));
    height = Math.max(1, Math.round(fixedSize ? fixedSize[1] : r.height));
    if (fixedSize) { canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    vortex.setSize(width, height, dpr);
    baseCam = fitCamera(width / height);
    placeCamera();
    table.layout();
    // setSize clears the canvas; redraw now so the browser never paints an empty frame between
    // a resize (the panel settling, a resolution step) and the next animation frame.
    vortex.render(scene, camera, performance.now() / 1000);
  }
  resize();
  new ResizeObserver(resize).observe(canvas);

  // ---- dynamic resolution ----
  const perf = { ema: 16, slowFor: 0, times: new Float32Array(P.frameWindow), sim: new Float32Array(P.frameWindow), n: 0, frames: 0 };
  // ms: the frame interval; simMs: time spent stepping the World in that frame.
  function governor(ms, simMs) {
    perf.ema = P.emaKeep * perf.ema + (1 - P.emaKeep) * ms;
    perf.sim[perf.n % perf.sim.length] = simMs;
    perf.times[perf.n++ % perf.times.length] = ms;
    perf.frames++;
    const s = ms / 1000;
    perf.slowFor = perf.ema > P.slowMs ? perf.slowFor + s : 0;
    if (perf.slowFor > P.slowHold && dpr > P.dpr.floor) { dpr = Math.max(P.dpr.floor, dpr - P.dpr.step); perf.slowFor = 0; resize(); }
    // Resolution only ever steps down: stepping back up made it oscillate on slower GPUs.
  }

  // ---- per-frame scratch ----
  const basis = new Float64Array(9), q = [0, 0, 0, 1], pt = new Float64Array(3);
  const shadows = ring.map(() => ({ corners: new Float32Array(12), height: 0, contact: 0 }));
  const shadowList = ring.map(() => null);
  const footprints = ring.map(() => new Float64Array(12));    // world corners (underside)
  const order = [];
  const lampTarget = new THREE.Vector3();
  let videoLive = false, videoStarted = false;

  function cardCorners(k, out) {
    cardBasis(k.yaw, k.pitch, k.roll, k.beta, basis);
    CORNERS.forEach(([sx, sz], j) => {
      const x = sx * HW, z = sz * HH;
      cardPoint(basis, k.px, k.py, k.pz, x, surfaceD(x, z, k.curlL, k.curlT, k.twist) - HT, z, out, 3 * j);
    });
    return out;
  }

  // Lamp-projected quad of card j's corners onto the horizontal plane y = h (card-on-card shadow).
  function occluderQuad(j, h, out) {
    const lp = table.lamp.pos, c = footprints[j];
    for (let n = 0; n < 4; n++) {
      const x = c[3 * n], y = c[3 * n + 1], z = c[3 * n + 2];
      const f = (lp.y - h) / Math.max(lp.y - y, 1e-3);
      out[n].set(lp.x + (x - lp.x) * f, lp.z + (z - lp.z) * f);
    }
  }

  function updateCards(world) {
    const ks = world.cards.map((c) => c.k);
    // Painter's order: by stacking layer, raised by the card's lowest point once it is clearly in the
    // air, so anything flying draws over the hand without popping when it lands. Breathing lifts edges
    // by about one layer step; counting those made resting neighbours swap order (a flicker).
    const key = (k) => k.support + Math.max(0, k.minH - R.renderOrder.airborneCm);
    order.sort((a, b) => key(ks[a]) - key(ks[b]));
    order.forEach((i, rank) => cards[i].mesh.setOrder(R.renderOrder.cards + rank * R.renderOrder.stride));

    cards.forEach(({ mesh }, i) => {
      const k = ks[i];
      mesh.setOpacity(k.opacity);
      if (k.opacity <= 0) { shadowList[i] = null; return; }
      cardBasis(k.yaw, k.pitch, k.roll, k.beta, basis);
      quatFromBasis(basis, q);
      mesh.group.position.set(k.px, k.py, k.pz);
      mesh.group.quaternion.set(q[0], q[1], q[2], q[3]);
      // The lifted edge points where the air layer tilts the card up.
      const lift = Math.hypot(k.lr, k.lp);
      const capRad = CONFIG.idle.edgeLift.capDeg * DEG;
      mesh.setBend(k.curlL, k.curlT, k.twist, k.dog, lift > 1e-6 ? k.lr / lift : 0, lift > 1e-6 ? k.lp / lift : 0, R.edgeLiftCm * clamp(lift / capRad, 0, 1));
      const c = cardCorners(k, footprints[i]);
      const s = shadows[i];
      let sum = 0, min = Infinity;
      for (let n = 0; n < 4; n++) {
        s.corners[3 * n] = c[3 * n]; s.corners[3 * n + 1] = c[3 * n + 1]; s.corners[3 * n + 2] = c[3 * n + 2];
        sum += c[3 * n + 1]; min = Math.min(min, c[3 * n + 1]);
      }
      s.height = sum / 4; s.contact = min;
      shadowList[i] = s;
    });
    table.setShadows(shadowList);

    if (lite) return;
    // Card-on-card shadows: the two nearest cards drawn above each card throw their lamp quads on it.
    const RS = R.shadow;
    order.forEach((i, rank) => {
      const k = ks[i];
      const above = order.slice(rank + 1).filter((j) => ks[j].opacity > 0)
        .map((j) => [j, Math.hypot(ks[j].px - k.px, ks[j].pz - k.pz)])
        .filter(([, d]) => d < 2 * HH).sort((a, b) => a[1] - b[1]).slice(0, 2);
      for (const u of cards[i].mesh.occluders) {
        const occ = u.uOcc.value;
        occ.set(1, 0, 1, 0);
        above.forEach(([j], n) => {
          const dh = Math.max(0, shadows[j].height - shadows[i].height);
          occluderQuad(j, k.py, n ? u.uOccB.value : u.uOccA.value);
          const sigma = RS.sigma0 + RS.sigmaH * dh, alpha = Math.max(RS.alphaMin, RS.alpha0 * (1 - RS.alphaH * dh));
          if (n) { occ.z = sigma; occ.w = alpha; } else { occ.x = sigma; occ.y = alpha; }
        });
      }
    });
  }

  // The 9's window plays the clip once the 9 has settled and is on the fan; the baked still otherwise.
  function updateVideo(world) {
    if (!videoEl || !cards.length) return;
    const i = nine;
    const k = world.cards[i].k;
    const want = k.settledT >= 0 && Math.abs(k.s) < R.video.maxS && !document.hidden;
    if (want && !videoLive) {
      videoLive = true;
      if (!videoStarted) videoEl.currentTime = v9.posterOffset;
      videoEl.play().then(() => {
        if (!videoStarted) { videoStarted = true; onVideoStart?.(world.cards[i]); }
      }, () => { videoLive = false; });
    } else if (!want && videoLive) {
      videoLive = false;
      videoEl.pause();
    }
    cards[i].mesh.front.uVideoMix.value = videoLive && videoEl.readyState >= 2 ? 1 : 0;
  }

  function setParallax(nx, ny) { orbit.tx = nx * CAM.parallax.azDeg; orbit.ty = ny * CAM.parallax.elDeg; }

  function stepParallax(dt) {
    if (!parallax) return;
    const { omega: w, zeta: z } = CAM.parallax;
    orbit.vx += (w * w * (orbit.tx - orbit.x) - 2 * z * w * orbit.vx) * dt;
    orbit.vy += (w * w * (orbit.ty - orbit.y) - 2 * z * w * orbit.vy) * dt;
    orbit.x += orbit.vx * dt; orbit.y += orbit.vy * dt;
    placeCamera();
  }

  function render(world, dtWall) {
    setRise(world.t);
    stepParallax(Math.min(dtWall, 0.1));
    table.update(world.t);
    if (cards.length) updateCards(world);
    updateVideo(world);
    if (world.dust) {
      if (!dust) { dust = createDustPoints(THREE, world.dust, table.lamp); scene.add(dust.points); }
      const L = table.lamp.light;
      lampTarget.copy(L.target.position);
      dust.update(lampTarget, L.angle, L.penumbra, L.intensity / CONFIG.table.lamp.intensity, renderer.getPixelRatio());
    }
    vortex.render(scene, camera, performance.now() / 1000);
  }

  // Top-most card under screen point (x, y) in CSS px, or -1.
  function pick(world, x, y) {
    for (let r = order.length - 1; r >= 0; r--) {
      const i = order[r], k = world.cards[i].k;
      if (k.opacity <= 0) continue;
      const c = cardCorners(k, footprints[i]);
      const s = [0, 1, 2, 3].map((n) => proj.project(c[3 * n], c[3 * n + 1], c[3 * n + 2], [0, 0, 0]));
      let inside = true, sign = 0;
      for (let n = 0; n < 4; n++) {
        const a = s[n], b = s[(n + 1) % 4];
        const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        if (!sign) sign = Math.sign(cross);
        else if (Math.sign(cross) !== sign) { inside = false; break; }
      }
      if (inside) return i;
    }
    return -1;
  }

  return {
    scene, cardsReady,
    get rect() { return rect; },
    get slotPx() { return spx; },
    get cam() { return cam; },
    get proj() { return proj; },
    // A projector that always follows the current fit (for the World's view-entry events).
    screenProjector: {
      get w() { return width; }, get h() { return height; },
      project(x, y, z, out) { return baseProj.project(x, y, z, out); },
    },
    get videoEl() { return videoEl; },
    render, pick, governor, setParallax,
    perfStats() {
      const n = Math.min(perf.n, perf.times.length);
      const pct = (arr, p) => {
        const sorted = Array.from(arr.subarray(0, n)).sort((a, b) => a - b);
        return n ? sorted[Math.min(n - 1, Math.floor(p * n))] : 0;
      };
      return {
        fps: perf.ema > 0 ? 1000 / perf.ema : 0, p50: pct(perf.times, 0.5), p95: pct(perf.times, 0.95),
        frames: perf.frames, dpr, tier, simP95: pct(perf.sim, 0.95),
      };
    },
    project(x, y, z) { const p = proj.project(x, y, z, pt); return { x: p[0], y: p[1] }; },
  };
}
