// The fan: slot poses on the arc, the wrap seam, per-card imperfection, the stacking layer,
// and the camera fit that frames it. Pure math (no DOM, no THREE) so tests can run it in Node.

import { CONFIG } from './config.js';
import { fork, signed } from './rng.js';
import { DEG, smoothstep, lerp, cardBasis } from './math.js';

const F = CONFIG.fan;
const C = CONFIG.camera;
const HW = CONFIG.card.w / 2, HH = CONFIG.card.h / 2;
const RING = 2 * F.half;

// Wrap a slot coordinate into [-3, 3).
export const wrap = (s) => ((((s + F.half) % RING) + RING) % RING) - F.half;

// Stacking height: each card lies over its left neighbour.
export const layer = (s) => F.layerStep * (s + F.half);

function slotTheta(s) {
  const u = Math.max(0, Math.abs(s) - F.edgeU0);
  return F.spacingDeg * DEG * s + Math.sign(s) * F.edgeThetaDeg * DEG * u * u;
}

function slotRadius(s) {
  const u = Math.max(0, Math.abs(s) - F.edgeU0);
  return F.radius + F.edgeR * u * u;
}

// Seeded per-card deviation from the perfect fan.
export function imperfection(seed, count) {
  const rand = fork(seed, 'imperfection');
  const I = CONFIG.imperfection;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      dTheta: signed(rand, I.thetaDeg) * DEG,
      dR: signed(rand, I.r),
      dT: signed(rand, I.tangential),
      dYaw: signed(rand, I.yawDeg) * DEG,
    });
  }
  return out;
}

const NO_IMP = { dTheta: 0, dR: 0, dT: 0, dYaw: 0 };

// Rest pose of a card at slot s: centre (x, layer, z), yaw = -theta (+ imperfection), and the arc tangent.
export function slotPose(s, imp = NO_IMP, out = {}) {
  const th = slotTheta(s) + imp.dTheta;
  const r = slotRadius(s) + imp.dR;
  const sn = Math.sin(th), cs = Math.cos(th);
  out.x = r * sn + imp.dT * cs;
  out.y = layer(s);
  out.z = F.pivotZ - r * cs + imp.dT * sn;
  out.yaw = -th + imp.dYaw;
  out.tx = cs; out.tz = sn;            // unit tangent toward increasing s
  return out;
}

// Accordion: the fan opens with the cards' speed (slots/s).
export const accordion = (phiDot) => 1 + F.accordion * Math.min(Math.abs(phiDot), F.accordionCap);

// The 4 corners of a flat card (x, z in the felt plane) at the given centre and yaw.
function flatCorners(x, z, yaw, out = new Float64Array(8)) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let o = 0;
  for (const [lx, lz] of [[-HW, -HH], [HW, -HH], [HW, HH], [-HW, HH]]) {
    out[o++] = x + c * lx + s * lz;
    out[o++] = z - s * lx + c * lz;
  }
  return out;
}

// ---------------------------------------------------------------- camera

// A camera description: eye, target, vertical fov, aspect; plus the derived view basis.
// shiftZ slides the target (and the eye with it) toward the player.
function makeCamera(fovDeg, dist, aspect, shiftZ = 0, azDeg = 0, elDeg = 0) {
  const el = (C.elevationDeg + elDeg) * DEG, az = azDeg * DEG;
  const [tx, ty] = C.target, tz = C.target[2] + shiftZ;
  const eye = [
    tx + dist * Math.cos(el) * Math.sin(az),
    ty + dist * Math.sin(el),
    tz + dist * Math.cos(el) * Math.cos(az),
  ];
  // Forward, right, up (lookAt with world up = +y).
  let fx = tx - eye[0], fy = ty - eye[1], fz = tz - eye[2];
  const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx;                                 // forward x up
  const rl = Math.hypot(rx, rz); rx /= rl; rz /= rl;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;   // right x forward
  return { fovDeg, dist, aspect, shiftZ, eye, target: [tx, ty, tz], f: [fx, fy, fz], r: [rx, 0, rz], u: [ux, uy, uz], tanHalf: Math.tan(fovDeg * DEG / 2) };
}

