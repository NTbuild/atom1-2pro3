// Debug tooling: the headless §15 deal checks (pure, Node-safe) and, under ?debug, window.__deal,
// the HUD and the wind arrows.

import { CONFIG } from './config.js';
import { DEG } from './math.js';
import { World, CARD_PHASES } from './sim.js';
import { tiltGeometry } from './contact.js';
import { dragScript, dragGrab, WheelClassifier } from './input.js';
import { fitCamera, projector, slotPx, ndcToPlane, screenOf } from './fan.js';

const HZ = CONFIG.sim.hz;
const TL = CONFIG.timeline;

// ------------------------------------------------------------------ §15 deal checks 1-6 (headless)

// §15 measures on-screen numbers on the 1440 x 900 page (a 1371 x 853 screen); the motion itself does
// not depend on the viewport, so the checks use that reference screen unless told otherwise.
const REF_W = 1371, REF_H = 853;
export const referenceProjector = () => projector(fitCamera(REF_W / REF_H), REF_W, REF_H);
const pp = new Float64Array(3);

const inBand = (v, [a, b]) => v >= a && v <= b;
const SPEC = {
  hop1: [0.9, 1.4], air1: [0.15, 0.20], hop2: [0.28, 0.50], air2: [0.08, 0.12], ratio: [0.25, 0.45],
  overshoot: [0.35, 0.70], yawOver: [1, 3], wander: [0.5, 1.6], flutter: [8, 17], peak: [4.5, 7.5],
  hop1Px: 20, hop2Px: 6, settleBy: 1.4, airborneCm: 0.03, airborneMin: 0.04, liftAfter: 0.05,
  jumpCm: 1.0, dvJump: 15, edgeY: 0.14, faceDown: -0.95, faceUp: 0.98, edgeOn: 0.1,
  throwTol: 0.03, interactiveAt: 3.5, phiTol: 0.005, settledBy: 4.8, wanderStd: 0.2,
};
const SPEC_THROWS = TL.throws;

