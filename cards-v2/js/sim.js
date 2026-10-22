// The World: phase machine, deal timeline, events and the fixed 240 Hz step.
// DOM-free and deterministic: sim time is step / 240 and every random draw comes from a seeded fork.

import { CONFIG } from './config.js';
import { fork, range } from './rng.js';
import { DEG, smoothstep, cardBasis, quatFromBasis } from './math.js';
import { WindField, GUST } from './wind.js';
import { groundLift } from './aero.js';
import { wrap, slotPose, imperfection, accordion, screenOf } from './fan.js';
import { planFlight, gripLevels, resetFlight, flightStep } from './flight.js';
import {
  contactGeometry, tiltGeometry, beginContact, impact, hopStep, rockStep, slotSpringStep, flexStep,
  restCheck, slotSettled, airStep,
} from './contact.js';
import { Leader, MODE, MODE_NAMES, ARC_PER_SLOT, followStep, spinAirStep } from './spin.js';
import { DustSim } from './render/dust.js';

const HZ = CONFIG.sim.hz;
const TL = CONFIG.timeline;
const FAN = CONFIG.fan;
const CT = CONFIG.contact;
const ID = CONFIG.idle;
const SP = CONFIG.spin;
const WD = CONFIG.wind;
const HH = CONFIG.card.h / 2;

export const PHASES = ['boot', 'deal', 'closing', 'idle', 'drag', 'glide', 'snap', 'step'];
export const CARD_PHASES = ['queued', 'flight', 'contact', 'settling', 'rest', 'spin'];
const CP = Object.fromEntries(CARD_PHASES.map((p, i) => [p, i]));
const PH = Object.fromEntries(PHASES.map((p, i) => [p, i]));

// Every dynamic number of a card. The key order is the snapshot layout.
function cardTemplate() {
  return {
    phase: CP.queued, opacity: 0,
    // composed pose
    px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, roll: 0, beta: 0,
    faceUp: -1, centreH: 0, minH: 0, support: 0, s: 0, flipRoll: 0, flipRate: 0, curlL: 0, curlT: 0, twist: 0,
    // flight perturbation
    dx: 0, dy: 0, dz: 0, dvx: 0, dvy: 0, dvz: 0, fp: 0, fpv: 0, fr: 0, frv: 0, shed: 0,
    flex: 0, flexv: 0, dog: 0, dogv: 0, famp: 0, wander: 0, flutterPeak: 0, peakY: 0,
    // contact
    touchT: -1, hop: 0, hopv: 0, impacts: 0, resting: 0, dealDone: 0,
    ex: 0, ez: 0, evx: 0, evz: 0, eyaw: 0, eyawv: 0, rp: 0, rpv: 0, rr: 0, rrv: 0,
    restSteps: 0, settleHold: 0, restT: -1, dealSettledT: -1, settledT: -1, settled: 0,
    airborne: 0, hopStartT: 0, hopPeak: 0, nHops: 0, hop1: 0, hop2: 0, air1: 0, air2: 0,
    // slot target
    tx: 0, tz: 0, tyaw: 0, ttx: 1, ttz: 0,
    // idle air layer
    ax: 0, az: 0, avx: 0, avz: 0, ay: 0, ayv: 0, cu: 0, cuv: 0, lp: 0, lpv: 0, lr: 0, lrv: 0, cb: 0,
    // spin
    phi: 0, phiv: 0, air: 0, wrapK: 0, bank: 0, bankv: 0, ylag: 0, ylagv: 0, shedS: 0, flutterHz: 0, spinning: 0,
    // bookkeeping for events
    entered: 0, lastFaceUp: -1, flipDone: 0,
  };
}
const CARD_KEYS = Object.keys(cardTemplate());
const WORLD_KEYS = ['n', 'phase', 'closingStarted', 'closingDone', 'idleT', 'breathK', 'nextBreath'];

// Reduced motion: visible cards fade in left to right.
const fadeOrder = (c) => Math.max(0, Math.round(c.restS) + FAN.half - 1);

const pose = { m: new Float64Array(9) };
const geo = { corners: new Float64Array(4), mids: new Float64Array(4) };
const flatGeo = { corners: new Float64Array(4), mids: new Float64Array(4) };
const wv = new Float64Array(3), wa = new Float64Array(3), wb = new Float64Array(3), jv = new Float64Array(2);
const sp0 = {};
const basis = new Float64Array(9);

