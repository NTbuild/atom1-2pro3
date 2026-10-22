// The deal flight: an art-directed channel with a guaranteed touchdown pose, time and velocity,
// plus a perturbation layer (offset, flutter, flex) computed from the shared wind with flat-plate aero.

import { CONFIG } from './config.js';
import { fork, range, signed } from './rng.js';
import { DEG, clamp, lerp, smoothstep, spr, sprRate, hermite, cardBasis } from './math.js';
import { plateAccel, plateTorque, shedFreq, flutterGain } from './aero.js';
import { contactGeometry } from './contact.js';

const FL = CONFIG.flight;
const AE = CONFIG.aero;

// Six evenly spaced grip levels in a seeded order: every deal has a mix of tame and wild cards.
export function gripLevels(seed, count) {
  const rand = fork(seed, 'flight');
  const levels = Array.from({ length: count }, (_, i) => lerp(AE.grip[0], AE.grip[1], count > 1 ? i / (count - 1) : 0.5));
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [levels[i], levels[j]] = [levels[j], levels[i]];
  }
  return levels;
}

// Static per-card flight parameters, drawn once from the card's own stream.
export function planFlight(card, seed, slot, grip) {
  const rand = fork(seed, 'card:' + card.rank);
  const flourish = card.id === FL.flourish.id;
  const tThrow = CONFIG.timeline.throws[card.index] + signed(rand, CONFIG.timeline.throwJitter);

  const L = [FL.launch.xGain * slot.x + signed(rand, FL.launch.jitter), FL.launch.y, FL.launch.z];
  let ux = slot.x - L[0], uz = slot.z - L[2];
  const ul = Math.hypot(ux, uz); ux /= ul; uz /= ul;
  const TD = [slot.x - FL.touchdownBack * ux, slot.z - FL.touchdownBack * uz];
  const D = Math.hypot(TD[0] - L[0], TD[1] - L[2], FL.yKeys[4][1] - L[1]);
  const Tf = FL.time.base + FL.time.perCm * D + signed(rand, FL.time.jitter) + (flourish ? FL.time.flourishExtra : 0);

  const vyTD = FL.yKeys[4][2] + signed(rand, FL.vyJitter);
  const yawSign = rand() < 0.5 ? -1 : 1;
  const flipSign = rand() < 0.5 ? -1 : 1;
  const flip = flourish ? FL.flourish : FL.flip;
  const plan = {
    flourish, tThrow, Tf, D, L, TD, ux, uz,
    yawSlot: slot.yaw,
    dYaw: yawSign * range(rand, FL.launch.yawOffsetDeg[0], FL.launch.yawOffsetDeg[1]) * DEG,
    turns: flipSign * flip.turns,
    flipDelay: flip.delay * Tf, flipOmega: flip.omega, flipZeta: flip.zeta,
    beta: signed(rand, FL.flip.axisTiltDeg) * DEG,
    vyTD,
    support: slot.y,
    shed0: rand() * 2 * Math.PI,
    grip,                                          // how hard this card's spin curves it
  };
  // The stall-drop ends exactly where the lowest point of the flared, still-wobbling card meets the felt.
  const roll = Math.PI * plan.turns * (1 - spr(Tf - plan.flipDelay, plan.flipOmega, plan.flipZeta));
  const pitch = FL.pitch.flareDeg * DEG;
  const m = cardBasis(0, pitch, roll, plan.beta, new Float64Array(9));
  const lift = contactGeometry(m[1], m[4], m[7], card.curl.long, card.curl.lat, card.curl.twist, { corners: new Float64Array(4), mids: new Float64Array(4) });
  plan.yKeys = FL.yKeys.map(([tau, y, vy], k) => (k === 4 ? [tau, lift, vyTD * Tf] : [tau, y, vy * Tf]));
  return plan;
}

// Flight perturbation state, reset at the throw.
export function resetFlight(k, plan) {
  k.dx = k.dy = k.dz = k.dvx = k.dvy = k.dvz = 0;
  k.fp = k.fpv = k.fr = k.frv = 0;
  k.shed = plan.shed0;
  k.flex = k.flexv = 0;
  k.dog = k.dogv = 0;
  k.famp = 0;
  k.wander = 0; k.flutterPeak = 0; k.peakY = 0;
}

