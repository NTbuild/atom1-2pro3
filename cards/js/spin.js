// Spinning the hand: the leader offset phi (slots), its history, and the trailing cards ("leaves")
// that follow it with a travel-time lag and keep moving with the air the hand pushed.

import { CONFIG } from './config.js';
import { DEG, clamp } from './math.js';

const SP = CONFIG.spin;
const HZ = CONFIG.sim.hz;

export const MODE = { idle: 0, snap: 1, drag: 2, glide: 3, pad: 4, closing: 5, step: 6 };
export const MODE_NAMES = ['idle', 'snap', 'drag', 'glide', 'pad', 'closing', 'step'];

// cm of arc per slot at the fan radius (the fan's nominal speed scale).
export const ARC_PER_SLOT = CONFIG.fan.radius * CONFIG.fan.spacingDeg * DEG;

const HIST = Math.round(CONFIG.sim.historySec * HZ);
const LEADER_KEYS = [
  'phi', 'phiDot', 'target', 'mode', 'G', 'padLastT', 'padDir',
  'dragStart', 'dragD', 'emaRate', 'sampleT', 'samplePhi', 'lastMoveT', 'xOrigin', 'grabbed', 'grabE', 'grabEv',
];

export class Leader {
  constructor(phi, reduced) {
    this.reduced = reduced;
    this.k = {
      phi, phiDot: 0, target: phi, mode: MODE.idle,
      G: phi, padLastT: -1, padDir: 0,
      dragStart: phi, dragD: 0, emaRate: 0, sampleT: 0, samplePhi: phi, lastMoveT: 0,
      xOrigin: SP.follow.upwindX, grabbed: -1, grabE: 0, grabEv: 0,
    };
    this.hist = new Float64Array(2 * HIST);
    this.head = 0;
    for (let i = 0; i < HIST; i++) { this.hist[2 * i] = phi; this.hist[2 * i + 1] = 0; }
  }

  get phi() { return this.k.phi; }

  // Leader phi and phi-dot 'lag' seconds ago (linear interpolation in the ring).
  history(lag, out) {
    const f = clamp(lag * HZ, 0, HIST - 1.001);
    const i0 = Math.floor(f), a = f - i0;
    const j0 = (this.head - 1 - i0 + HIST * 2) % HIST, j1 = (j0 - 1 + HIST) % HIST;
    out[0] = this.hist[2 * j0] + (this.hist[2 * j1] - this.hist[2 * j0]) * a;
    out[1] = this.hist[2 * j0 + 1] + (this.hist[2 * j1 + 1] - this.hist[2 * j0 + 1]) * a;
    return out;
  }

  push() {
    this.hist[2 * this.head] = this.k.phi;
    this.hist[2 * this.head + 1] = this.k.phiDot;
    this.head = (this.head + 1) % HIST;
  }

  snapTo(target, mode, dir) {
    const k = this.k;
    k.target = target;
    k.mode = mode;
    k.xOrigin = (dir > 0 ? 1 : -1) * SP.follow.upwindX;
  }

