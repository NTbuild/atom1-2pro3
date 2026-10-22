// Stylised bouncy felt: the card's lowest point hops ballistically, impacts lose energy by a fixed
// restitution schedule, the tilt rocks about the lowest edge, and slot springs pull the card home.
// Also the post-deal air layer: each resting card breathes with the local wind.

import { CONFIG } from './config.js';
import { DEG, clamp, smoothstep } from './math.js';

const CT = CONFIG.contact;
const ID = CONFIG.idle;
const HW = CONFIG.card.w / 2, HH = CONFIG.card.h / 2, HT = CONFIG.card.thick / 2;
const SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
// Edge midpoints: a banked, curled card can rest on the middle of a long edge.
const MIDS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// Displacement of the card surface along its normal at local (x, z): long curl (flex included), lateral curl, twist.
export function surfaceD(x, z, curlL, curlT, twist) {
  const u = (2 * x) / CONFIG.card.w, v = (2 * z) / CONFIG.card.h;
  return curlL * (v * v - 1 / 3) + curlT * (u * u - 1 / 3) + twist * u * v;
}

// Heights (relative to the plate centre) of the 4 corners, the 4 edge midpoints and the centre. yx, yn, yz
// are the world-y components of the card's local x axis, normal and local z axis (basis[1], basis[4], basis[7]).
// Returns the plate-centre lift above the soft lowest point; fills geo.{corners[4], mids[4], centre, min, soft}.
export function contactGeometry(yx, yn, yz, curlL, curlT, twist, geo) {
  let min = Infinity;
  for (let i = 0; i < 4; i++) {
    const x = SIGNS[i][0] * HW, z = SIGNS[i][1] * HH;
    const h = yx * x + yn * surfaceD(x, z, curlL, curlT, twist) + yz * z;
    geo.corners[i] = h;
    if (h < min) min = h;
  }
  const hc = yn * surfaceD(0, 0, curlL, curlT, twist);
  geo.centre = hc;
  if (hc < min) min = hc;
  for (let i = 0; i < 4; i++) {
    const x = MIDS[i][0] * HW, z = MIDS[i][1] * HH;
    const h = yx * x + yn * surfaceD(x, z, curlL, curlT, twist) + yz * z;
    geo.mids[i] = h;
    if (h < min) min = h;
  }
  // Soft-min (log-sum-exp): the lowest point sits on the felt with no corner-switch jitter.
  let sum = Math.exp(-CT.softK * (hc - min));
  for (let i = 0; i < 4; i++) sum += Math.exp(-CT.softK * (geo.corners[i] - min)) + Math.exp(-CT.softK * (geo.mids[i] - min));
  const soft = min - Math.log(sum) / CT.softK;
  geo.min = min;
  geo.soft = soft;
  return HT - soft;            // plate centre height above the hop height
}

// Plain-tilt heights (no flip-axis tilt): the contact layer's own rocking.
export function tiltGeometry(pitch, roll, curlL, curlT, twist, geo) {
  const cp = Math.cos(pitch);
  return contactGeometry(cp * Math.sin(roll), cp * Math.cos(roll), Math.sin(pitch), curlL, curlT, twist, geo);
}

// The card has just touched down: the channel hands its exact state to the contact model.
// pose.m is the flight basis; its tilt folds into plain pitch and roll with the same corner heights.
export function beginContact(k, pose, t) {
  k.touchT = t;
  k.hop = 0;
  k.hopv = pose.vy;
  k.impacts = 0;
  k.resting = 0;
  k.ex = pose.x - k.tx; k.ez = pose.z - k.tz;
  k.evx = pose.vx; k.evz = pose.vz;
  k.eyaw = pose.yaw - k.tyaw; k.eyawv = pose.yawRate;
  k.rp = Math.asin(clamp(pose.m[7], -1, 1));
  k.rr = Math.asin(clamp(pose.m[1] / Math.cos(k.rp), -1, 1));
  k.rpv = 0;
  k.rrv = pose.rollRate * Math.cos(pose.beta);
  k.restSteps = 0; k.settleHold = 0;
}