// World point -> normalised device coordinates (x right, y up), plus view depth.
function toNdc(cam, x, y, z, out) {
  const dx = x - cam.eye[0], dy = y - cam.eye[1], dz = z - cam.eye[2];
  const depth = dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2];
  const vx = dx * cam.r[0] + dz * cam.r[2];
  const vy = dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2];
  out[0] = vx / (depth * cam.tanHalf * cam.aspect);
  out[1] = vy / (depth * cam.tanHalf);
  out[2] = depth;
  return out;
}

// Ray from screen NDC through the camera, intersected with the plane y = h. Returns [x, z].
export function ndcToPlane(cam, nx, ny, h, out) {
  const dx = cam.f[0] + cam.r[0] * nx * cam.tanHalf * cam.aspect + cam.u[0] * ny * cam.tanHalf;
  const dy = cam.f[1] + cam.u[1] * ny * cam.tanHalf;
  const dz = cam.f[2] + cam.r[2] * nx * cam.tanHalf * cam.aspect + cam.u[2] * ny * cam.tanHalf;
  const k = (h - cam.eye[1]) / dy;
  out[0] = cam.eye[0] + dx * k;
  out[1] = cam.eye[2] + dz * k;
  return out;
}

const nd = new Float64Array(3);
const corners = new Float64Array(8);
const pose = {};

// Largest |ndc x| of slot s's corners (outer) or smallest (inner), for a camera at distance d.
function slotNdcX(fovDeg, d, aspect, s, inner, insetCm = 0, shiftZ = 0) {
  const cam = makeCamera(fovDeg, d, aspect, shiftZ);
  slotPose(s, NO_IMP, pose);
  flatCorners(pose.x, pose.z, pose.yaw, corners);
  let best = inner ? Infinity : -Infinity;
  for (let k = 0; k < 4; k++) {
    const x = corners[2 * k] - Math.sign(s) * insetCm;
    toNdc(cam, x, pose.y, corners[2 * k + 1], nd);
    const ax = Math.abs(nd[0]);
    best = inner ? Math.min(best, ax) : Math.max(best, ax);
  }
  return best;
}

// Solve f(d) = goal for a monotone decreasing f by bisection.
function solveDist(f, goal) {
  let lo = 5, hi = 400;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > goal) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Lowest screen point (ndc y) of the hand's slots -2..2 for a camera at distance d.
function handBottomNdc(fovDeg, d, aspect, shiftZ) {
  const cam = makeCamera(fovDeg, d, aspect, shiftZ);
  let low = Infinity;
  for (let s = -C.fitSlot; s <= C.fitSlot; s++) {
    slotPose(s, NO_IMP, pose);
    flatCorners(pose.x, pose.z, pose.yaw, corners);
    for (let k = 0; k < 4; k++) low = Math.min(low, toNdc(cam, corners[2 * k], pose.y, corners[2 * k + 1], nd)[1]);
  }
  return low;
}

// Frame the hand for an aspect: slots +/-2 just past the edges (wide), or the centre card plus
// neighbours (narrow); never letting a card at |s| >= 2.92 come within 2 cm of the screen. On very
// wide screens the view then slides toward the player until the hand clears the caption band.
export function fitCamera(aspect) {
  const k = 1 - smoothstep(C.narrowAspect[0], C.narrowAspect[1], aspect);
  const fov = lerp(C.fovDeg, C.fovNarrowDeg, k);
  const tanH = Math.tan(fov * DEG / 2);
  const dWide = solveDist((d) => slotNdcX(fov, d, aspect, C.fitSlot, false), 1 + C.overscan);
  const dNarrow = C.halfWidthNarrow / (tanH * aspect);
  let d = lerp(dWide, dNarrow, k);
  let shift = 0;
  if (handBottomNdc(fov, d, aspect, 0) < C.bottomMargin - 1) {
    let lo = 0, hi = C.maxShiftZ;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      if (handBottomNdc(fov, d, aspect, mid) < C.bottomMargin - 1) lo = mid; else hi = mid;
    }
    shift = hi;
  }
  const dClamp = solveDist((d2) => slotNdcX(fov, d2, aspect, C.wrapS, true, C.wrapClearCm, shift), 1);
  d = Math.min(d, dClamp);
  return makeCamera(fov, d, aspect, shift);
}