// Runs a fresh deal for the given World options and returns {ok, failures, metrics}.
export function verifyDeal(opts, proj = referenceProjector(), until = 6) {
  const w = new World(opts);
  w.projector = proj;
  const steps = Math.round(until * HZ);
  const restGeo = { corners: new Float64Array(4), mids: new Float64Array(4) };
  const per = w.cards.map((c) => {
    tiltGeometry(0, 0, c.curl.long, c.curl.lat, c.curl.twist, restGeo);
    return {
      c, faceAtThrow: null, faceFailT: null, edgeFails: [], intervals: [], airStart: null, airPeak: 0,
      maxProg: -Infinity, crossBack: false, yawOver: 0, minH: Infinity, jump: 0, dvFail: null,
      liftAfter: 0, restCentre: restGeo.centre - restGeo.soft, prev: null, prevV: null,
    };
  });
  const evAt = (type, id) => w.events.filter((e) => e.type === type && e.card === id).map((e) => e.t);

  for (let n = 0; n < steps; n++) {
    w.stepOnce();
    const t = w.t;
    for (const r of per) {
      const k = r.c.k, plan = r.c.plan;
      if (k.phase === 0) continue;
      if (r.faceAtThrow === null) r.faceAtThrow = k.faceUp;
      const touch = plan.tThrow + plan.Tf;
      const scr = screenOf(proj, k);
      if (k.touchT >= 0) {
        // Slot-relative progress and yaw: unaffected by the closing gust moving the slot itself.
        const prog = k.ex * plan.ux + k.ez * plan.uz;
        if (prog > r.maxProg) r.maxProg = prog;
        if (r.maxProg > 0 && prog < 0) r.crossBack = true;
        r.yawOver = Math.max(r.yawOver, -Math.sign(plan.dYaw) * k.eyaw / DEG);
      }
      if (t < TL.closingGust) {
        if (t >= touch - 0.10 && k.faceUp <= SPEC.faceUp && r.faceFailT === null) r.faceFailT = t;
        if (Math.abs(k.faceUp) < SPEC.edgeOn && (!scr.visible || scr.y < SPEC.edgeY * proj.h)) r.edgeFails.push([t, scr.y / proj.h]);
        r.minH = Math.min(r.minH, k.minH);
        if (r.prev) {
          r.jump = Math.max(r.jump, Math.hypot(k.px - r.prev[0], k.py - r.prev[1], k.pz - r.prev[2]));
          const dv = Math.hypot(k.vx - r.prevV[0], k.vy - r.prevV[1], k.vz - r.prevV[2]);
          const nearEvent = w.events.some((e) => e.card === r.c.id && (e.type === 'touchdown' || e.type === 'bounce') && Math.abs(e.t - t) < 3 / HZ);
          if (dv > SPEC.dvJump && !nearEvent && r.dvFail === null) r.dvFail = { t, dv };
        }
        r.prev = [k.px, k.py, k.pz]; r.prevV = [k.vx, k.vy, k.vz];
        if (k.touchT >= 0) {
          // Airborne intervals: every contact point above 0.03 cm.
          const air = k.minH > SPEC.airborneCm;
          if (air && r.airStart === null) { r.airStart = t; r.airPeak = 0; r.airPx = 0; }
          if (air) {
            const rise = k.centreH - r.restCentre;
            r.airPeak = Math.max(r.airPeak, rise);
            proj.project(k.px, k.py - rise, k.pz, pp);
            r.airPx = Math.max(r.airPx, pp[1] - scr.y);
          }
          if (!air && r.airStart !== null) {
            if (t - r.airStart >= SPEC.airborneMin) r.intervals.push({ t0: r.airStart, dur: t - r.airStart, peak: r.airPeak, px: r.airPx });
            r.airStart = null;
          }
          const third = evAt('bounce', r.c.id).find((_, i) => i === 1);
          if (third !== undefined && t > third + 1 / HZ) r.liftAfter = Math.max(r.liftAfter, k.minH);
        }
      }
    }
  }

  const failures = [];
  const fail = (crit, card, msg) => failures.push(`${crit} ${card}: ${msg}`);
  const metrics = [];
  for (const r of per) {
    const c = r.c, k = c.k, plan = c.plan, id = c.rank;
    const touch = plan.tThrow + plan.Tf;
    const m = { id, throw: plan.tThrow, touch, Tf: plan.Tf };
    // 1. Flip
    if (!(r.faceAtThrow < SPEC.faceDown)) fail(1, id, `faceUp at throw ${r.faceAtThrow.toFixed(3)}`);
    if (r.faceFailT !== null) fail(1, id, `faceUp <= ${SPEC.faceUp} at t=${r.faceFailT.toFixed(3)} (touch ${touch.toFixed(3)})`);
    if (r.edgeFails.length) fail(1, id, `edge-on at t=${r.edgeFails[0][0].toFixed(3)} screenY ${r.edgeFails[0][1].toFixed(3)}`);
    // 2. Bounces
    const iv = r.intervals;
    m.hops = iv.map((x) => +x.peak.toFixed(3)); m.air = iv.map((x) => +x.dur.toFixed(3));
    if (iv.length !== 2) fail(2, id, `${iv.length} airborne intervals`);
    else {
      const [h1, h2] = iv;
      if (!inBand(h1.peak, SPEC.hop1)) fail(2, id, `hop1 ${h1.peak.toFixed(3)}`);
      if (!inBand(h1.dur, SPEC.air1)) fail(2, id, `airtime1 ${h1.dur.toFixed(3)}`);
      if (!inBand(h2.peak, SPEC.hop2)) fail(2, id, `hop2 ${h2.peak.toFixed(3)}`);
      if (!inBand(h2.dur, SPEC.air2)) fail(2, id, `airtime2 ${h2.dur.toFixed(3)}`);
      if (!inBand(h2.peak / h1.peak, SPEC.ratio)) fail(2, id, `hop ratio ${(h2.peak / h1.peak).toFixed(3)}`);
      m.hopPx = [h1.px, h2.px].map((v) => +v.toFixed(1));
      if (h1.px < SPEC.hop1Px || h2.px < SPEC.hop2Px) fail(2, id, `hop px ${m.hopPx}`);
    }
    if (r.liftAfter > SPEC.liftAfter) fail(2, id, `lift ${r.liftAfter.toFixed(3)} after the third impact`);
    // 3. Elastic settle
    m.overshoot = +r.maxProg.toFixed(3); m.yawOver = +r.yawOver.toFixed(2);
    m.settle = k.dealSettledT >= 0 ? +(k.dealSettledT - touch).toFixed(3) : null;
    if (!inBand(r.maxProg, SPEC.overshoot)) fail(3, id, `overshoot ${r.maxProg.toFixed(3)}`);
    if (!r.crossBack) fail(3, id, 'no return crossing');
    if (!inBand(r.yawOver, SPEC.yawOver)) fail(3, id, `yaw overshoot ${r.yawOver.toFixed(2)}`);
    if (m.settle === null || m.settle > SPEC.settleBy) fail(3, id, `settled ${m.settle}`);
    // 4. Sanity
    m.peakY = +k.peakY.toFixed(2);
    if (r.minH < -0.01) fail(4, id, `minCornerH ${r.minH.toFixed(3)}`);
    if (r.jump > SPEC.jumpCm) fail(4, id, `jump ${r.jump.toFixed(3)}`);
    if (r.dvFail) fail(4, id, `velocity jump ${r.dvFail.dv.toFixed(1)} at ${r.dvFail.t.toFixed(3)}`);
    if (!inBand(k.peakY, SPEC.peak)) fail(4, id, `peak height ${k.peakY.toFixed(2)}`);
    // 5. Organic
    m.wander = +k.wander.toFixed(3); m.flutter = +(k.flutterPeak / DEG).toFixed(2);
    if (!inBand(k.wander, SPEC.wander)) fail(5, id, `wander ${k.wander.toFixed(3)}`);
    if (!inBand(k.flutterPeak / DEG, SPEC.flutter)) fail(5, id, `flutter roll ${(k.flutterPeak / DEG).toFixed(2)}`);
    // 6. Throw time
    if (Math.abs(plan.tThrow - SPEC_THROWS[c.index]) > SPEC.throwTol) fail(6, id, `throw ${plan.tThrow.toFixed(3)}`);
    metrics.push(m);
  }
  const wanders = per.map((r) => r.c.k.wander);
  const mean = wanders.reduce((a, b) => a + b, 0) / wanders.length;
  const std = Math.sqrt(wanders.reduce((a, b) => a + (b - mean) ** 2, 0) / wanders.length);
  if (std < SPEC.wanderStd) fail(5, 'all', `wander std ${std.toFixed(3)}`);

  // 6. Timeline after the closing gust.
  if (w.interactiveAt > SPEC.interactiveAt) fail(6, 'all', `interactiveAt ${w.interactiveAt}`);
  if (Math.abs(w.leader.phi - CONFIG.fan.restPhi) > SPEC.phiTol) fail(6, 'all', `phi ${w.leader.phi}`);
  const onFan = w.cards.filter((c) => Math.abs(c.k.s) < CONFIG.camera.wrapS).sort((a, b) => a.k.s - b.k.s);
  const ranks = onFan.map((c) => c.rank).join(' ');
  if (ranks !== '10 J Q K A') fail(6, 'all', `visible ranks ${ranks}`);
  const centre = w.cards.reduce((a, b) => (Math.abs(b.k.s) < Math.abs(a.k.s) ? b : a));
  if (centre.rank !== 'Q') fail(6, 'all', `centre ${centre.rank}`);
  const nine = w.cards[0];
  if (screenOf(proj, nine.k).visible) fail(6, '9', 'still visible');
  for (const c of onFan) {
    const s = w.events.filter((e) => e.type === 'settled' && e.card === c.id).pop();
    if (!s || s.t > SPEC.settledBy) fail(6, c.rank, `settled ${s ? s.t.toFixed(3) : 'never'}`);
  }
  return { ok: failures.length === 0, failures, metrics, wanderStd: std };
}