export class World {
  // deck: [{id, rank, title, sub, curl: {long, lat, twist}, dogEar}] in ring order.
  constructor({ deck, seed = CONFIG.seed, reduced = false, dustCount = CONFIG.dust.count, dust = true }) {
    this.opts = { deck, seed, reduced, dustCount, dust };
    this.seed = seed;
    this.reduced = reduced;
    this.dt = 1 / HZ;
    this.wind = new WindField(seed, { calm: reduced });
    this.leader = new Leader(reduced ? FAN.restPhi : FAN.dealPhi, reduced);
    this.dust = dust && !reduced ? new DustSim(seed, dustCount) : null;
    this.events = [];
    this.log = [];
    this.cursor = 0;
    this.projector = null;
    this.g = Object.fromEntries(WORLD_KEYS.map((k) => [k, 0]));
    this.g.idleT = -1;
    this.g.nextBreath = TL.closingGust + WD.breath.first;
    this.cardRate = 0;

    const imps = imperfection(seed, deck.length);
    const grips = gripLevels(seed, deck.length);
    const personality = fork(seed, 'spin');
    this.cards = deck.map((d, i) => {
      const c = {
        index: i, id: d.id, rank: d.rank, title: d.title, sub: d.sub, accent: d.accent,
        curl: d.curl, dogEar: d.dogEar || null, imp: imps[i],
        r: range(personality, -1, 1),
        k: cardTemplate(),
      };
      c.k.flutterHz = range(personality, SP.flutter.freq[0], SP.flutter.freq[1]);
      c.k.phi = this.leader.phi;
      this.updateSlot(c);
      const slot = slotPose(c.k.s, c.imp);
      c.restS = wrap(i - FAN.restPhi);
      tiltGeometry(0, 0, d.curl.long, d.curl.lat, d.curl.twist, geo);
      c.restCentre = geo.centre - geo.soft;          // centre height lying flat at rest (for hop peaks)
      c.plan = planFlight(c, seed, slot, grips[i]);
      this.target(c, 0);
      if (reduced) this.placeAtRest(c);
      return c;
    });
    this.compose(0);
  }

  get n() { return this.g.n; }
  get t() { return this.g.n / HZ; }
  get phase() { return PHASES[this.g.phase]; }
  get interactiveAt() {
    return this.reduced ? SP.reduced.stagger * Math.max(...this.cards.map(fadeOrder)) + SP.reduced.fadeIn : TL.closingGust;
  }

  // Slot coordinate from the card's own phi. The wrap branch only changes once s leaves the
  // hysteresis band, so a card resting on the seam never flickers between the two ends.
  // Returns true when the card wrapped.
  updateSlot(c) {
    const k = c.k, raw = c.index - k.phi, ring = 2 * FAN.half;
    const s = raw + ring * k.wrapK;
    const h = FAN.half + FAN.wrapHysteresis;
    if (s < h && s >= -h) { k.s = s; return false; }
    k.wrapK = Math.round((wrap(raw) - raw) / ring);
    k.s = raw + ring * k.wrapK;
    return true;
  }

  // The air the moving cards push along the arc (slots/s).
  meanCardRate() {
    let sum = 0, n = 0;
    for (const c of this.cards) if (c.k.phase > CP.flight) { sum += c.k.phiv; n++; }
    return n ? sum / n : 0;
  }

  // The slot pose. The accordion opens the fan around the grabbed card while dragging; otherwise
  // only the downwind half stretches, so the hand reaches toward where it is going.
  target(c, rate) {
    const k = c.k, L = this.leader.k;
    const acc = accordion(rate);
    let s = k.s;
    if (L.mode === MODE.drag && L.grabbed >= 0) {
      const anchor = this.cards[L.grabbed].k.s;
      s = anchor + (s - anchor) * acc;
    } else if (s * rate < 0) {
      s *= acc;
    }
    const sl = slotPose(s, c.imp, sp0);
    k.tx = sl.x; k.tz = sl.z; k.tyaw = sl.yaw; k.support = sl.y;
    k.ttx = sl.tx; k.ttz = sl.tz;
  }