  // Commands (from the input log, stamped with this step). grabbed = {phi, phiDot} of the card under
  // the finger: the drag is anchored on it, and the catch absorbs its motion on the grab spring.
  command(c, t, grabbed) {
    const k = this.k;
    const r = Math.round(k.phi);
    switch (c.type) {
      case 'down':
        k.mode = MODE.drag;
        k.dragStart = grabbed ? grabbed.phi : k.phi; k.dragD = 0;
        k.phi = k.dragStart;
        k.emaRate = 0; k.sampleT = t; k.samplePhi = k.phi; k.lastMoveT = t;
        k.xOrigin = c.xOrigin;
        k.grabbed = c.grab;
        k.grabE = 0; k.grabEv = grabbed ? grabbed.phiDot - k.phiDot : 0;
        break;
      case 'move':
        if (k.mode !== MODE.drag) break;
        if (c.d !== k.dragD) k.lastMoveT = t;
        k.dragD = c.d;
        break;
      case 'up':
        if (k.mode === MODE.drag) this.release(t);
        break;
      case 'flick':
        k.grabbed = -1;
        if (this.reduced) { this.snapTo(r + Math.sign(c.rate), MODE.snap, c.rate); break; }
        k.phiDot = clamp(c.rate, -SP.drag.maxRate, SP.drag.maxRate);
        k.mode = MODE.glide;
        k.xOrigin = (c.rate > 0 ? 1 : -1) * SP.follow.upwindX;
        break;
      case 'notch':
      case 'key': {
        const q = c.type === 'key' ? SP.keys.maxQueue : SP.wheel.maxQueue;
        const base = k.mode === MODE.step || k.mode === MODE.snap ? k.target : r;
        this.snapTo(clamp(base + c.dir, r - q, r + q), MODE.step, c.dir);
        k.grabbed = -1;
        break;
      }
      case 'pad': {
        if (k.mode !== MODE.pad) k.G = k.phi;
        k.G = clamp(k.G + c.delta / SP.wheel.padScale, k.phi - SP.wheel.padClamp, k.phi + SP.wheel.padClamp);
        k.padLastT = t; k.padDir = Math.sign(c.delta);
        k.mode = MODE.pad;
        k.xOrigin = (c.delta > 0 ? 1 : -1) * SP.follow.upwindX;
        k.grabbed = -1;
        break;
      }
    }
  }

  release(t) {
    const k = this.k, D = SP.drag, G = SP.glide;
    const disp = k.phi - k.dragStart;
    k.grabbed = -1;
    if (t - k.lastMoveT >= D.stillHold) k.phiDot = 0;
    else k.phiDot = k.emaRate;
    if (this.reduced) { this.snapTo(Math.round(k.phi), MODE.snap, k.phiDot); return; }
    if (Math.abs(k.phiDot) >= G.stopRate && Math.abs(disp) < D.flickMaxDisp) {
      this.snapTo(Math.round(k.phi) + Math.sign(k.phiDot), MODE.snap, k.phiDot);
    } else if (Math.abs(k.phiDot) >= G.stopRate) {
      k.mode = MODE.glide;
    } else {
      this.glideTarget();
    }
  }

  glideTarget() {
    const k = this.k, G = SP.glide;
    const target = clamp(Math.round(k.phi + G.project * k.phiDot), k.phi - G.maxAhead, k.phi + G.maxAhead);
    this.snapTo(Math.round(target), MODE.snap, target - k.phi || k.phiDot);
  }

  // Advance one step. Returns true on the step the leader lands on its target.
  step(t, dt) {
    const k = this.k;
    let landed = false;
    switch (k.mode) {
      case MODE.drag: {
        const phi = k.dragStart + k.dragD;
        // Velocity estimate from samples at least 8 ms apart.
        if (t - k.sampleT >= SP.drag.minDt) {
          const r = (phi - k.samplePhi) / (t - k.sampleT);
          k.emaRate = clamp(SP.drag.emaKeep * k.emaRate + (1 - SP.drag.emaKeep) * r, -SP.drag.maxRate, SP.drag.maxRate);
          k.sampleT = t; k.samplePhi = phi;
        }
        k.phiDot = k.emaRate;
        k.phi = phi;
        // The grabbed card eases onto the finger, then rides it exactly.
        const g = SP.grab;
        k.grabEv += (-g.omega * g.omega * k.grabE - 2 * g.zeta * g.omega * k.grabEv) * dt;
        k.grabE += k.grabEv * dt;
        break;
      }
      case MODE.glide:
        k.phiDot *= Math.exp(-dt / SP.glide.tau);
        k.phi += k.phiDot * dt;
        if (Math.abs(k.phiDot) < SP.glide.stopRate) this.glideTarget();
        break;
      case MODE.pad: {
        const W = SP.wheel;
        if (k.padLastT >= 0 && t - k.padLastT >= W.padSettle) {
          k.G = k.padDir > 0 ? Math.ceil(k.G - W.padRound) : Math.floor(k.G + W.padRound);
          k.padLastT = -1;
        }
        const w = this.reduced ? SP.reducedSnap.omega : W.padOmega, z = this.reduced ? SP.reducedSnap.zeta : W.padZeta;
        k.phiDot += (w * w * (k.G - k.phi) - 2 * z * w * k.phiDot) * dt;
        k.phi += k.phiDot * dt;
        if (k.padLastT < 0 && this.near(k.G)) { k.phi = k.G; k.phiDot = 0; k.target = k.G; k.mode = MODE.idle; landed = true; }
        break;
      }
      case MODE.snap:
      case MODE.step:
      case MODE.closing: {
        const s = this.reduced ? SP.reducedSnap : SP.snap;
        k.phiDot += (s.omega * s.omega * (k.target - k.phi) - 2 * s.zeta * s.omega * k.phiDot) * dt;
        k.phi += k.phiDot * dt;
        if (this.near(k.target)) { k.phi = k.target; k.phiDot = 0; k.mode = MODE.idle; landed = true; }
        break;
      }
    }
    this.push();
    return landed;
  }

