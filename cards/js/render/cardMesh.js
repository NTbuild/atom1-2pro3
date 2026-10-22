// One card: front and back planes plus an edge ribbon, all bent by the same vertex displacement
// (curl, twist, flex, dog-ear, upwind edge lift) with analytic normals so the sheen moves.
// The material is three's physical (or standard, lite) material patched with onBeforeCompile.

import { CONFIG } from '../config.js';

const CW = CONFIG.card.w, CH = CONFIG.card.h, HT = CONFIG.card.thick / 2;
const R = CONFIG.render;

const DEFORM = /* glsl */`
uniform vec3 uCurl;     // long curl, lateral curl, twist (cm)
uniform vec4 uDog;      // corner sign x, corner sign z, size (cm), angle (rad)
uniform vec3 uEdge;     // lifted-edge direction (card x, z) and lift (cm)
uniform float uFace;    // offset of this face from the mid-plane (cm)
varying vec2 vCardUv;
varying vec3 vWorldP;
varying vec3 vTanV;
varying vec3 vBitV;
const float CW = ${CW.toFixed(4)}, CH = ${CH.toFixed(4)};
// Displacement along the card normal and its x / z slopes at card point p = (x, z).
vec3 cardD(vec2 p) {
  float u = 2.0 * p.x / CW, v = 2.0 * p.y / CH;
  float d = uCurl.x * (v * v - 1.0 / 3.0) + uCurl.y * (u * u - 1.0 / 3.0) + uCurl.z * u * v;
  float dx = 4.0 * uCurl.y * u / CW + 2.0 * uCurl.z * v / CW;
  float dz = 4.0 * uCurl.x * v / CH + 2.0 * uCurl.z * u / CH;
  float h = (uDog.z - (0.5 * CW - uDog.x * p.x) - (0.5 * CH - uDog.y * p.y)) * 0.70710678;
  if (uDog.z > 0.0 && h > 0.0) {
    float s = sin(uDog.w);
    d += h * s; dx += uDog.x * 0.70710678 * s; dz += uDog.y * 0.70710678 * s;
  }
  float e = p.x * uEdge.x / (0.5 * CW) + p.y * uEdge.y / (0.5 * CH);
  if (e > 0.0) {
    d += uEdge.z * e * e;
    dx += 2.0 * uEdge.z * e * uEdge.x / (0.5 * CW);
    dz += 2.0 * uEdge.z * e * uEdge.y / (0.5 * CH);
  }
  return vec3(d, dx, dz);
}
`;

const SDQUAD = /* glsl */`
float sdQuad(vec2 p, vec2 v[4]) {
  float d = dot(p - v[0], p - v[0]);
  float s = 1.0;
  for (int i = 0, j = 3; i < 4; j = i, i++) {
    vec2 e = v[j] - v[i];
    vec2 w = p - v[i];
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-8), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= v[i].y, p.y < v[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
`;

const FRAG_HEAD = /* glsl */`
uniform sampler2D uAlbedo;
uniform sampler2D uWear;
uniform sampler2D uGloss;
uniform sampler2D uDimple;
uniform float uWearCm;
uniform float uDimpleTile;
uniform float uDimpleScale;
uniform float uCreaseStep;
uniform float uCreaseGain;
uniform float uCoatGloss;
uniform vec2 uCoreLine;
uniform float uRibbonSlack;
uniform vec3 uPaper;
uniform vec3 uBone;
uniform float uBackFade;
uniform vec2 uRough;
uniform vec2 uOccA[4];
uniform vec2 uOccB[4];
uniform vec4 uOcc;       // sigma A, alpha A, sigma B, alpha B
uniform sampler2D uVideo;
uniform float uVideoMix;
uniform vec4 uWindow;
uniform vec3 uGrade;     // saturation, contrast, warm mix
uniform vec3 uLift;
uniform vec3 uWarm;
uniform vec3 uEdgeColor;
uniform vec3 uCoreColor;
varying vec2 vCardUv;
varying vec3 vWorldP;
varying vec3 vTanV;
varying vec3 vBitV;
varying float vRibbon;
const float CW = ${CW.toFixed(4)}, CH = ${CH.toFixed(4)};
${SDQUAD}
float occShade(vec2 v[4], float sigma, float alpha) {
  if (alpha <= 0.0) return 0.0;
  return alpha / (1.0 + exp(1.702 * sdQuad(vWorldP.xz, v) / sigma));
}
// The faded-ink grade of the printed photos, for the live video window.
vec3 inkGrade(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uGrade.x);
  c = (c - 0.18) * uGrade.y + 0.18;
  c = mix(uLift, vec3(1.0), max(c, 0.0));
  return c * mix(vec3(1.0), uWarm, uGrade.z);
}
`;