// The same camera orbited by the pointer parallax (degrees).
export const orbitCamera = (cam, azDeg, elDeg) => makeCamera(cam.fovDeg, cam.dist, cam.aspect, cam.shiftZ, azDeg, elDeg);

// After the deal the camera climbs to look almost straight down and moves in, so the outer
// polaroids bleed off the edges. k: 0 (the deal's view) .. 1 (risen).
export const riseCamera = (cam, k, azDeg = 0, elDeg = 0) => makeCamera(
  cam.fovDeg, cam.dist * lerp(1, C.rise.distScale, k), cam.aspect, lerp(cam.shiftZ, C.rise.shiftZ, k),
  azDeg, elDeg + k * C.rise.elevationDeg);

// Projector: world -> CSS px for a w x h screen.
export function projector(cam, w, h) {
  const v = new Float64Array(3);
  return {
    cam, w, h,
    project(x, y, z, out) {
      toNdc(cam, x, y, z, v);
      out[0] = (v[0] + 1) * 0.5 * w;
      out[1] = (1 - v[1]) * 0.5 * h;
      out[2] = v[2];
      return out;
    },
  };
}

// Projected distance (px) between the slot 0 and slot 1 centres.
export function slotPx(proj) {
  const a = slotPose(0), b = slotPose(1);
  const pa = proj.project(a.x, a.y, a.z, new Float64Array(3));
  const pb = proj.project(b.x, b.y, b.z, new Float64Array(3));
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
}

// The slot s near s0 whose card (with imperfection imp) projects to screen x = xPx: direct manipulation
// keeps the grabbed card exactly under the finger despite the arc and the perspective.
export function slotAtScreenX(proj, imp, s0, xPx) {
  const p = new Float64Array(3), pose = {};
  const xOf = (s) => { slotPose(s, imp, pose); return proj.project(pose.x, pose.y, pose.z, p)[0]; };
  let s = s0;
  for (let i = 0; i < 8; i++) {
    const h = 1e-3, f = xOf(s) - xPx, df = (xOf(s + h) - xOf(s - h)) / (2 * h);
    if (Math.abs(df) < 1e-9) break;
    s -= f / df;
  }
  return s;
}

const sb = new Float64Array(9), sp = new Float64Array(3);

// A card's projected corners and centre (CSS px) and whether any of it is on screen.
// k: composed card state (px, py, pz, yaw, pitch, roll, beta); proj: {project, w, h}.
export function screenOf(proj, k) {
  cardBasis(k.yaw, k.pitch, k.roll, k.beta, sb);
  const corners = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const lx = sx * HW, lz = sz * HH;
    proj.project(k.px + sb[0] * lx + sb[6] * lz, k.py + sb[1] * lx + sb[7] * lz, k.pz + sb[2] * lx + sb[8] * lz, sp);
    corners.push([sp[0], sp[1]]);
    x0 = Math.min(x0, sp[0]); x1 = Math.max(x1, sp[0]); y0 = Math.min(y0, sp[1]); y1 = Math.max(y1, sp[1]);
  }
  proj.project(k.px, k.py, k.pz, sp);
  return { x: sp[0], y: sp[1], corners, visible: x1 > 0 && x0 < proj.w && y1 > 0 && y0 < proj.h };
}