// ------------------------------------------------------------------ §15 idle and spin checks 6-11 (headless)

const SPIN = {
  closingSettled: 4.8, arrowLead: 0.06, arrowOvershoot: [0.08, 0.30], arrowHover: [0.3, 0.7], arrowSettle: 1.6,
  flickHover: [0.8, 1.4], flickTravel: [2, 4], flickSettle: 1.2, flickOvershoot: 0.35, flickStop: 0.1,
  dragPx: 4, dragSettle: 1.8, idleFrom: 5, idleTo: 15, slotErr: 0.2, yawErr: 4, centreH: 0.25,
  breathWindow: 8.5, breathLift: 0.03, dogEar: 1, moveCm: 0.001, bankDeg: 0.5, traceFrom: 4.6,
};
const ASPECTS = { '21:9': 21 / 9, '16:10': 16 / 10, '4:3': 4 / 3, '9:19.5': 9 / 19.5 };

const onFan = (w) => w.cards.filter((c) => Math.abs(c.k.s) < CONFIG.camera.wrapS);
const findCard = (w, id) => w.cards.find((c) => c.id === String(id).toLowerCase() || c.rank.toLowerCase() === String(id).toLowerCase());
const settledBy = (w, from, by) => onFan(w).every((c) => c.k.settled && c.k.settledT >= from - 1e-9 && c.k.settledT <= by + 1e-9);
const centreCard = (w) => w.cards.reduce((a, b) => (Math.abs(b.k.s) < Math.abs(a.k.s) ? b : a));
const runTo = (w, t) => { while (w.t < t - 1e-9) w.stepOnce(); return w; };

// The deal played to idle, ready for spin tests.
function idleWorld(opts, proj, t = 6) {
  const w = new World(opts);
  w.projector = proj;
  return runTo(w, t);
}