// Shared deformation uniforms of one card (all three meshes bend together).
export function deformUniforms(THREE) {
  return {
    uCurl: { value: new THREE.Vector3() },
    uDog: { value: new THREE.Vector4() },
    uEdge: { value: new THREE.Vector3() },
  };
}

// THREE.Color converts the sRGB hex into the linear working space the shader works in.
const linear = (THREE, hex) => new THREE.Color(hex);

// kind: 'front' | 'back' | 'edge'. Returns a material sharing the card's deform uniforms.
function cardMaterial(THREE, { kind, lite, tex, deform, card, envMap, video }) {
  const Mat = lite ? THREE.MeshStandardMaterial : THREE.MeshPhysicalMaterial;
  // Cards are painter-sorted (view.js) and never depth-tested: a curled edge brushing the felt stays whole.
  const params = { transparent: true, depthWrite: false, depthTest: false, metalness: 0, envMap, side: THREE.FrontSide };
  if (!lite && kind !== 'edge') Object.assign(params, { clearcoat: R.clearcoat, clearcoatRoughness: R.clearcoatRoughness });
  const mat = new Mat(params);
  const g = R.grade;
  const occA = [0, 1, 2, 3].map(() => new THREE.Vector2()), occB = [0, 1, 2, 3].map(() => new THREE.Vector2());
  const uniforms = {
    ...deform,
    uFace: { value: kind === 'front' ? HT : kind === 'back' ? -HT : 0 },
    uAlbedo: { value: kind === 'back' ? tex.back : tex.front },
    uWear: { value: tex.wear },
    uGloss: { value: tex.gloss },
    uDimple: { value: tex.dimple },
    uWearCm: { value: R.wearEncode },
    uDimpleTile: { value: tex.dimpleTileCm },
    uDimpleScale: { value: R.dimpleScale },
    uCreaseStep: { value: R.creaseTaps },
    uCreaseGain: { value: R.creaseGain },
    uCoatGloss: { value: R.clearcoatGloss },
    uCoreLine: { value: new THREE.Vector2(...R.coreLine) },
    uRibbonSlack: { value: R.ribbonSlackCm },
    uPaper: { value: linear(THREE, R.paper) },
    uBone: { value: linear(THREE, R.bone) },
    uBackFade: { value: card.backFade || 0 },
    uRough: { value: new THREE.Vector2(R.roughness[0], R.roughness[1]) },
    uOccA: { value: occA }, uOccB: { value: occB }, uOcc: { value: new THREE.Vector4() },
    uVideo: { value: video ? video.texture : null },
    uVideoMix: { value: 0 },
    uWindow: { value: new THREE.Vector4(...(video ? video.windowUV : [0, 0, 0, 0])) },
    uGrade: { value: new THREE.Vector3(g.saturation, g.contrast, g.warmMix) },
    uLift: { value: linear(THREE, g.lift) },
    uWarm: { value: linear(THREE, g.warm) },
    uEdgeColor: { value: linear(THREE, R.edgeColor) },
    uCoreColor: { value: linear(THREE, R.coreColor) },
  };
  const defines = [
    `#define CARD_${kind.toUpperCase()}`,
    lite ? '' : '#define CARD_OCC',
    video && kind === 'front' ? '#define CARD_VIDEO' : '',
  ].join('\n');

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${defines}\n${DEFORM}\nattribute float ribbon;\nvarying float vRibbon;`)
      .replace('#include <beginnormal_vertex>', `
        vec3 cardDisp = cardD(position.xz);
        #ifdef CARD_EDGE
          vec3 objectNormal = normal;
        #else
          vec3 objectNormal = normalize(vec3(-cardDisp.y, 1.0, -cardDisp.z)) * sign(uFace);
        #endif
        vCardUv = vec2((position.x + 0.5 * CW) / CW, (0.5 * CH - position.z) / CH);
        vTanV = normalize(normalMatrix * vec3(1.0, cardDisp.y, 0.0));
        vBitV = normalize(normalMatrix * vec3(0.0, -cardDisp.z, -1.0));
        #ifdef CARD_EDGE
          vRibbon = ribbon;
        #else
          vRibbon = 0.0;
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, position.y + cardDisp.x + uFace, position.z);')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${defines}\n${FRAG_HEAD}`)
      .replace('#include <map_fragment>', `
        vec4 wearTex = texture2D(uWear, vCardUv);
        float sdf = (wearTex.r - 0.5) * uWearCm;
        #ifdef CARD_EDGE
          if (sdf < -uRibbonSlack) discard;
          float core = 1.0 - smoothstep(uCoreLine.x, uCoreLine.y, abs(vRibbon - 0.5));
          diffuseColor.rgb *= mix(uEdgeColor, uCoreColor, core);
        #else
          float fw = max(fwidth(sdf), 1e-4);
          float edgeA = smoothstep(-fw, fw, sdf);
          if (edgeA < 0.01) discard;
          #ifdef CARD_BACK
            vec3 albedo = texture2D(uAlbedo, vec2(1.0 - vCardUv.x, vCardUv.y)).rgb;
            albedo = mix(albedo, uBone, clamp(wearTex.g + uBackFade, 0.0, 1.0));
          #else
            vec3 albedo = texture2D(uAlbedo, vCardUv).rgb;
            #ifdef CARD_VIDEO
              vec2 wuv = (vCardUv - uWindow.xy) / (uWindow.zw - uWindow.xy);
              if (uVideoMix > 0.0 && all(greaterThanEqual(wuv, vec2(0.0))) && all(lessThanEqual(wuv, vec2(1.0)))) {
                albedo = mix(albedo, inkGrade(texture2D(uVideo, wuv).rgb), uVideoMix);
              }
            #endif
            albedo = mix(albedo, uPaper, wearTex.g);
          #endif
          diffuseColor.rgb *= albedo;
          diffuseColor.a *= edgeA;
        #endif`)
      .replace('#include <roughnessmap_fragment>', `
        float gloss = texture2D(uGloss, vCardUv).r;
        float roughnessFactor = mix(uRough.x, uRough.y, 1.0 - gloss);`)
      .replace('#include <normal_fragment_maps>', `
        #ifndef CARD_EDGE
        {
          vec3 dn = texture2D(uDimple, vCardUv * vec2(CW, CH) / uDimpleTile).xyz * 2.0 - 1.0;
          vec2 e = vec2(uCreaseStep, 0.0);
          vec2 slope = vec2(texture2D(uWear, vCardUv + e.xy).b - texture2D(uWear, vCardUv - e.xy).b,
                            texture2D(uWear, vCardUv + e.yx).b - texture2D(uWear, vCardUv - e.yx).b);
          vec3 tn = normalize(vec3(dn.xy * uDimpleScale - slope * uCreaseGain, 1.0));
          normal = normalize(normalize(vTanV) * tn.x + normalize(vBitV) * tn.y + normal * tn.z);
        }
        #endif`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoatRoughness = min(material.clearcoatRoughness * (uCoatGloss - gloss), 1.0);
        #endif`)
      .replace('#include <opaque_fragment>', `
        #ifdef CARD_OCC
          float occ = 1.0 - (1.0 - occShade(uOccA, uOcc.x, uOcc.y)) * (1.0 - occShade(uOccB, uOcc.z, uOcc.w));
          outgoingLight *= 1.0 - occ;
        #endif
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `card-${kind}-${lite ? 'lite' : 'hi'}-${video && kind === 'front' ? 'video' : ''}`;
  return { mat, uniforms };
}

// The card outline: points on the base rounded rectangle, pulled in to where the frayed silhouette
// (wear map R = 0) actually is. wear = {data, width, height} RGBA pixels (top row first).
function silhouette(wear, segments) {
  const r = CONFIG.card.corner;
  const sample = (x, z) => {
    const u = (x + CW / 2) / CW, v = (z + CH / 2) / CH;         // v from the top edge (image rows)
    const px = Math.min(wear.width - 1, Math.max(0, u * (wear.width - 1)));
    const py = Math.min(wear.height - 1, Math.max(0, v * (wear.height - 1)));
    return (wear.data[4 * (Math.round(py) * wear.width + Math.round(px))] / 255 - 0.5) * R.wearEncode;
  };
  const straightX = CW - 2 * r, straightZ = CH - 2 * r, arc = Math.PI * r / 2;
  const perimeter = 2 * (straightX + straightZ) + 4 * arc;
  const pts = [];
  for (let i = 0; i < segments; i++) {
    let d = (i / segments) * perimeter;
    // Walk the rounded rectangle clockwise from the top-left end of the top edge.
    const legs = [
      [straightX, (t) => [-CW / 2 + r + t, -CH / 2, 0, -1]],
      [arc, (t) => { const a = -Math.PI / 2 + t / r; return [CW / 2 - r + r * Math.cos(a), -CH / 2 + r + r * Math.sin(a), Math.cos(a), Math.sin(a)]; }],
      [straightZ, (t) => [CW / 2, -CH / 2 + r + t, 1, 0]],
      [arc, (t) => { const a = t / r; return [CW / 2 - r + r * Math.cos(a), CH / 2 - r + r * Math.sin(a), Math.cos(a), Math.sin(a)]; }],
      [straightX, (t) => [CW / 2 - r - t, CH / 2, 0, 1]],
      [arc, (t) => { const a = Math.PI / 2 + t / r; return [-CW / 2 + r + r * Math.cos(a), CH / 2 - r + r * Math.sin(a), Math.cos(a), Math.sin(a)]; }],
      [straightZ, (t) => [-CW / 2, CH / 2 - r - t, -1, 0]],
      [arc, (t) => { const a = Math.PI + t / r; return [-CW / 2 + r + r * Math.cos(a), -CH / 2 + r + r * Math.sin(a), Math.cos(a), Math.sin(a)]; }],
    ];
    let p;
    for (const [len, at] of legs) {
      if (d <= len) { p = at(d); break; }
      d -= len;
    }
    const [x0, z0, nx, nz] = p;
    // March inward until the silhouette's signed distance turns positive.
    let x = x0, z = z0;
    const step = R.ribbonMarch.stepCm;
    for (let d = 0; d < R.ribbonMarch.maxCm && sample(x, z) < 0; d += step) { x -= nx * step; z -= nz * step; }
    pts.push([x, z, nx, nz]);
  }
  return pts;
}

function ribbonGeometry(THREE, pts) {
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3), nrm = new Float32Array(n * 2 * 3), rib = new Float32Array(n * 2);
  pts.forEach(([x, z, nx, nz], i) => {
    for (let k = 0; k < 2; k++) {
      const o = 2 * i + k;
      pos.set([x, k ? HT : -HT, z], 3 * o);
      nrm.set([nx, 0, nz], 3 * o);
      rib[o] = k;
    }
  });
  const index = [];
  for (let i = 0; i < n; i++) {
    const a = 2 * i, b = 2 * ((i + 1) % n);
    index.push(a, a + 1, b, a + 1, b + 1, b);   // outward-facing for the clockwise (seen from above) outline
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('ribbon', new THREE.BufferAttribute(rib, 1));
  geo.setIndex(index);
  return geo;
}

function planeGeometry(THREE, segs, facing) {
  const geo = new THREE.PlaneGeometry(CW, CH, segs[0], segs[1]);
  return geo.rotateX(facing > 0 ? -Math.PI / 2 : Math.PI / 2);
}

// card: manifest entry. tex: {front, back, wear, gloss, dimple, dimpleTileCm, wearPixels}.
// video: {texture, windowUV} for the 9, else null.
export function createCardMesh(THREE, { card, tex, lite, envMap, video }) {
  const deform = deformUniforms(THREE);
  const segs = lite ? R.segments.lite : R.segments.hi;
  const front = cardMaterial(THREE, { kind: 'front', lite, tex, deform, card, envMap, video });
  const back = cardMaterial(THREE, { kind: 'back', lite, tex, deform, card, envMap, video: null });
  const edge = cardMaterial(THREE, { kind: 'edge', lite: true, tex, deform, card, envMap, video: null });
  edge.mat.color.set(0xffffff);
  edge.mat.roughness = R.roughness[1];

  const group = new THREE.Group();
  group.name = `card-${card.id}`;
  const meshes = {
    back: new THREE.Mesh(planeGeometry(THREE, segs, -1), back.mat),
    edge: new THREE.Mesh(ribbonGeometry(THREE, silhouette(tex.wearPixels, R.ribbonSegments)), edge.mat),
    front: new THREE.Mesh(planeGeometry(THREE, segs, 1), front.mat),
  };
  for (const m of Object.values(meshes)) {
    m.frustumCulled = false;
    group.add(m);
  }
  const dog = card.dogEar;
  const dogSign = dog ? { tr: [1, -1], tl: [-1, -1], br: [1, 1], bl: [-1, 1] }[dog.corner] : [0, 0];

  return {
    group, meshes, deform,
    front: front.uniforms, back: back.uniforms,
    occluders: [front.uniforms, back.uniforms],
    setOrder(base) {
      meshes.back.renderOrder = base;
      meshes.edge.renderOrder = base + 1;
      meshes.front.renderOrder = base + 2;
    },
    // Bend: current curl/flex/twist (cm), dog-ear hinge (rad), lifted-edge direction and amount (cm).
    setBend(curlL, curlT, twist, dogRad, ex, ez, lift) {
      deform.uCurl.value.set(curlL, curlT, twist);
      deform.uDog.value.set(dogSign[0], dogSign[1], dog ? dog.sizeCm : 0, dog ? dog.liftDeg * Math.PI / 180 + dogRad : 0);
      deform.uEdge.value.set(ex, ez, lift);
    },
    setOpacity(a) {
      for (const m of Object.values(meshes)) { m.visible = a > 0; m.material.opacity = a; }
    },
    dispose() {
      for (const m of Object.values(meshes)) { m.geometry.dispose(); m.material.dispose(); }
    },
  };
}