  placeAtRest(c) {
    const k = c.k;
    k.phase = CP.rest; k.resting = 1; k.dealDone = 1; k.settled = 1;
    k.touchT = 0; k.restT = 0; k.dealSettledT = 0; k.settledT = 0;
    k.faceUp = 1;
  }

  emit(type, card, data = null) {
    this.events.push({ t: this.t, step: this.g.n, type, card: card ? card.id : null, data });
  }

  // ------------------------------------------------------------------ input

  // Append a command for a future step (the input log is the single source of truth for replays).
  // Live input replaces whatever future the log held (after a seek back, say).
  input(cmd, { live = false } = {}) {
    if (live) this.truncateLog();
    const c = { ...cmd, step: Math.max(cmd.step ?? this.g.n + 1, this.g.n + 1) };
    let i = this.log.length;
    while (i > 0 && this.log[i - 1].step > c.step) i--;
    this.log.splice(i, 0, c);
    if (i < this.cursor) this.cursor = i;
    return c;
  }

  // Drop commands after the current step (live input after a seek replaces the old future).
  truncateLog() {
    this.log.length = this.cursor;
  }

  applyCommands() {
    const n = this.g.n;
    while (this.cursor < this.log.length && this.log[this.cursor].step <= n) {
      const c = this.log[this.cursor++];
      if (c.step < n) continue;
      this.emit('input', null, { type: c.type });
      if (this.t < this.interactiveAt) continue;
      const held = c.type === 'down' && c.grab >= 0 ? this.cards[c.grab].k : null;
      this.leader.command(c, this.t, held && { phi: held.phi, phiDot: held.phiv });
      if (c.type === 'key') this.wind.jet += -c.dir * WD.jet.keyImpulse * ARC_PER_SLOT;
    }
  }

  // ------------------------------------------------------------------ step

  step(count = 1) {
    for (let i = 0; i < count; i++) this.stepOnce();
    return this;
  }

  stepOnce() {
    const g = this.g;
    g.n += 1;
    const t = this.t, dt = this.dt;
    this.wind.advance(t, dt);
    this.applyCommands();
    this.timeline(t);

    const L = this.leader;
    if (L.step(t, dt)) this.emit('snap', null, { phi: L.phi });
    this.cardRate = this.meanCardRate();
    this.wind.driveJet(-WD.jet.gain * this.cardRate * ARC_PER_SLOT, dt);

    for (const c of this.cards) this.stepCard(c, t, dt);
    // Motes only need a new position per rendered frame: integrate them on every few steps.
    if (this.dust && g.n % CONFIG.dust.everySteps === 0) this.dust.step(t, dt * CONFIG.dust.everySteps, this.wind, this.swirls());
    this.compose(t);
    this.detect(t, dt);
    this.updatePhase(t);
  }

  timeline(t) {
    const g = this.g;
    if (this.reduced) return;
    if (!g.closingStarted && t >= TL.closingGust) {
      g.closingStarted = 1;
      this.leader.snapTo(FAN.restPhi, MODE.closing, 1);
      const C = WD.closing;
      this.wind.spawn(GUST.closing, t, C.startX, 0, -1, 0, C.speed, C.amp, C.sigma, C.sigmaPerp, C.life);
      this.emit('closing-gust', null, { phi: FAN.restPhi });
    }
    if (g.closingStarted && t >= g.nextBreath) {
      const B = WD.breath;
      const rand = fork(this.seed, 'breaths:' + g.breathK);
      const head = Math.PI + range(rand, -B.spreadDeg, B.spreadDeg) * DEG;
      const dx = Math.cos(head), dz = Math.sin(head);
      this.wind.spawn(GUST.breath, t, -dx * B.startDist, -dz * B.startDist, dx, dz, B.speed, B.amp, B.sigma, B.sigmaPerp, B.life);
      this.emit('breath', null, { k: g.breathK, dir: [dx, dz], origin: [-dx * B.startDist, -dz * B.startDist], speed: B.speed });
      g.breathK += 1;
      g.nextBreath = t + range(rand, B.every[0], B.every[1]);
    }
  }