// ArrowRight from idle (criterion 8).
function checkArrow(base, fail, m) {
  const w = base.clone();
  const t0 = w.t, cards = onFan(w);
  const x0 = cards.map((c) => c.k.px), first = cards.map(() => 0), firstT = cards.map(() => null);
  const peak = cards.map(() => -Infinity), peakT = cards.map(() => 0), hover = cards.map(() => 0);
  w.input({ type: 'key', dir: 1 });
  const target = Math.round(w.leader.phi) + 1;
  while (w.t < t0 + SPIN.arrowSettle + 0.5) {
    w.stepOnce();
    cards.forEach((c, i) => {
      const dx = c.k.px - x0[i];
      if (!first[i] && Math.abs(dx) > SPIN.moveCm) { first[i] = Math.sign(dx); firstT[i] = w.t - t0; }
      if (c.k.phi - target > peak[i]) { peak[i] = c.k.phi - target; peakT[i] = w.t; }
      hover[i] = Math.max(hover[i], c.k.hop);
    });
  }
  m.arrow = { overshoot: peak.map((v) => +v.toFixed(3)), hover: hover.map((v) => +v.toFixed(2)), firstT: firstT.map((v) => v && +v.toFixed(3)) };
  if (first.some((d) => d !== -1)) fail(8, 'first move not leftward');
  const lead = cards.reduce((a, b, i) => (b.k.px > cards[a].k.px ? i : a), 0);
  if (!(firstT[lead] <= SPIN.arrowLead)) fail(8, `upwind card moved after ${firstT[lead]}`);
  peak.forEach((p, i) => { if (p < SPIN.arrowOvershoot[0] || p > SPIN.arrowOvershoot[1]) fail(8, `${cards[i].rank} overshoot ${p.toFixed(3)}`); });
  const order = cards.map((c, i) => [x0[i], peakT[i]]).sort((a, b) => b[0] - a[0]);
  if (order.some((o, i) => i && o[1] < order[i - 1][1])) fail(8, 'overshoot peaks not ordered from the upwind end');
  hover.forEach((h, i) => { if (h < SPIN.arrowHover[0] || h > SPIN.arrowHover[1]) fail(8, `${cards[i].rank} hover ${h.toFixed(2)}`); });
  if (w.leader.phi !== target) fail(8, `phi ${w.leader.phi}`);
  if (centreCard(w).rank !== 'K') fail(8, `centre ${centreCard(w).rank}`);
  if (!settledBy(w, t0, t0 + SPIN.arrowSettle)) fail(8, `not settled by ${SPIN.arrowSettle}s: ${onFan(w).map((c) => c.rank + '@' + (c.k.settledT - t0).toFixed(2)).join(' ')}`);
}

// flick(8) from idle (criterion 9).
function checkFlick(base, fail, m) {
  const w = base.clone();
  const t0 = w.t, phi0 = w.leader.phi;
  let hover = 0, slowT = null, flip = false;
  const firstBank = new Map(), sawNeg = new Set(), over = new Map();
  w.input({ type: 'flick', rate: 8 });
  while (w.t < t0 + 4) {
    w.stepOnce();
    const L = w.leader.k;
    if (slowT === null && w.t > t0 + 0.05 && Math.abs(L.phiDot) < SPIN.flickStop) slowT = w.t;
    for (const c of onFan(w)) {
      hover = Math.max(hover, c.k.hop);
      const b = c.k.bank / DEG;
      if (!firstBank.has(c.id) && Math.abs(b) > 1) firstBank.set(c.id, Math.sign(b));
      if (b < -SPIN.bankDeg) sawNeg.add(c.id);
      if (sawNeg.has(c.id) && b > SPIN.bankDeg) flip = true;
      if (L.mode === 1 || L.mode === 0) over.set(c.id, Math.max(over.get(c.id) ?? -Infinity, c.k.phi - L.target));
    }
  }
  const travel = w.leader.phi - phi0;
  m.flick = { hover: +hover.toFixed(2), travel, slowT: slowT && +(slowT - t0).toFixed(2), overshoot: [...over.values()].map((v) => +v.toFixed(3)) };
  if (hover < SPIN.flickHover[0] || hover > SPIN.flickHover[1]) fail(9, `hover ${hover.toFixed(2)}`);
  if ([...firstBank.values()].some((sgn) => sgn !== -1)) fail(9, 'bank sign does not match the push');
  if (!flip) fail(9, 'no trailing-edge-up bank flip');
  if (travel < SPIN.flickTravel[0] || travel > SPIN.flickTravel[1]) fail(9, `travel ${travel}`);
  if (slowT === null || !settledBy(w, t0, slowT + SPIN.flickSettle)) fail(9, `not settled 1.2s after slow-down: ${onFan(w).map((c) => c.rank + '@' + (c.k.settledT - (slowT ?? 0)).toFixed(2)).join(' ')}`);
  for (const [id, o] of over) if (o > SPIN.flickOvershoot) fail(9, `${id} overshoot ${o.toFixed(3)}`);
}