  snapshotSize() { return LEADER_KEYS.length + this.hist.length + 1; }
  writeSnapshot(buf, o) {
    for (const key of LEADER_KEYS) buf[o++] = this.k[key];
    buf.set(this.hist, o); o += this.hist.length;
    buf[o++] = this.head;
    return o;
  }
  readSnapshot(buf, o) {
    for (const key of LEADER_KEYS) this.k[key] = buf[o++];
    this.hist.set(buf.subarray(o, o + this.hist.length)); o += this.hist.length;
    this.head = buf[o++];
    return o;
  }

  near(target) {
    const S = CONFIG.contact.settle;
    return Math.abs(target - this.k.phi) < S.phiTol && Math.abs(this.k.phiDot) < S.phiRateTol;
  }
}

const lagged = new Float64Array(2);

// One trailing card. xi is the card's world x (for the travel-time lag), r its seeded personality in [-1, 1].
export function followStep(k, leader, index, xi, r, dt) {
  const L = leader.k;
  if (leader.reduced) {
    k.phi = L.phi; k.phiv = L.phiDot; k.air = L.phiDot;
    return;
  }
  if (L.mode === MODE.drag && L.grabbed === index) {
    k.phi = L.phi + L.grabE;
    k.phiv = L.phiDot + L.grabEv;
    k.air = L.phiDot;
    return;
  }
  const F = SP.follow;
  leader.history(Math.abs(xi - L.xOrigin) / F.lagSpeed, lagged);
  k.air += (lagged[1] - k.air) * dt / F.airTau;
  const w = F.omega * (1 + F.omegaJitter * r), z = F.zeta + F.zetaJitter * r;
  k.phiv += (w * w * (lagged[0] - k.phi) + 2 * z * w * (k.air - k.phiv)) * dt;
  k.phi += k.phiv * dt;
}

// Bank, yaw lag and the flutter clock from the air over a card moving along the arc.
// wind = W at the card (cm/s, world xz), t = the card's tangent (xz).
// Returns the flutter drive scale for the rocking and the flex.
export function spinAirStep(k, dt, windX, windZ, tx, tz, active) {
  const B = SP.bank, Y = SP.yawLag, FT = SP.flutter;
  // The bank is the card's own spin response: ambient air only counts once the card is moving.
  const own = Math.min(1, Math.abs(k.phiv) / B.ownRate);
  const vrelX = own * windX + k.phiv * ARC_PER_SLOT * tx, vrelZ = own * windZ + k.phiv * ARC_PER_SLOT * tz;
  const vt = vrelX * tx + vrelZ * tz;
  const bankT = active ? clamp(-B.degPerCms * vt, -B.capDeg, B.capDeg) * DEG : 0;
  k.bankv += (B.omega * B.omega * (bankT - k.bank) - 2 * B.zeta * B.omega * k.bankv) * dt;
  k.bank += k.bankv * dt;
  const yawT = active ? clamp(-Y.degPerSlotS * k.phiv, -Y.capDeg, Y.capDeg) * DEG : 0;
  k.ylagv += (Y.omega * Y.omega * (yawT - k.ylag) - 2 * Y.zeta * Y.omega * k.ylagv) * dt;
  k.ylag += k.ylagv * dt;
  const sp = Math.hypot(vrelX, vrelZ);
  k.shedS += 2 * Math.PI * k.flutterHz * dt;
  return active ? FT.gain * (sp / FT.vRef) ** 2 : 0;
}