  stepCard(c, t, dt) {
    const k = c.k, plan = c.plan;
    if (this.reduced) {
      k.opacity = smoothstep(0, SP.reduced.fadeIn, t - SP.reduced.stagger * fadeOrder(c));
      this.feltStep(c, t, dt);
      return;
    }
    if (k.phase === CP.queued) {
      if (t < plan.tThrow) return;
      k.phase = CP.flight;
      resetFlight(k, plan);
      this.emit('throw', c, { t: plan.tThrow });
      const P = WD.puff, speed = plan.D / plan.Tf;
      this.wind.spawn(GUST.puff, t, plan.L[0], plan.L[2], plan.ux, plan.uz, speed, P.speedGain * speed, P.sigma, P.sigmaPerp, plan.Tf + P.extraLife);
    }
    if (k.phase === CP.flight) {
      // Out of the dark beyond the lamp: off-screen on wide screens, a soft arrival on tall ones.
      k.opacity = smoothstep(0, CONFIG.flight.launch.fadeIn, t - plan.tThrow);
      const done = flightStep(k, c, plan, t, dt, this.wind, wv, pose);
      k.flipRoll = pose.roll - (k.fr * (1 - smoothstep(CONFIG.flight.fade[0], CONFIG.flight.fade[1], pose.tau)));
      k.flipRate = pose.rollRate;
      if (!done) {
        k.px = pose.x; k.py = pose.y; k.pz = pose.z;
        k.vx = pose.vx; k.vy = pose.vy; k.vz = pose.vz;
        k.yaw = pose.yaw; k.pitch = pose.pitch; k.roll = pose.roll; k.beta = pose.beta;
        return;
      }
      // Touchdown: hand the exact channel state to the contact model, and the first impact.
      k.phase = CP.contact;
      k.opacity = 1;
      k.beta = 0; k.flipRoll = 0; k.flipRate = 0;
      k.fp = k.fpv = k.fr = k.frv = 0;
      beginContact(k, pose, t);
      this.emit('touchdown', c, { vy: pose.vy, x: pose.x, z: pose.z });
      const vn = -k.hopv;
      impact(k, vn, CT.restitution[0], CT.absorbBelow);
      this.startHop(k, t);
      const S = WD.squeeze;
      this.wind.spawn(GUST.squeeze, t, pose.x, pose.z, 0, 0, S.speed, S.amp, S.sigma, S.sigma, S.life);
    }
    this.feltStep(c, t, dt);
  }

  startHop(k, t) {
    k.airborne = k.hopv > 0 ? 1 : 0;
    k.hopStartT = t; k.hopPeak = 0;
  }