// A 1.2-slot drag over 0.18 s (criterion 10): the grabbed card stays under the pointer.
function checkDrag(base, proj, fail, m) {
  const w = base.clone();
  const t0 = w.t, card = centreCard(w), px = slotPx(proj);
  const x0 = proj.w / 2, held = x0 - screenOf(proj, card.k).x;
  const script = dragScript(proj, w.g.n + 1, x0, -1.2 * px, Math.round(0.18 * HZ), dragGrab(proj, card, x0), 0);
  script.forEach((c) => w.input(c));
  let worst = 0;
  for (const c of script) {
    while (w.g.n < c.step) w.stepOnce();
    if (c.type === 'move') worst = Math.max(worst, Math.abs(screenOf(proj, card.k).x + held - c.x));
  }
  runTo(w, t0 + SPIN.dragSettle + 0.2);
  const landed = w.events.find((e) => e.type === 'snap' && e.t > t0);
  m.drag = { worstPx: +worst.toFixed(2), landed: landed && +(landed.t - t0).toFixed(2) };
  if (worst > SPIN.dragPx) fail(10, `grabbed card ${worst.toFixed(1)} px from the pointer`);
  if (!landed || landed.t - t0 > SPIN.dragSettle || !Number.isInteger(w.leader.phi)) fail(10, `phi ${w.leader.phi} landed ${landed && landed.t - t0}`);
}

// Idle from 5 to 15 s (criterion 7) and the closing settle (criterion 6).
function checkIdle(opts, proj, fail, m) {
  const w = new World(opts);
  w.projector = proj;
  let maxErr = 0, maxYaw = 0, maxH = 0, dogMin = Infinity, dogMax = -Infinity;
  const ace = w.cards.find((c) => c.dogEar);
  const breaths = [];
  const traces = new Map();
  while (w.t < SPIN.idleTo) {
    w.stepOnce();
    if (w.t < SPIN.traceFrom) continue;
    for (const c of w.cards) {
      if (Math.abs(c.k.s) < CONFIG.camera.wrapS) {
        const tr = traces.get(c.id) || traces.set(c.id, []).get(c.id);
        tr.push([w.t, c.k.minH, c.k.px, c.k.pz]);
      }
      if (w.t < SPIN.idleFrom) continue;
      const st = w.cardState(c);
      maxErr = Math.max(maxErr, Math.abs(st.slotErrCm));
      maxYaw = Math.max(maxYaw, Math.abs(st.yawErrDeg));
      maxH = Math.max(maxH, st.centreH);
    }
    if (ace && w.t >= SPIN.idleFrom) { const d = ace.k.dog / DEG; dogMin = Math.min(dogMin, d); dogMax = Math.max(dogMax, d); }
  }
  for (const e of w.events) if (e.type === 'breath') breaths.push(e);
  m.idle = { maxSlotErr: +maxErr.toFixed(3), maxYawErr: +maxYaw.toFixed(2), maxCentreH: +maxH.toFixed(3), dogRange: +(dogMax - dogMin).toFixed(2), breaths: breaths.map((b) => +b.t.toFixed(2)) };
  if (maxErr > SPIN.slotErr) fail(7, `slotErr ${maxErr.toFixed(3)}`);
  if (maxYaw > SPIN.yawErr) fail(7, `yawErr ${maxYaw.toFixed(2)}`);
  if (maxH > SPIN.centreH) fail(7, `centreH ${maxH.toFixed(3)}`);
  if (ace && dogMax - dogMin < SPIN.dogEar) fail(7, `dog-ear range ${(dogMax - dogMin).toFixed(2)}`);
  const marks = [SPIN.idleFrom, ...breaths.map((b) => b.t).filter((t) => t >= SPIN.idleFrom), SPIN.idleTo];
  if (marks.some((t, i) => i && t - marks[i - 1] > SPIN.breathWindow)) fail(7, `breath gap > ${SPIN.breathWindow}s: ${marks.map((t) => t.toFixed(2))}`);
  m.idle.lift = [];
  for (const b of breaths) {
    const life = CONFIG.wind.breath.life;
    if (b.t + life > SPIN.idleTo) continue;
    const peaks = [];
    for (const [id, tr] of traces) {
      const base = tr.filter((p) => p[0] < b.t && p[0] > b.t - 0.3);
      const win = tr.filter((p) => p[0] >= b.t && p[0] <= b.t + life);
      if (!base.length || !win.length) continue;
      const b0 = Math.min(...base.map((p) => p[1]));
      const top = win.reduce((a, p) => (p[1] > a[1] ? p : a));
      peaks.push({ id, lift: top[1] - b0, t: top[0], along: top[2] * b.data.dir[0] + top[3] * b.data.dir[1] });
    }
    m.idle.lift.push(peaks.map((p) => `${p.id}:${p.lift.toFixed(3)}@${p.t.toFixed(2)}`).join(' '));
    for (const p of peaks) if (p.lift < SPIN.breathLift) fail(7, `breath ${b.data.k} lift ${p.id} ${p.lift.toFixed(3)}`);
    const order = peaks.slice().sort((a, b2) => a.along - b2.along);
    if (order.some((p, i) => i && p.t < order[i - 1].t)) fail(7, `breath ${b.data.k} peaks not ordered along the breath`);
  }
  // Criterion 6: closing settle.
  const late = onFan(w).filter((c) => {
    const s = w.events.filter((e) => e.type === 'settled' && e.card === c.id && e.t >= TL.closingGust).shift();
    return !s || s.t > SPIN.closingSettled;
  });
  m.idle.idleAt = +w.g.idleT.toFixed(3);
  if (late.length) fail(6, `not settled by ${SPIN.closingSettled}: ${late.map((c) => c.rank).join(' ')}`);
  if (!(w.g.idleT > 0 && w.g.idleT <= SPIN.closingSettled)) fail(6, `phase idle at ${w.g.idleT}`);
}

