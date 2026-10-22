// The one shared wind field W(x, y, z, t) in cm/s:
//   W = BL(y) * (W_base + W_curl + sum of gust fronts + user jet) + y_hat * W_y
// All state is numeric (Float64Array) so the World can snapshot it.

import { CONFIG } from './config.js';
import { fork } from './rng.js';
import { createSimplex3, curl2 } from './noise.js';
import { smoothstep, lerp } from './math.js';

const W = CONFIG.wind;

export const GUST = { none: 0, puff: 1, squeeze: 2, breath: 3, closing: 4 };
// Gust slot layout.
const G_KIND = 0, G_BORN = 1, G_OX = 2, G_OZ = 3, G_DX = 4, G_DZ = 5, G_C = 6, G_A = 7, G_SIG = 8, G_SIGP = 9, G_LIFE = 10;
const GF = 11;

// Scalar state layout.
const S_ADVX = 0, S_ADVZ = 1, S_PHASE = 2, S_JET = 3, S_T = 4;
const SN = 5;

const fadeEnv = (u) => smoothstep(0, W.gustFade[0], u) * (1 - smoothstep(W.gustFade[1], 1, u));

export class WindField {
  constructor(seed, { calm = false } = {}) {
    this.calm = calm;                         // reduced motion: the air never moves
    this.n1 = createSimplex3(fork(seed, 'wind'));
    this.n2 = createSimplex3(fork(seed, 'wind:octave2'));
    this.ny = createSimplex3(fork(seed, 'wind:y'));
    this.gusts = new Float64Array(W.maxGusts * GF);
    this.s = new Float64Array(SN);
    this.c = new Float64Array(2);
    this.c2 = new Float64Array(2);
    this.j = new Float64Array(2);
    this.b = new Float64Array(3);
    this.norm = this.measureNorm();
  }

  // RMS of the two-octave curl, so W.curl.amp is a true RMS speed.
  measureNorm() {
    const rand = fork(0, 'wind:norm');
    let sum = 0;
    const n = W.curl.normSamples, l = W.curl.scale;
    for (let i = 0; i < n; i++) {
      // Points spread over many eddies and phases of the noise.
      const x = rand() * 200, z = rand() * 200, p = rand() * 50;
      curl2(this.n1, x, z, p, l, this.c);
      curl2(this.n2, x, z, p, l * W.curl.octave2Scale, this.c2);
      const vx = this.c[0] + W.curl.octave2Amp * this.c2[0];
      const vz = this.c[1] + W.curl.octave2Amp * this.c2[1];
      sum += vx * vx + vz * vz;
    }
    return Math.sqrt(sum / n);
  }

  get jet() { return this.s[S_JET]; }
  set jet(v) { this.s[S_JET] = v; }

  // Pure functions of time: the deal -> idle easing and the dealer's gust.
  idleK(t) { return smoothstep(CONFIG.timeline.closingGust, CONFIG.timeline.closingGust + W.curl.ease, t); }
  dealerK(t) {
    const b = W.base;
    return smoothstep(b.dealerRamp[0], b.dealerRamp[1], t) * (1 - smoothstep(b.dealerFade[0], b.dealerFade[1], t));
  }
  base(t, out) {
    const k = this.idleK(t), d = this.dealerK(t), b = W.base;
    out[0] = d * b.dealer[0] + k * b.idle[0];
    out[1] = 0;
    out[2] = d * b.dealer[2] + k * b.idle[2];
    return out;
  }

  advance(t, dt) {
    const s = this.s;
    s[S_T] = t;
    if (this.calm) return;
    const b = this.base(t, this.b);
    s[S_ADVX] += b[0] * dt;
    s[S_ADVZ] += b[2] * dt;
    s[S_PHASE] += lerp(W.curl.deal.freq, W.curl.idle.freq, this.idleK(t)) * dt;
    const g = this.gusts;
    for (let o = 0; o < g.length; o += GF) {
      if (g[o + G_KIND] && t - g[o + G_BORN] >= g[o + G_LIFE]) g[o + G_KIND] = GUST.none;
    }
  }

  // The air the moving cards push along the arc (cm/s, signed along +s): it rises fast and decays slowly.
  driveJet(target, dt) {
    const s = this.s, j = s[S_JET];
    const rising = Math.abs(target) > Math.abs(j) && target * j >= 0;
    s[S_JET] += (target - j) * dt / (rising ? W.jet.rise : W.jet.decay);
  }