  // A card on the felt (or hovering over it): spin follow, contact, air layer, then the composed pose.
  feltStep(c, t, dt) {
    const k = c.k, L = this.leader;
    const phiBefore = k.phi;
    followStep(k, L, c.index, k.px, c.r, dt);
    if (this.updateSlot(c)) this.emit('wrap', c, { s: k.s });
    this.target(c, this.cardRate);
    if (this.reduced) {
      k.phiv = (k.phi - phiBefore) / dt;
      return;
    }

    // Air over the card. Hover rides on the card's motion through the air the hand pushed (the jet),
    // measured at the fan's nominal arc speed: the faster outer slots are a layout device, not airspeed.
    const vt = -k.phiv * ARC_PER_SLOT;
    const airY = k.py + ID.sampleHeight;
    this.wind.sample(k.px, airY, k.pz, wv);
    this.wind.jetAt(k.px, k.pz, jv);
    const bl = this.wind.boundary(airY);
    const vrx = bl * jv[0] - vt * k.ttx, vrz = bl * jv[1] - vt * k.ttz;

    const spinning = L.k.mode !== MODE.idle || Math.abs(k.phiv) > CT.settle.phiRateTol || Math.abs(k.phi - L.k.phi) > CT.settle.phiTol;
    k.spinning = spinning ? 1 : 0;
    const held = L.k.mode === MODE.drag && L.k.grabbed === c.index;

    // Hop: deal bounces first, then hover and tap-downs. The card under the finger stays down.
    const wasResting = k.resting;
    const lift = spinning && !held ? groundLift(Math.hypot(vrx, vrz), k.hop) : 0;
    hopStep(k, dt, lift, spinning ? SP.hover.damp : 0);
    if (wasResting && !k.resting) this.startHop(k, t);
    if (k.hop > CONFIG.aero.ground.cap) { k.hop = CONFIG.aero.ground.cap; k.hopv = Math.min(k.hopv, 0); }
    if (k.hop < 0 && k.hopv < 0) this.land(c, t);

    // Flutter while spinning drives the rocking and the flex.
    const flut = spinAirStep(k, dt, wv[0], wv[2], k.ttx, k.ttz, spinning && !held);
    const sn = Math.sin(k.shedS), cs = Math.cos(k.shedS);
    rockStep(k, dt, SP.flutter.rockDrive * flut * sn, SP.flutter.rockDrive * flut * cs);
    slotSpringStep(k, t, dt);

    // Flex: impact ring-down just after touchdown, flutter while spinning, light wind otherwise.
    if (t - k.touchT < 0.4) flexStep(k, dt, CT.flexKick.omega, CT.flexKick.zeta, 0);
    else if (spinning) flexStep(k, dt, SP.flutter.flexOmega, SP.flutter.flexZeta, SP.flutter.flexDrive * flut * sn);
    else flexStep(k, dt, ID.flex.omega, ID.flex.zeta, ID.flex.gain * wv[1] * ID.flex.omega);

    // Idle air layer.
    const calm = this.g.idleT >= 0 ? smoothstep(this.g.idleT, this.g.idleT + ID.rampIn, t) : 0;
    const edgeK = k.restT >= 0 ? smoothstep(k.restT, k.restT + ID.edgeLift.rampIn, t) : 0;
    const cy = Math.cos(k.yaw), sy = Math.sin(k.yaw);
    const lx = [cy, -sy], lz = [sy, cy];
    let shear = 0;
    if (calm > 0) {
      this.wind.sample(k.px - sy * HH, k.py + ID.sampleHeight, k.pz - cy * HH, wa);
      this.wind.sample(k.px + sy * HH, k.py + ID.sampleHeight, k.pz + cy * HH, wb);
      shear = (wa[0] - wb[0]) * lx[0] + (wa[2] - wb[2]) * lx[1];
    }
    this.wind.gustsAt(k.px, k.pz, jv);
    airStep(k, dt, wv, bl * Math.hypot(jv[0], jv[1]), lx, lz, shear, calm, edgeK, wv[1]);
  }

  land(c, t) {
    const k = c.k;
    const vn = -k.hopv;
    const wasAir = k.airborne;
    let post;
    if (!k.dealDone) {
      const e = k.impacts < CT.restitution.length ? CT.restitution[k.impacts] : CT.tailRestitution;
      post = impact(k, vn, e, CT.absorbBelow);
      if (!post) k.dealDone = 1;
    } else {
      post = vn > SP.tap.minImpact ? impact(k, vn, SP.tap.restitution, 0) : impact(k, vn, 0, 1);
    }
    if (wasAir) {
      const air = t - k.hopStartT;
      k.nHops += 1;
      if (k.nHops === 1) { k.hop1 = k.hopPeak; k.air1 = air; }
      if (k.nHops === 2) { k.hop2 = k.hopPeak; k.air2 = air; }
      this.emit('bounce', c, { hop: k.nHops, peakCm: k.hopPeak, vImp: vn, airtime: air });
    }
    this.startHop(k, t);
  }