// Wrap seam stays off-screen at every aspect, through the deal and a flick(9) (criterion 11).
function checkWrap(base, fail) {
  const w = base.clone();
  w.input({ type: 'flick', rate: 9 });
  const projs = Object.entries(ASPECTS).map(([name, a]) => {
    const [w2, h2] = a >= 1 ? [1000, 1000 / a] : [1000 * a, 1000];
    return [name, projector(fitCamera(a), w2, h2)];
  });
  const seen = new Set();
  const t0 = w.t;
  while (w.t < t0 + 3) {
    w.stepOnce();
    for (const c of w.cards) {
      if (Math.abs(c.k.s) < CONFIG.camera.wrapS) continue;
      for (const [name, p] of projs) if (screenOf(p, c.k).visible) seen.add(`${c.rank}@${name}`);
    }
  }
  if (seen.size) fail(11, `visible across the seam: ${[...seen].join(' ')}`);
}

// Criteria 6-11 for one seed. Returns {ok, failures, metrics}.
export function verifySpin(opts, proj = referenceProjector()) {
  const failures = [];
  const fail = (crit, msg) => failures.push(`${crit} ${msg}`);
  const m = {};
  checkIdle(opts, proj, fail, m);
  const base = idleWorld(opts, proj);
  checkArrow(base, fail, m);
  checkFlick(base, fail, m);
  checkDrag(base, proj, fail, m);
  checkWrap(base, fail);
  return { ok: failures.length === 0, failures, metrics: m };
}

// ------------------------------------------------------------------ window.__deal (browser, ?debug)