const hy = new Float64Array(2);

// The channel at time t (seconds since the throw). Writes ch.{x,y,z,vx,vy,vz,yaw,yawRate,pitch,roll,rollRate,tau}.
export function channel(plan, t, ch) {
  const tau = clamp(t / plan.Tf, 0, 1);
  const e = tau * (1.5 - 0.5 * tau), de = (1.5 - tau) / plan.Tf;
  ch.tau = tau;
  ch.x = lerp(plan.L[0], plan.TD[0], e);
  ch.z = lerp(plan.L[2], plan.TD[1], e);
  ch.vx = (plan.TD[0] - plan.L[0]) * de;
  ch.vz = (plan.TD[1] - plan.L[2]) * de;
  hermite(plan.yKeys, tau, hy);
  ch.y = hy[0] + plan.support;
  ch.vy = hy[1] / plan.Tf;
  // The yaw unwinds on a clock scaled to the flight, so every card lands at the same point of the spring.
  const ty = tau * FL.yaw.span, ky = FL.yaw.span / plan.Tf;
  ch.yaw = plan.yawSlot + plan.dYaw * (1 - spr(ty, FL.yaw.omega, FL.yaw.zeta));
  ch.yawRate = -plan.dYaw * sprRate(ty, FL.yaw.omega, FL.yaw.zeta) * ky;
  const tf = t - plan.flipDelay;
  ch.roll = Math.PI * plan.turns * (1 - spr(tf, plan.flipOmega, plan.flipZeta));
  ch.rollRate = -Math.PI * plan.turns * sprRate(tf, plan.flipOmega, plan.flipZeta);
  ch.pitch = FL.launch.pitchDeg * DEG * (1 - smoothstep(0, FL.pitch.levelBy, tau))
    + FL.pitch.flareDeg * DEG * smoothstep(FL.pitch.flare[0], FL.pitch.flare[1], tau);
  return ch;
}

const ch = {};
const vr = new Float64Array(3), acc = new Float64Array(3), nrm = new Float64Array(3);
const res = {}, tq = {};

const geo = { corners: new Float64Array(4), mids: new Float64Array(4) };