  // Composed pose of every card from its layers.
  compose(t) {
    for (const c of this.cards) {
      const k = c.k;
      if (k.phase === CP.queued) {
        k.px = c.plan.L[0]; k.py = c.plan.L[1]; k.pz = c.plan.L[2];
        k.yaw = c.plan.yawSlot + c.plan.dYaw; k.pitch = CONFIG.flight.launch.pitchDeg * DEG; k.roll = Math.PI * c.plan.turns; k.beta = c.plan.beta;
      } else if (k.phase !== CP.flight) {
        k.yaw = k.tyaw + k.eyaw + k.ay + k.ylag;
        k.pitch = k.rp + k.lp;
        k.roll = k.rr + k.lr + k.bank;
        k.beta = 0;
      }
      k.curlL = c.curl.long * (1 + k.cb) + k.flex;
      k.curlT = c.curl.lat;
      k.twist = c.curl.twist;
      cardBasis(k.yaw, k.pitch, k.roll, k.beta, basis);
      k.faceUp = basis[4];
      // Heights are measured from the card's support (felt plus its stacking layer) to its underside.
      const lift = contactGeometry(basis[1], basis[4], basis[7], k.curlL, k.curlT, k.twist, geo);
      let base;
      if (k.phase === CP.queued || k.phase === CP.flight) {
        base = k.py - k.support - lift;
      } else {
        const ox = k.px, oy = k.py, oz = k.pz;
        base = Math.max(k.hop, 0) + k.cu;
        k.px = k.tx + k.ex + k.ax;
        k.pz = k.tz + k.ez + k.az;
        k.py = k.support + base + lift;
        if (t > 0) { k.vx = (k.px - ox) / this.dt; k.vy = (k.py - oy) / this.dt; k.vz = (k.pz - oz) / this.dt; }
      }
      k.minH = base + geo.min - geo.soft;
      k.centreH = base + geo.centre - geo.soft;
      if (k.airborne) k.hopPeak = Math.max(k.hopPeak, k.centreH - c.restCentre);
    }
  }

  swirls() {
    const out = [];
    for (const c of this.cards) {
      const k = c.k;
      if (k.phase !== CP.flight || Math.abs(k.flipRate) < CONFIG.dust.swirl.minRate) continue;
      cardBasis(k.yaw, k.pitch, k.roll, k.beta, basis);
      out.push({ x: k.px, y: k.py, z: k.pz, ax: basis[6], ay: basis[7], az: basis[8], rate: k.flipRate });
    }
    return out;
  }

  // Events that need the composed pose: edges of the flip, view entry, rest and settle.
  detect(t, dt) {
    for (const c of this.cards) {
      const k = c.k;
      if (k.phase === CP.flight) {
        if (k.faceUp * k.lastFaceUp <= 0 && k.faceUp !== k.lastFaceUp) {
          this.emit('flip-edge', c, { faceUp: k.faceUp, pos: [k.px, k.py, k.pz] });
        }
        k.lastFaceUp = k.faceUp;
        if (!k.flipDone && Math.abs(k.flipRoll) < 2 * DEG && k.faceUp > 0.98) {
          k.flipDone = 1;
          this.emit('flip-done', c, { faceUp: k.faceUp });
        }
        if (!k.entered && this.projector && screenOf(this.projector, k).visible) {
          k.entered = 1;
          this.emit('enter-view', c);
        }
        continue;
      }
      if (k.phase === CP.queued) continue;
      if (k.phase === CP.contact) {
        tiltGeometry(k.rp, k.rr, k.curlL, k.curlT, k.twist, geo);
        tiltGeometry(0, 0, k.curlL, k.curlT, k.twist, flatGeo);
        if (restCheck(k, geo, flatGeo)) {
          k.restT = t;
          k.phase = CP.settling;
          this.emit('rest', c);
        }
      }
      if (k.dealSettledT < 0 && k.touchT >= 0 && slotSettled(k, dt)) k.dealSettledT = t;
      const quiet = k.restT >= 0 && k.dealSettledT >= 0 && !k.spinning && k.resting && Math.abs(k.bank) < 0.2 * DEG;
      if (quiet && !k.settled) {
        k.settled = 1; k.settledT = t; k.phase = CP.rest;
        this.emit('settled', c);
      } else if (!quiet && k.settled && k.spinning) {
        k.settled = 0; k.phase = CP.spin;
      } else if (k.phase === CP.spin && !k.spinning) {
        k.phase = CP.settling;
      }
    }
  }

  updatePhase(t) {
    const g = this.g, L = this.leader;
    let ph;
    if (t < TL.powerOn[1]) ph = 'boot';
    else if (!this.reduced && !g.closingStarted) ph = 'deal';
    else if (!this.reduced && !g.closingDone) {
      const allSettled = this.cards.every((c) => Math.abs(c.k.s) >= CONFIG.camera.wrapS || c.k.settled);
      if (L.k.mode === MODE.idle && allSettled) g.closingDone = 1;
      ph = g.closingDone ? 'idle' : (L.k.mode === MODE.closing || L.k.mode === MODE.idle ? 'closing' : null);
    }
    if (!ph) ph = { drag: 'drag', glide: 'glide', snap: 'snap', step: 'step', pad: 'step' }[MODE_NAMES[L.k.mode]] || 'idle';
    if (ph === 'idle' && g.idleT < 0) g.idleT = t;
    g.phase = PH[ph];
  }