const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
};
const round5 = (_, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

export async function installDebug({ world, view, clock, flags }) {
  const THREE = await import('../vendor/three.module.min.js');
  const D = CONFIG.debug;
  const every = Math.round(CONFIG.sim.snapshotEvery * HZ);
  const snaps = new Map([[world.g.n, world.snapshot()]]);
  const record = () => {
    if (world.g.n % every === 0 && !snaps.has(world.g.n) && snaps.size < CONFIG.sim.snapshotCap) snaps.set(world.g.n, world.snapshot());
  };
  const opts = world.opts;
  const proj = () => view.proj;

  // Silent pre-simulation for the timeline (dust never feeds back, so it is left out).
  const pre = new World({ ...opts, dust: false });
  pre.step(Math.round(CONFIG.sim.preSimSec * HZ));
  const at = (type) => pre.events.filter((e) => e.type === type).map((e) => ({ id: e.card, t: e.t }));
  const timeline = {
    powerOn: TL.powerOn, lampOn: TL.lampOn, dealerGust: CONFIG.wind.base.dealerRamp[0],
    throws: at('throw'), touch: at('touchdown'), rest: at('rest'), settled: at('settled'),
    closingGust: at('closing-gust')[0]?.t ?? null, interactiveAt: pre.interactiveAt, dealEnd: pre.g.idleT,
  };

  const withScreen = (c) => {
    const st = world.cardState(c);
    const k = c.k;
    st.screen = screenOf(proj(), k);
    const h = st.pos[1] - k.support;
    const RS = CONFIG.render.shadow;
    st.shadow = { alpha: Math.max(RS.alphaMin, RS.alpha0 * (1 - RS.alphaH * h)), sigma: RS.sigma0 + RS.sigmaH * h };
    return st;
  };
  const state = () => ({ ...world.state(), cards: world.cards.map(withScreen) });

  // Restore the nearest snapshot at or before step n, then replay the input log up to n.
  function goto(n) {
    let best = -1;
    for (const s of snaps.keys()) if (s <= n && s > best) best = s;
    world.restore(snaps.get(best));
    while (world.g.n < n) { world.stepOnce(); record(); }
  }

  // A clone at time t (live state untouched).
  function cloneAt(t) {
    const n = Math.round(t * HZ);
    const w = new World(opts);
    w.log = world.log.map((c) => ({ ...c }));
    let best = -1;
    for (const s of snaps.keys()) if (s <= n && s > best) best = s;
    w.restore(snaps.get(best));
    while (w.g.n < n) w.stepOnce();
    return w;
  }

  const render = async () => { view.render(world, 0); await nextFrame(); };
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  const centreCard = () => world.cards.reduce((a, b) => (Math.abs(b.k.s) < Math.abs(a.k.s) ? b : a));

  const api = {
    version: CONFIG.version, seed: world.seed, simHz: HZ, dt: 1 / HZ,
    quality: view.perfStats().tier, reduced: world.reduced, config: CONFIG,
    ready,
    timeline: () => timeline,
    now: () => ({ t: world.t, step: world.g.n, phase: world.phase }),
    pause() { clock.paused = true; },
    play() { clock.paused = false; },
    isPaused: () => clock.paused,
    setRate(k) { clock.rate = k; },
    step(n = 1) {
      if (n >= 0) for (let i = 0; i < n; i++) { world.stepOnce(); record(); }
      else goto(Math.max(0, world.g.n + n));
      view.render(world, 0);
      return api.now();
    },
    async seek(t) { goto(Math.max(0, Math.round(t * HZ))); await render(); return state(); },
    render,
    state,
    card(id) { const c = findCard(world, id); return c ? withScreen(c) : null; },
    trace(id, t0, t1, dt = D.traceDt) {
      const w = cloneAt(t0);
      const c = findCard(w, id);
      const out = [];
      const stride = Math.max(1, Math.round(dt * HZ));
      for (;;) {
        const st = w.cardState(c);
        const sc = screenOf(proj(), c.k);
        out.push({
          t: w.t, pos: st.pos, quat: st.quat, euler: st.euler, centreH: st.centreH, minCornerH: st.minCornerH,
          phase: st.phase, faceUp: st.faceUp, flexCm: st.flex.flex, sx: sc.x, sy: sc.y, visible: sc.visible,
          s: st.s, slotErrCm: st.slotErrCm, yawErrDeg: st.yawErrDeg, hoverCm: st.hoverCm, bankDeg: st.bankDeg,
          dogEarDeg: st.flex.dogEarDeg,
        });
        if (w.t >= t1 - 1e-9) break;
        w.step(stride);
      }
      return out;
    },
    events: (type) => world.events.filter((e) => !type || e.type === type).map((e) => ({ ...e })),
    inputs: () => world.log.map((c) => ({ ...c })),
    replay(log) {
      const t = world.t;
      world.log = log.map((c) => ({ ...c }));
      for (const s of [...snaps.keys()]) if (s > 0) snaps.delete(s);
      goto(Math.round(t * HZ));
      view.render(world, 0);
      return api.now();
    },
    input: {
      drag(dxPx, dur = 0.2, { y } = {}) {
        const p = proj(), c = centreCard();
        const x0 = p.w / 2;
        const y0 = y ?? screenOf(p, c.k).y;
        const pick = view.pick(world, x0, y0);
        const card = world.cards[pick >= 0 ? pick : c.index];
        const xOrigin = ndcToPlane(p.cam, (x0 / p.w) * 2 - 1, 1 - (y0 / p.h) * 2, 0, [0, 0])[0];
        const script = dragScript(p, world.g.n + 1, x0, dxPx, Math.max(1, Math.round(dur * HZ)), dragGrab(p, card, x0), xOrigin);
        script.forEach((cmd) => world.input(cmd));
        return { from: script[0].step, to: script[script.length - 1].step, grab: card.id };
      },
      // Each scripted wheel event is a fresh gesture (no wall-clock gap to measure).
      wheel(deltaY, deltaX = 0, deltaMode = 0) {
        const c = new WheelClassifier().classify(deltaX, deltaY, deltaMode, 0);
        return c ? world.input(c) : null;
      },
      key(code) {
        const dir = code === 'ArrowRight' ? 1 : code === 'ArrowLeft' ? -1 : 0;
        return dir ? world.input({ type: 'key', dir }) : null;
      },
      flick(slotsPerSec) { return world.input({ type: 'flick', rate: slotsPerSec }); },
    },
    project: ([x, y, z]) => view.project(x, y, z),
    wind([x, y, z], t) {
      const w = t === undefined || Math.abs(t - world.t) < 1e-9 ? world : cloneAt(t);
      const out = w.wind.sample(x, y, z, new Float64Array(3));
      return [out[0], out[1], out[2]];
    },
    hash() {
      const { t: _t, step: _s, ...sim } = world.state();
      return fnv1a(JSON.stringify(sim, round5));
    },
    perf: () => view.perfStats(),
    get video() { return view.videoEl; },
    verify({ seed = world.seed, all = false } = {}) {
      const o = { ...opts, seed, dust: false };
      const deal = verifyDeal(o);
      const failures = [...deal.failures];
      let spin = null;
      if (all) { spin = verifySpin(o); failures.push(...spin.failures); }
      return { ok: failures.length === 0, failures, metrics: { deal: deal.metrics, spin: spin && spin.metrics } };
    },
  };
  window.__deal = api;

  const hud = createHud(api, world, clock, goto, render, record);
  const arrows = flags.windArrows ? createWindArrows(THREE, view, world) : null;

  return {
    seek(t) { goto(Math.max(0, Math.round(t * HZ))); },
    onStep() { record(); },
    onFrame() { hud.update(); arrows?.update(); },
    markReady() { view.cardsReady.then(nextFrame).then(() => readyResolve(state())); },
  };
}

function createHud(api, world, clock, goto, render, record) {
  const el = document.createElement('div');
  el.className = 'deal-hud';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;font:11px/1.35 ui-monospace,monospace;color:#cfe;'
    + 'background:#000a;padding:6px 8px;border-radius:6px;pointer-events:auto;min-width:260px';
  const text = document.createElement('div');
  const chips = document.createElement('div');
  const scrub = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 15, step: 0.01, value: 0 });
  scrub.style.width = '100%';
  scrub.addEventListener('input', () => { clock.paused = true; api.seek(Number(scrub.value)); });
  el.append(text, chips, scrub);
  document.body.append(el);
  const colours = { queued: '#555', flight: '#e3b031', contact: '#e36a31', settling: '#3fd0bd', rest: '#5bdc6a', spin: '#5b7cff' };
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const t = world.t;
    if (e.code === 'Space') { e.preventDefault(); clock.paused = !clock.paused; }
    else if (e.key === '.') { clock.paused = true; api.step(1); }
    else if (e.key === ',') { clock.paused = true; api.step(-1); }
    else if (e.key === ']') { clock.paused = true; api.seek(t + 0.1); }
    else if (e.key === '[') { clock.paused = true; api.seek(Math.max(0, t - 0.1)); }
    else if (e.key === 'r' || e.key === 'R') { goto(0); record(); render(); clock.paused = false; }
  });
  return {
    update() {
      const p = api.perf();
      text.textContent = `t ${world.t.toFixed(3)}  step ${world.g.n}  ${world.phase}  ${p.fps.toFixed(0)} fps${clock.paused ? '  [paused]' : ''}`;
      chips.innerHTML = world.cards.map((c) => {
        const ph = CARD_PHASES[c.k.phase];
        return `<span style="display:inline-block;margin:2px 3px 2px 0;padding:0 4px;border-radius:3px;background:${colours[ph]};color:#000">${c.rank} ${ph}</span>`;
      }).join('');
      if (document.activeElement !== scrub) {
        scrub.max = String(Math.max(15, Math.ceil(world.t)));
        scrub.value = String(world.t);
      }
    },
  };
}