// One step of a card in flight. pose receives x, y, z, vx, vy, vz, yaw, yawRate, pitch, roll, rollRate, beta, tau, m (basis).
export function flightStep(k, card, plan, t, dt, wind, wv, pose) {
  const tl = t - plan.tThrow;
  channel(plan, tl, ch);
  const tau = ch.tau;
  const fade = 1 - smoothstep(FL.fade[0], FL.fade[1], tau);

  pose.x = ch.x + k.dx * fade; pose.y = ch.y + k.dy * fade; pose.z = ch.z + k.dz * fade;
  pose.vx = ch.vx + k.dvx * fade; pose.vy = ch.vy + k.dvy * fade; pose.vz = ch.vz + k.dvz * fade;
  pose.yaw = ch.yaw;
  pose.yawRate = ch.yawRate;
  pose.pitch = ch.pitch + k.fp * fade;
  pose.roll = ch.roll + k.fr * fade;
  pose.rollRate = ch.rollRate;
  pose.beta = plan.beta;
  pose.tau = tau;
  const m = cardBasis(pose.yaw, pose.pitch, pose.roll, pose.beta, pose.m);

  wind.sample(pose.x, pose.y, pose.z, wv);
  vr[0] = wv[0] - pose.vx; vr[1] = wv[1] - pose.vy; vr[2] = wv[2] - pose.vz;
  nrm[0] = m[3]; nrm[1] = m[4]; nrm[2] = m[5];
  plateAccel(vr, nrm, acc, res);

  // Turbulent side force: the crosswind shoves the card off its line. Magnus: the flat spin curves it,
  // by an amount set by the card's grip (the spin's size only picks the direction and the timing).
  const lx = -plan.uz, lz = plan.ux;
  const spin = ch.yawRate / Math.abs(plan.dYaw);
  const side = AE.sideGain * AE.K * res.speed * (vr[0] * lx + vr[2] * lz) + AE.magnus * plan.grip * spin * Math.hypot(ch.vx, ch.vz);
  acc[0] += side * lx; acc[2] += side * lz;

  // Ground effect: a cushion under the skimming card keeps its lowest point off the felt.
  const lift = contactGeometry(m[1], m[4], m[7], card.curl.long, card.curl.lat, card.curl.twist, geo);
  const clear = pose.y - plan.support - lift + geo.min - geo.soft;
  const CU = FL.cushion;
  if (clear < CU.clearance) acc[1] += CU.accel * (1 - clear / CU.clearance) - CU.damp * Math.min(k.dvy, 0);

  // Tether: stiffens toward the landing so the touchdown pose is exact.
  // It hardens with distance, so a strong crosswind bends the path without throwing the card off it.
  const wg = FL.tether.omega0 + FL.tether.omega1 * tau * tau * tau;
  const zg = FL.tether.zeta;
  const kh = wg * wg * (1 + (k.dx * k.dx + k.dz * k.dz) / (FL.tether.harden * FL.tether.harden));
  k.dvx += (acc[0] - kh * k.dx - 2 * zg * wg * k.dvx) * dt;
  // The channel owns the vertical arc: the air only nudges the height.
  const wy = wg * FL.tether.vertical;
  k.dvy += (acc[1] - wy * wy * k.dy - 2 * zg * wy * k.dvy) * dt;
  k.dvz += (acc[2] - kh * k.dz - 2 * zg * wg * k.dvz) * dt;
  k.dx += k.dvx * dt; k.dy += k.dvy * dt; k.dz += k.dvz * dt;

  // Flutter: vortex shedding into the pitch/roll oscillators, plus the centre-of-pressure torque.
  plateTorque(vr, m, res.aN, res.alpha, tq);
  k.shed += 2 * Math.PI * shedFreq(res.speed) * dt;
  // The vortex street takes a moment to establish after the card leaves the hand.
  k.famp += (flutterGain(res.speed) - k.famp) * dt / AE.flutter.buildUp;
  const drive = k.famp;
  // The aerodynamic restoring moment grows with the angle (a hardening spring).
  const wf = lerp(AE.flutter.omega[0], AE.flutter.omega[1], tau);
  const zf = AE.flutter.zeta, hf = AE.flutter.hardenDeg * DEG;
  const kp = wf * wf * (1 + (k.fp * k.fp) / (hf * hf)), kr = wf * wf * (1 + (k.fr * k.fr) / (hf * hf));
  k.fpv += (AE.flutter.drivePitch * drive * Math.sin(k.shed) + tq.pitch - kp * k.fp - 2 * zf * wf * k.fpv) * dt;
  k.frv += (AE.flutter.driveRoll * drive * Math.cos(k.shed) + tq.roll - kr * k.fr - 2 * zf * wf * k.frv) * dt;
  k.fp += k.fpv * dt; k.fr += k.frv * dt;

  // Flex: face pressure bends the card (faded with the rest of the perturbation); the shedding
  // rattles the A's dog-ear.
  const fw = FL.flex.omega, fz = FL.flex.zeta;
  k.flexv += (fw * fw * (FL.flex.cmPerAccel * res.aN * fade - k.flex) - 2 * fz * fw * k.flexv) * dt;
  k.flex = clamp(k.flex + k.flexv * dt, -FL.flex.cap, FL.flex.cap);
  const dw = FL.dogEar.omega, dz = FL.dogEar.zeta;
  k.dogv += (dw * dw * (FL.dogEar.degPerCms * DEG * res.speed * Math.sin(2 * k.shed) - k.dog) - 2 * dz * dw * k.dogv) * dt;
  k.dog = clamp(k.dog + k.dogv * dt, -FL.dogEar.capDeg * DEG, FL.dogEar.capDeg * DEG);

  k.wander = Math.max(k.wander, Math.abs((k.dx * lx + k.dz * lz) * fade));
  k.flutterPeak = Math.max(k.flutterPeak, Math.abs(k.fr * fade));
  k.peakY = Math.max(k.peakY, pose.y - plan.support);
  return tl >= plan.Tf;
}
