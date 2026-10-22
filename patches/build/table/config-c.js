// Builder C's CONFIG sections (table, chrome, fallback) for cards/js/config.js: merge these three keys
// into the CONFIG object there. table.js also reads CONFIG.render.shadow (already in config.js).
const CONFIG_C = {
  table: {
    feltCm: [120, 90],
    feltTileCm: 20, // felt-*-1024.jpg repeats 6 x 4.5
    feltRoughness: 0.96,
    feltNormalScale: 0.35,
    print: { sizeCm: [64, 32], centreZ: -4, y: 0.001 }, // must match patches/build_table.py
    rail: {
      radius: 2.6, axisY: 1.0, lengthCm: 120, segments: 64,
      seatCm: 0.05, // how far the cushion sinks into the lacquer strip
      texAlongCm: 32.68, // rail-leather texture length along the rail
      roughness: 0.55, normalScale: 0.45, envMapIntensity: 0.12,
    },
    lacquer: { widthCm: 0.6, topY: 0.5, bevelCm: 0.12, color: 0x070707, roughness: 0.22, envMapIntensity: 1.0 },
    lamp: {
      color: 0xffe2b8, coldColor: 0xffb070, // filament colour at low power
      pos: [0, 58, -2], target: [0, 0, 1],
      angleDeg: 18.5, penumbra: 1, decay: 0, intensity: 2.2,
      warmupT: [0.38, 0.47, 0.53, 0.8], warmupK: [0, 0.6, 0.25, 1.0],
      reducedFadeSec: 0.4,
      pivot: [0, 120, -2], swayDeg: 0.6, swayNoisePeriod: 2.6, swayHz: 0.63, // 62 cm cord: 0.63 Hz
    },
    hemi: { sky: 0x5d6a78, ground: 0x0a0d0c, intensity: 0.18 },
    env: {
      sphereRadius: 80, discRadius: 6, discColor: 0xffe2b8, discGain: 6,
      stripColor: 0xe33131, stripGain: 0.4, stripPos: [0, 4, 40], stripSize: [90, 3],
    },
    shadow: {
      contactCm: 0.4, contactSigma: 0.06, contactAlpha: 0.35,
      aoSigma: 1.2, aoAlpha: 0.12, aoFadeCm: 4,
      cornerRadius: 0.4, tint: [0, 0.02, 0.04], margin: 3, renderOrder: 10,
    },
    order: { felt: 0, print: 1, lacquer: 2, rail: 3 },
  },
  chrome: {
    fps: 30, captionFadeMs: 220,
    clockZone: 'America/Sao_Paulo', clockLabel: 'BRT', clockEveryMs: 15000,
    powerSplit: 0.45, powerLineStart: [0.6, 0.004], powerLineMid: 0.006,
  },
  fallback: {
    phi: 3, maxSlot: 2.5, spacingDeg: 11.5,
    cardVh: 27, cardVw: 40, pivotCardWidths: 3.6, dropPerSlot2Vh: 0.4, bottomPct: 33, feltTileVh: 22,
  },
};