// An impact of the lowest point at speed vn. Returns the post-impact speed (0 when absorbed).
export function impact(k, vn, restitution, absorbBelow) {
  k.impacts += 1;
  const post = restitution * vn;
  const R = CT.rock;
  if (post < absorbBelow) {
    k.hop = 0; k.hopv = 0; k.resting = 1;
    k.rpv *= 1 - R.absorbGrab; k.rrv *= 1 - R.absorbGrab;
  } else {
    k.hop = 0; k.hopv = post;
    k.rpv += -R.kickPitch * vn * Math.sign(k.rp || 1);
    k.rrv += -R.kickRoll * vn * Math.sign(k.rr || 1);
  }
  // The felt grabs planar and yaw velocity, and the card flexes ("thwap").
  k.evx *= 1 - CT.grab; k.evz *= 1 - CT.grab; k.eyawv *= 1 - CT.grab;
  k.flexv += -CT.flexKick.gain * vn * CT.flexKick.omega;
  return post < absorbBelow ? 0 : post;
}

// Ballistic hop of the lowest point under g', with optional lift and air damping (hover).
export function hopStep(k, dt, lift = 0, damp = 0) {
  if (k.resting) {
    if (lift <= CT.g) return;
    k.resting = 0;
  }
  k.hopv += (lift - CT.g - damp * k.hopv) * dt;
  k.hop += k.hopv * dt;
}

// Rocking of the tilt about the lowest edge (pitch, roll), plus external drives in rad/s^2.
export function rockStep(k, dt, drivePitch = 0, driveRoll = 0) {
  const w = CT.rock.omega, z = CT.rock.zeta, cap = CT.rock.capDeg * DEG;
  k.rpv += (drivePitch - w * w * k.rp - 2 * z * w * k.rpv) * dt;
  k.rrv += (driveRoll - w * w * k.rr - 2 * z * w * k.rrv) * dt;
  k.rp = clamp(k.rp + k.rpv * dt, -cap, cap);
  k.rr = clamp(k.rr + k.rrv * dt, -cap, cap);
}

// Slot springs on the planar error and yaw error, ramped in from touchdown.
export function slotSpringStep(k, t, dt) {
  const ramp = smoothstep(0, CT.slot.ramp, t - k.touchT);
  const w = CT.slot.omega, z = k.resting ? CT.slot.zetaRest : CT.slot.zetaHop;
  const kk = ramp * w * w, cc = ramp * 2 * z * w;
  k.evx += (-kk * k.ex - cc * k.evx) * dt;
  k.evz += (-kk * k.ez - cc * k.evz) * dt;
  k.ex += k.evx * dt; k.ez += k.evz * dt;
  const wy = CT.yaw.omega, zy = CT.yaw.zeta;
  k.eyawv += (-ramp * wy * wy * k.eyaw - ramp * 2 * zy * wy * k.eyawv) * dt;
  k.eyaw += k.eyawv * dt;
}

// The flex oscillator shared by every phase (parameters per phase).
export function flexStep(k, dt, w, z, drive) {
  k.flexv += (drive - w * w * k.flex - 2 * z * w * k.flexv) * dt;
  k.flex += k.flexv * dt;
}

// REST: hop absorbed and every corner within tolerance of its flat resting height for N steps.
export function restCheck(k, geo, flatGeo) {
  if (!k.resting) { k.restSteps = 0; return false; }
  let ok = true;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(geo.corners[i] - geo.soft - (flatGeo.corners[i] - flatGeo.soft)) > CT.rest.cornerTol) ok = false;
  }
  k.restSteps = ok ? k.restSteps + 1 : 0;
  return k.restSteps >= CT.rest.steps;
}