  // ------------------------------------------------------------------ snapshots

  snapshotSize() {
    return WORLD_KEYS.length + this.cards.length * CARD_KEYS.length + this.leader.snapshotSize()
      + this.wind.snapshotSize() + (this.dust ? this.dust.snapshotSize() : 0);
  }

  snapshot() {
    const buf = new Float64Array(this.snapshotSize());
    let o = 0;
    for (const key of WORLD_KEYS) buf[o++] = this.g[key];
    for (const c of this.cards) for (const key of CARD_KEYS) buf[o++] = c.k[key];
    o = this.leader.writeSnapshot(buf, o);
    o = this.wind.writeSnapshot(buf, o);
    if (this.dust) this.dust.writeSnapshot(buf, o);
    return buf;
  }

  restore(buf) {
    let o = 0;
    for (const key of WORLD_KEYS) this.g[key] = buf[o++];
    for (const c of this.cards) for (const key of CARD_KEYS) c.k[key] = buf[o++];
    o = this.leader.readSnapshot(buf, o);
    o = this.wind.readSnapshot(buf, o);
    if (this.dust) this.dust.readSnapshot(buf, o);
    const n = this.g.n;
    this.events = this.events.filter((e) => e.step <= n);
    this.cursor = 0;
    while (this.cursor < this.log.length && this.log[this.cursor].step <= n) this.cursor++;
    return this;
  }

  // A detached copy with the same options, state and input log.
  clone() {
    const w = new World(this.opts);
    w.log = this.log.map((c) => ({ ...c }));
    w.projector = this.projector;
    w.events = this.events.slice();
    w.restore(this.snapshot());
    return w;
  }

  // ------------------------------------------------------------------ API views

  cardState(c) {
    const k = c.k;
    cardBasis(k.yaw, k.pitch, k.roll, k.beta, basis);
    const q = quatFromBasis(basis, [0, 0, 0, 1]);
    const ux = c.plan.ux, uz = c.plan.uz;
    const ex = k.ex + k.ax, ez = k.ez + k.az;
    return {
      id: c.id, rank: c.rank, title: c.title, index: c.index, s: k.s, restS: c.restS,
      phase: CARD_PHASES[k.phase], opacity: k.opacity,
      pos: [k.px, k.py, k.pz], quat: q,
      euler: { yaw: k.yaw / DEG, pitch: k.pitch / DEG, roll: k.roll / DEG },
      vel: [k.vx, k.vy, k.vz], speed: Math.hypot(k.vx, k.vy, k.vz),
      centreH: k.centreH, minCornerH: k.minH, faceUp: k.faceUp, flipDeg: k.flipRoll / DEG,
      flex: { curl: k.curlL, flex: k.flex, twist: k.twist, dogEarDeg: (c.dogEar ? c.dogEar.liftDeg : 0) + k.dog / DEG },
      hops: [k.hop1, k.hop2].slice(0, Math.min(k.nHops, 2)),
      touchdownAt: k.touchT >= 0 ? k.touchT : null,
      restAt: k.restT >= 0 ? k.restT : null,
      settledAt: k.settledT >= 0 ? k.settledT : null,
      dealSettledAt: k.dealSettledT >= 0 ? k.dealSettledT : null,
      slotErrCm: ex * ux + ez * uz,
      yawErrDeg: (k.eyaw + k.ay) / DEG,
      hoverCm: Math.max(k.hop, 0),
      bankDeg: k.bank / DEG,
      wanderCm: k.wander, flutterRollDeg: k.flutterPeak / DEG, peakFlightCm: k.peakY,
    };
  }

  state() {
    const L = this.leader.k;
    return {
      t: this.t, step: this.g.n, phase: this.phase,
      fan: { phi: L.phi, phiDot: L.phiDot, target: L.target, mode: MODE_NAMES[L.mode] },
      wind: { base: this.wind.base(this.t, [0, 0, 0]), gusts: this.wind.activeGusts(), jet: this.wind.jet },
      cards: this.cards.map((c) => this.cardState(c)),
    };
  }
}