  spawn(kind, t, ox, oz, dx, dz, c, a, sigma, sigmaPerp, life) {
    if (this.calm) return;
    const g = this.gusts;
    let slot = -1, oldest = Infinity;
    for (let o = 0; o < g.length; o += GF) {
      if (!g[o + G_KIND]) { slot = o; break; }
      if (g[o + G_BORN] < oldest) { oldest = g[o + G_BORN]; slot = o; }
    }
    g[slot + G_KIND] = kind; g[slot + G_BORN] = t; g[slot + G_OX] = ox; g[slot + G_OZ] = oz;
    g[slot + G_DX] = dx; g[slot + G_DZ] = dz; g[slot + G_C] = c; g[slot + G_A] = a;
    g[slot + G_SIG] = sigma; g[slot + G_SIGP] = sigmaPerp; g[slot + G_LIFE] = life;
  }

  activeGusts() {
    let n = 0;
    for (let o = 0; o < this.gusts.length; o += GF) if (this.gusts[o + G_KIND]) n++;
    return n;
  }

  // W at (x, y, z) for the current time; out = [wx, wy, wz].
  sample(x, y, z, out) {
    if (this.calm) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const s = this.s, t = s[S_T];
    const k = this.idleK(t);
    const b = this.base(t, this.b);
    let wx = b[0], wz = b[2];

    // Frozen turbulence: the eddies drift with the breeze.
    const amp = lerp(W.curl.deal.amp, W.curl.idle.amp, k) / this.norm;
    const px = x - s[S_ADVX], pz = z - s[S_ADVZ], ph = s[S_PHASE];
    curl2(this.n1, px, pz, ph, W.curl.scale, this.c);
    curl2(this.n2, px, pz, ph, W.curl.scale * W.curl.octave2Scale, this.c2);
    wx += amp * (this.c[0] + W.curl.octave2Amp * this.c2[0]);
    wz += amp * (this.c[1] + W.curl.octave2Amp * this.c2[1]);

    this.gustsAt(x, z, this.j);
    wx += this.j[0]; wz += this.j[1];
    this.jetAt(x, z, this.j);
    wx += this.j[0]; wz += this.j[1];

    const bl = this.boundary(y);
    const ay = lerp(W.vertical.deal, W.vertical.idle, k);
    out[0] = bl * wx;
    out[1] = ay * this.ny(px / W.curl.scale, pz / W.curl.scale, ph) * smoothstep(0, W.vertical.height, y);
    out[2] = bl * wz;
    return out;
  }

  // The moving gust fronts alone (before the boundary layer): puffs, squeeze-outs, breaths, the closing gust.
  gustsAt(x, z, out) {
    const g = this.gusts, t = this.s[S_T];
    let wx = 0, wz = 0;
    for (let o = 0; o < g.length; o += GF) {
      const kind = g[o + G_KIND];
      if (!kind) continue;
      const age = t - g[o + G_BORN];
      const env = fadeEnv(age / g[o + G_LIFE]);
      if (env <= 0) continue;
      const rx = x - g[o + G_OX], rz = z - g[o + G_OZ];
      const sig = g[o + G_SIG];
      if (kind === GUST.squeeze) {
        const rho = Math.hypot(rx, rz) + 1e-6;
        const q = rho - g[o + G_C] * age;
        const f = g[o + G_A] * env * Math.exp(-(q * q) / (2 * sig * sig));
        wx += f * rx / rho; wz += f * rz / rho;
      } else {
        const ux = g[o + G_DX], uz = g[o + G_DZ];
        const par = rx * ux + rz * uz - g[o + G_C] * age;
        const perp = -rx * uz + rz * ux;
        const sp = g[o + G_SIGP];
        const f = g[o + G_A] * env * Math.exp(-(par * par) / (2 * sig * sig) - (perp * perp) / (2 * sp * sp));
        wx += f * ux; wz += f * uz;
      }
    }
    out[0] = wx; out[1] = wz;
    return out;
  }

  // Air cannot blow through felt.
  boundary(y) { return W.boundary.floor + (1 - W.boundary.floor) * smoothstep(0, W.boundary.height, y); }

  // The user jet alone (before the boundary layer): air along the fan arc, Gaussian around r = R.
  jetAt(x, z, out) {
    const jet = this.s[S_JET];
    const dz = z - CONFIG.fan.pivotZ;
    const r = Math.hypot(x, dz) + 1e-6;
    const q = r - W.jet.radius;
    const f = jet * Math.exp(-(q * q) / (2 * W.jet.sigma * W.jet.sigma));
    out[0] = f * (-dz / r); out[1] = f * (x / r);
    return out;
  }

  snapshotSize() { return this.gusts.length + SN; }
  writeSnapshot(buf, o) { buf.set(this.gusts, o); buf.set(this.s, o + this.gusts.length); return o + this.snapshotSize(); }
  readSnapshot(buf, o) {
    this.gusts.set(buf.subarray(o, o + this.gusts.length));
    this.s.set(buf.subarray(o + this.gusts.length, o + this.snapshotSize()));
    return o + this.snapshotSize();
  }
}