// SETTLED (deal): slot error, yaw error and slot-relative speed all small for the hold time.
export function slotSettled(k, dt) {
  const S = CT.settle;
  const ok = Math.hypot(k.ex, k.ez) < S.posTol && Math.abs(k.eyaw) < S.yawTolDeg * DEG && Math.hypot(k.evx, k.evz) < S.speedTol;
  k.settleHold = ok ? k.settleHold + dt : 0;
  return k.settleHold >= S.hold;
}

// ---------------------------------------------------------------- idle air layer

// One step of the air layer for a card on the felt. w = local wind (cm/s), front = the passing gust
// fronts' speed at the card (cm/s), lx/lz = card local axes in xz, shear = cross-card wind difference
// (cm/s) for the yaw torque, calm in [0, 1] gates drift, yaw and cushion.
export function airStep(k, dt, w, front, lx, lz, shear, calm, edgeK, gustiness) {
  const D = ID.drift;
  const sp = Math.hypot(w[0], w[2]);
  // Drift and yaw on one soft spring, within the idle amplitude caps.
  const capScale = Math.min(1, ID.capCm / Math.max(D.gain * sp, 1e-9));
  const tx = calm * D.gain * w[0] * capScale, tz = calm * D.gain * w[2] * capScale;
  k.avx += (D.omega * D.omega * (tx - k.ax) - 2 * D.zeta * D.omega * k.avx) * dt;
  k.avz += (D.omega * D.omega * (tz - k.az) - 2 * D.zeta * D.omega * k.avz) * dt;
  k.ax += k.avx * dt; k.az += k.avz * dt;
  const ty = calm * clamp(D.yawDegPerCms * shear, -ID.capDeg, ID.capDeg) * DEG;
  k.ayv += (D.omega * D.omega * (ty - k.ay) - 2 * D.zeta * D.omega * k.ayv) * dt;
  k.ay += k.ayv * dt;

  // Air cushion: a passing breath lifts the whole card a hair; it sinks back with a small overshoot.
  const CU = ID.cushion;
  const tc = calm * Math.min(CU.gain * front * front, CU.cap);
  k.cuv += (CU.omega * CU.omega * (tc - k.cu) - 2 * CU.zeta * CU.omega * k.cuv) * dt;
  k.cu += k.cuv * dt;

  // Upwind-edge lift: the wind across an edge lifts it; the card rocks on the downwind edge.
  const E = ID.edgeLift;
  const across = w[0] * lx[0] + w[2] * lx[1];      // along the card's width
  const along = w[0] * lz[0] + w[2] * lz[1];       // along its height
  const cap = E.capDeg * DEG;
  const trr = edgeK * clamp(-E.degPerCms * DEG * across, -cap, cap);
  const trp = edgeK * clamp(-E.degPerCms * DEG * along, -cap, cap);
  k.lrv += (E.omega * E.omega * (trr - k.lr) - 2 * E.zeta * E.omega * k.lrv) * dt;
  k.lpv += (E.omega * E.omega * (trp - k.lp) - 2 * E.zeta * E.omega * k.lpv) * dt;
  k.lr += k.lrv * dt; k.lp += k.lpv * dt;

  // Curl breathing: the corners rise with the breeze over the card.
  const B = ID.curlBreath;
  k.cb = B.amount * (2 * smoothstep(0, B.ref, sp) - 1);

  // The A's dog-ear hinge: lifts in the breeze, rattles in gusts.
  const DG = ID.dogEar;
  const td = clamp(DG.degPerCms * sp, 0, DG.capDeg) * DEG;
  k.dogv += (DG.omega * DG.omega * (td - k.dog) - 2 * DG.zeta * DG.omega * k.dogv + DG.gust * DG.omega * gustiness) * dt;
  k.dog = clamp(k.dog + k.dogv * dt, -DG.capDeg * DEG, DG.capDeg * DEG);
}