// ?debug=wind: a grid of arrows at y = 1 cm showing W.
function createWindArrows(THREE, view, world) {
  const D = CONFIG.debug;
  const [nx, nz] = D.windGrid;
  const pos = new Float32Array(nx * nz * 3 * 2 * 3);       // shaft and two head strokes per arrow
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.8, depthTest: false }));
  lines.renderOrder = 90;
  lines.frustumCulled = false;
  view.scene.add(lines);
  const w = new Float64Array(3);
  const box = CONFIG.dust.box;
  return {
    update() {
      let o = 0;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const x = box.x[0] + (box.x[1] - box.x[0]) * (i + 0.5) / nx;
          const z = box.z[0] + (box.z[1] - box.z[0]) * (j + 0.5) / nz;
          world.wind.sample(x, D.windArrowY, z, w);
          const y = D.windArrowY, ex = x + w[0] * D.windArrowScale, ey = y + w[1] * D.windArrowScale, ez = z + w[2] * D.windArrowScale;
          // Head strokes: back from the tip, rotated +/-30 degrees in the felt plane.
          const hx = (x - ex) * D.windArrowHead, hz = (z - ez) * D.windArrowHead;
          const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
          pos.set([x, y, z, ex, ey, ez,
            ex, ey, ez, ex + c * hx - sn * hz, ey, ez + sn * hx + c * hz,
            ex, ey, ez, ex + c * hx + sn * hz, ey, ez - sn * hx + c * hz], o);
          o += 18;
        }
      }
      attr.needsUpdate = true;
    },
  };
}
