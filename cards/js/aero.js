// Flat-plate aerodynamics for a playing card (after Andersen, Pesavento & Wang 2005), stylised:
// a normal force, skin drag, a centre-of-pressure torque, vortex shedding and ground-effect lift.

import { CONFIG } from './config.js';
import { clamp } from './math.js';

const A = CONFIG.aero;
const CW = CONFIG.card.w, CH = CONFIG.card.h;

// Acceleration (cm/s^2) on a card with face normal n moving with relative air vr = W - v_card.
// Writes out[0..2]; also returns the angle of attack and the signed normal acceleration in res.
export function plateAccel(vr, n, out, res) {
  const sp = Math.hypot(vr[0], vr[1], vr[2]);
  if (sp < 1e-6) { out[0] = out[1] = out[2] = 0; res.alpha = 0; res.aN = 0; res.speed = 0; return out; }
  const vn = vr[0] * n[0] + vr[1] * n[1] + vr[2] * n[2];
  const sinA = clamp(Math.abs(vn) / sp, 0, 1);
  const aN = A.K * 2 * sinA * sp * sp * Math.sign(vn);
  const skin = A.skin * A.K * sp;
  out[0] = aN * n[0] + skin * (vr[0] - vn * n[0]);
  out[1] = aN * n[1] + skin * (vr[1] - vn * n[1]);
  out[2] = aN * n[2] + skin * (vr[2] - vn * n[2]);
  res.alpha = Math.asin(sinA);
  res.aN = aN;
  res.speed = sp;
  return out;
}

// Angular acceleration (rad/s^2) on the card's own pitch and roll from the centre-of-pressure offset.
// m is the card basis (column-major: local x, normal, local z). Writes res.pitch and res.roll.
export function plateTorque(vr, m, aN, alpha, res) {
  const vn = vr[0] * m[3] + vr[1] * m[4] + vr[2] * m[5];
  // In-plane flow, in card-local coordinates.
  const fx = (vr[0] - vn * m[3]) * m[0] + (vr[1] - vn * m[4]) * m[1] + (vr[2] - vn * m[5]) * m[2];
  const fz = (vr[0] - vn * m[3]) * m[6] + (vr[1] - vn * m[4]) * m[7] + (vr[2] - vn * m[5]) * m[8];
  const fl = Math.hypot(fx, fz);
  if (fl < 1e-6) { res.pitch = 0; res.roll = 0; return res; }
  const ux = fx / fl, uz = fz / fl;
  const chord = Math.min(CW / Math.max(Math.abs(ux), 1e-6), CH / Math.max(Math.abs(uz), 1e-6));
  const xcp = (0.25 - alpha / (2 * Math.PI)) * chord;
  // The normal force acts upwind of the centre: it raises the leading edge when the air hits the underside.
  const k = A.tauGain * aN * xcp / (chord * chord / 12);
  res.pitch = -k * uz;
  res.roll = -k * ux;
  return res;
}

// Vortex-shedding frequency (Hz) for a relative airspeed (cm/s).
export const shedFreq = (speed) => A.strouhal * speed / A.chord;

// Flutter drive scale: grows with the square of the airspeed, then saturates.
export function flutterGain(speed) {
  const x2 = (speed / A.flutter.vRef) ** 2;
  return A.flutter.driveCap * x2 / (1 + x2);
}

// Ground-effect lift (cm/s^2) at hover height y (cm) for a horizontal relative airspeed.
export function groundLift(speed, y) {
  const g = A.ground;
  const h = clamp(y, 0, g.cap);
  return g.g * (speed / g.vRef) ** 2 * Math.max(0, 1 - h / g.height);
}
