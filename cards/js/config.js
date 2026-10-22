// Every tunable number of the stage-1 deal lives here (units: cm, s, deg unless named otherwise).

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const CONFIG = deepFreeze({
  version: 'cards-stage1@1',
  seed: 7331,

  sim: {
    hz: 240,
    maxStepsPerFrame: 16,
    snapshotEvery: 0.25,      // s; a seek replays at most this much
    snapshotCap: 2400,        // 10 minutes of snapshots
    historySec: 0.5,          // leader history ring for the trailing cards
    preSimSec: 7,             // silent pre-simulation for __deal.timeline()
  },

  card: { w: 7.30, h: 8.89, thick: 0.05, corner: 0.10 },   // Polaroid 600 scaled to 8.89 cm tall

  fan: {
    pivotZ: 55, radius: 55, spacingDeg: 7.2,      // a long, flat arc: the row reads nearly straight from above
    edgeU0: 9, edgeThetaDeg: 14, edgeR: 18,    // no swing-away at the ends: an even chain right up to the wrap seam
    layerStep: 0.03, half: 4.5, wrapHysteresis: 0.05,   // nine cards: the wrap seam stays well off-screen
    dealPhi: 2.5, restPhi: 3.0,
    accordion: 0, accordionCap: 6,             // spacing never opens up with speed: the row moves as one chain
  },

  imperfection: { thetaDeg: 1.4, r: 0.3, tangential: 0.25, yawDeg: 1.8 },

  camera: {
    fovDeg: 30, fovNarrowDeg: 46, elevationDeg: 55, target: [0, 0, -1],
    fitSlot: 2, overscan: 0.02,          // outer corners of slots +/-2 sit 2% outside the edges
    bottomMargin: 0.16, maxShiftZ: 6,    // wide screens: the hand's lowest corner stays above the caption band
    narrowAspect: [0.7, 1.25],           // FOV and half-width ease toward the narrow fit across this range
    halfWidthNarrow: 10.8,
    wrapS: 4.3, wrapClearCm: 2,          // any card with |s| >= 4.3 (near the nine-card seam) stays this far off-screen
    near: 1, far: 400,
    parallax: { azDeg: 1.5, elDeg: 1.0, omega: 4, zeta: 1 },
    rise: { start: 2.6, duration: 1.6, elevationDeg: 28, distScale: 0.9, shiftZ: 2.5 },
  },

  timeline: {
    powerOn: [0, 0.2],
    lampOn: [0.0, 0.4],
    throws: [0.25, 0.45, 0.65, 0.85, 1.05, 1.17, 1.27, 0.3, 0.4],   // ring order: 9, 10, J, Q, K, A, then 8, 7, 6 (off-screen)
    throwJitter: 0.025,
    closingGust: 2.45,
    hurryScale: 2.5, hurryEase: 0.15,
    readyTimeout: 3.5,
    loadShare: 0.42,          // the loading counter reaches this while assets load; the deal counts the rest
    loadedAt: 2.6,            // s into the deal: 100 %, the hero settles into its panel
  },

  wind: {
    boundary: { floor: 0.35, height: 3 },        // BL(y) = floor + (1 - floor) smoothstep(0, height, y)
    curl: {
      scale: 14, octave2Scale: 1 / 2.3, octave2Amp: 0.45,
      deal: { amp: 9, freq: 0.35 }, idle: { amp: 2.2, freq: 0.12 }, ease: 1.5,
      normSamples: 4096,
    },
    vertical: { deal: 4, idle: 0.8, height: 2.5 },
    base: {
      idle: [-1.4, 0, 0.6],
      dealer: [0, 0, 9], dealerRamp: [0.1, 0.4], dealerFade: [2.1, 2.6],
    },
    maxGusts: 8,
    gustFade: [0.08, 0.75],                      // fade in until, fade out from (fractions of life)
    puff: { speedGain: 0.85, sigma: 7, sigmaPerp: 3, extraLife: 0.4 },
    squeeze: { amp: 14, sigma: 5, speed: 30, life: 0.35 },
    breath: {
      speed: 22, amp: 9, sigma: 8, sigmaPerp: 40, life: 2.5,
      spreadDeg: 30, every: [4.5, 8.5], first: 1.6, startDist: 30,
    },
    closing: { speed: 240, amp: 14, sigma: 12, sigmaPerp: 60, life: 1.2, startX: 25 },
    jet: { gain: 0.3, rise: 0.12, decay: 0.60, sigma: 7, radius: 30, keyImpulse: 0.6 },
  },

  aero: {
    K: 0.012, skin: 0.06, tauGain: 2.5, sideGain: 1.5, magnus: 0.32, grip: [0.7, 1.7],
    strouhal: 0.3, chord: 5,
    flutter: { omega: [13.8, 29.8], zeta: 0.18, drivePitch: 40, driveRoll: 95, vRef: 6, driveCap: 2, buildUp: 0.15, hardenDeg: 9.5 },
    ground: { g: 300, vRef: 17.5, height: 1.2, cap: 1.4 },
  },

  flight: {
    launch: { xGain: 0.55, jitter: 0.8, y: 1.8, z: -20, fadeIn: 0.12, pitchDeg: -10, yawOffsetDeg: [110, 200] },
    time: { base: 0.84, perCm: 0.004, jitter: 0.03, flourishExtra: 0.06 },
    touchdownBack: 2.6,
    yKeys: [[0, 1.8, 0], [0.32, 2.4, 6], [0.56, 5.4, 3], [0.80, 4.1, -5], [1.0, 0.62, -48]],   // tau, y cm, v_y cm/s
    vyJitter: 2,
    yaw: { omega: 6.5, zeta: 0.62, span: 0.955 },        // spring clock at touchdown (s)
    flip: { turns: 1, delay: 0.61, omega: 12.8, zeta: 0.74, axisTiltDeg: 12 },
    flourish: { id: 'a', turns: 3, delay: 0.61, omega: 20, zeta: 0.9 },
    pitch: { levelBy: 0.5, flare: [0.88, 1.0], flareDeg: 8 },
    tether: { omega0: 2.6, omega1: 13.4, zeta: 0.9, harden: 1.05, vertical: 2 },
    cushion: { clearance: 0.5, accel: 1500, damp: 30 },   // ground effect keeps the skimming card off the felt
    fade: [0.80, 0.98],
    flex: { omega: 2 * Math.PI * 7, zeta: 0.18, cmPerAccel: 0.003, cap: 0.3 },   // bend per cm/s^2 of face pressure
    dogEar: { omega: 2 * Math.PI * 4, zeta: 0.2, degPerCms: 0.1, capDeg: 12 },
  },

  contact: {
    g: 300, softK: 200,
    restitution: [0.54, 0.60], tailRestitution: 0.35, absorbBelow: 6,
    rock: { omega: 20, zeta: 0.28, kickPitch: 0.03, kickRoll: 0.015, capDeg: 14, absorbGrab: 0.65 },
    grab: 0.35,
    flexKick: { gain: 0.0006, omega: 2 * Math.PI * 9, zeta: 0.12 },
    slot: { omega: 10.5, zetaHop: 0.26, zetaRest: 0.45, ramp: 0.08 },
    yaw: { omega: 9, zeta: 0.36 },
    rest: { cornerTol: 0.03, steps: 24 },
    settle: { posTol: 0.02, yawTolDeg: 0.2, speedTol: 0.2, hold: 0.15, phiTol: 0.003, phiRateTol: 0.03 },
  },

  idle: {
    rampIn: 1.0,
    sampleHeight: 0.5,                    // the card feels the air this far above its surface
    drift: { omega: 3.0, zeta: 0.6, gain: 0.02, yawDegPerCms: 0.12 },
    cushion: { omega: 3.0, zeta: 0.7, gain: 0.008, cap: 0.12 },
    edgeLift: { degPerCms: 0.35, capDeg: 4, omega: 2 * Math.PI * 1.4, zeta: 0.45, rampIn: 0.3 },
    curlBreath: { amount: 0.25, ref: 3 },
    flex: { omega: 2 * Math.PI * 6, zeta: 0.3, gain: 0.02 },
    dogEar: { omega: 2 * Math.PI * 4, zeta: 0.2, degPerCms: 0.5, capDeg: 5, gust: 1.2 },
    capCm: 0.2, capDeg: 4,
  },

  spin: {
    drag: { emaKeep: 0.65, minDt: 0.008, maxRate: 9, stillHold: 0.09, flickMaxDisp: 0.5 },
    glide: { tau: 0.42, stopRate: 2.2, project: 0.42, maxAhead: 4 },
    wheel: {
      lineScale: 16, pageScale: 400, notchMin: 40, notchGap: 0.03, maxQueue: 3,
      padScale: 220, padOmega: 9, padZeta: 0.55, padSettle: 0.14, padRound: 0.35, padClamp: 3,
    },
    keys: { repeat: 0.16, maxQueue: 3 },
    snap: { omega: 9.0, zeta: 0.72 },
    reducedSnap: { omega: 12, zeta: 1 },
    follow: { omega: 14, omegaJitter: 0, zeta: 0.75, zetaJitter: 0, airTau: 0.12, lagSpeed: 1e6, upwindX: 18 },   // every card on the same spring, no lag: no gaps
    grab: { omega: 18, zeta: 0.7 },
    hover: { damp: 30 },
    tap: { restitution: 0.35, minImpact: 8 },
    bank: { degPerCms: 0.45, capDeg: 14, omega: 14, zeta: 0.4, ownRate: 0.5 },
    yawLag: { degPerSlotS: 1.6, capDeg: 9, omega: 9, zeta: 0.5 },
    flutter: { freq: [3.0, 4.2], flexOmega: 2 * Math.PI * 6, flexZeta: 0.15, gain: 0.5, vRef: 40, flexDrive: 120, rockDrive: 40 },
    reduced: { fadeIn: 0.24, stagger: 0.08 },
  },

  dust: {
    count: 140, countLite: 70, everySteps: 4,
    box: { x: [-24, 24], y: [0.3, 14], z: [-16, 10] },
    settle: 0.15, jitter: 0.3, jitterFreq: 0.4,
    sizePx: [1.2, 2.6], color: '#FFF3E0', alpha: [0.05, 0.22],
    swirl: { radius: 6, minRate: 6, gain: 0.4 },
  },

  render: {
    clear: '#0C0C0D', exposure: 1.1, anisotropy: 8,
    segments: { hi: [10, 14], lite: [8, 11] }, ribbonSegments: 64,
    edgeColor: '#ECE8DF', coreColor: '#2A2826',   // white face, the dark film back showing in the middle
    clearcoat: 0.7, clearcoatRoughness: 0.3, roughness: [0.22, 0.8],
    clearcoatGloss: 1.6,                   // coat roughness x (this - gloss): worn, greasy patches go matte
    dimpleScale: 0.06, creaseTaps: 0.004, creaseGain: 4, paper: '#F3F0E8', bone: '#5C5852',
    coreLine: [0.15, 0.35],                 // the red core line across the edge ribbon (fraction of its height)
    ribbonSlackCm: 0.01, ribbonMarch: { stepCm: 0.005, maxCm: 0.2 },
    wearEncode: 0.13,                      // R = 0.5 + d / 0.13 cm
    grade: { saturation: 0.86, contrast: 0.9, lift: '#1B1917', warm: '#F6EBD3', warmMix: 0.10 },
    edgeLiftCm: 0.06,
    renderOrder: { cards: 20, stride: 3, airborneCm: 0.25 },
    shadow: { sigma0: 0.10, sigmaH: 0.13, alpha0: 0.5, alphaH: 0.045, alphaMin: 0.14 },
    video: { maxS: 2.7 },
    // The film burn at the left and right edges (render/vortex.js); band and smear in screen widths.
    vortex: { band: 0.07, scale: 3.2, flow: 0.22, smear: 0.04, heat: 0.45, flame: '#ff6a1a', core: '#fff1d6', char: '#2a160c' },
  },

  perf: {
    dpr: { hi: 2, lite: 1.25, floor: 1.0, step: 0.25 },
    slowMs: 18, slowHold: 1, emaKeep: 0.9,
    liteCores: 4, liteMemory: 4, liteTexture: 4096, liteScreen: 900,
    frameWindow: 600,
  },

  // The table (table.js); the tile size must match patches/build_surface.py.
  table: {
    surfaceCm: [120, 90],
    surfaceTileCm: 40,
    lamp: {
      color: 0xfff4e8, coldColor: 0xffe6cc,   // soft daylight from a window overhead
      pos: [-8, 80, 12], target: [0, 0, 0],
      angleDeg: 45, penumbra: 1, decay: 0, intensity: 1.15,
      warmupT: [0.0, 0.5, 0.9], warmupK: [0, 0.7, 1.0],
      reducedFadeSec: 0.4,
      pivot: [-8, 160, 12], swayDeg: 0.25, swayNoisePeriod: 2.6, swayHz: 0.3,
    },
    hemi: { sky: 0xfff1e4, ground: 0xe3c6b2, intensity: 1.3 },
    env: {
      sphereRadius: 80, roomColor: 0x202020, discRadius: 9, discColor: 0xffffff, discGain: 3,
      stripColor: 0xffb070, stripGain: 0.3, stripPos: [0, 4, 40], stripSize: [90, 3],
    },
    shadow: {
      contactCm: 0.4, contactSigma: 0.06, contactAlpha: 0.32,
      aoSigma: 1.2, aoAlpha: 0.10, aoFadeCm: 4,
      cornerRadius: 0.15, tint: [0, 0, 0], margin: 3, renderOrder: 10,
    },
    order: { surface: 0 },
  },

  chrome: { captionFadeMs: 220, clockZone: 'Europe/Amsterdam', clockEveryMs: 15000 },

  fallback: {
    phi: 3, maxSlot: 2.5, spacingDeg: 11.5,
    cardVh: 27, cardVw: 40, pivotCardWidths: 3.6, dropPerSlot2Vh: 0.4, bottomPct: 33, feltTileVh: 22,
  },

  debug: {
    windGrid: [12, 8], windArrowY: 1, windArrowScale: 0.35, windArrowHead: 0.25,
    traceDt: 1 / 120,
  },
});
