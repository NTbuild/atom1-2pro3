// The table: a near-black worn surface, a soft overhead light, the PMREM environment for the
// polaroids' gloss, and one light-projected shadow decal per card.
// Units are cm, y up, player at +z. The texture comes from patches/build_surface.py.
import { CONFIG } from '../config.js';
import { valueNoise1 } from '../noise.js';

const T = CONFIG.table;
const RS = CONFIG.render.shadow; // shared with the card-on-card occluder shadows

const FILES = {
  hi: { surface: 'surface-1024.jpg' },
  lo: { surface: 'surface-512.jpg' },
};

// Pendulum noise channels: four decorrelated lanes of the same 1D noise.
const SWAY_LANES = [0, 17.31, 41.77, 73.09];

const SHADOW_VERT = /* glsl */ `
uniform vec4 uBox;
varying vec2 vP;
void main() {
  vP = mix(uBox.xy, uBox.zw, vec2(uv.x, 1.0 - uv.y)); // v runs toward -z, so the quad faces up
  gl_Position = projectionMatrix * viewMatrix * vec4(vP.x, 0.0, vP.y, 1.0);
}`;

const SHADOW_FRAG = /* glsl */ `
uniform vec2 uLamp[4];
uniform vec2 uFoot[4];
uniform vec2 uOrigin;
uniform vec2 uRowU;
uniform vec2 uRowV;
uniform vec4 uHeight;
uniform float uRadius;
uniform float uAlpha;
uniform float uAo;
uniform vec3 uTint;
uniform vec2 uSigma;
uniform vec3 uContact;
uniform float uAoSigma;
varying vec2 vP;

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

// Coverage of a Gaussian-blurred edge at signed distance d (logistic fit of the normal CDF).
float cover(float d, float sigma) {
  return 1.0 / (1.0 + exp(1.702 * d / sigma));
}

void main() {
  vec2 q = vP - uOrigin;
  vec2 st = clamp(vec2(dot(uRowU, q), dot(uRowV, q)), 0.0, 1.0);
  float h = max(mix(mix(uHeight.x, uHeight.y, st.x), mix(uHeight.w, uHeight.z, st.x), st.y), 0.0);
  float dLamp = sdQuad(vP, uLamp) - uRadius;
  float dFoot = sdQuad(vP, uFoot) - uRadius;
  float main = uAlpha * cover(dLamp, uSigma.x + uSigma.y * h);
  float core = uContact.z * clamp(1.0 - h / uContact.x, 0.0, 1.0) * cover(dFoot, uContact.y);
  float ao = uAo * cover(dFoot, uAoSigma);
  float shade = 1.0 - (1.0 - main) * (1.0 - core) * (1.0 - ao);
  gl_FragColor = vec4(1.0 - shade * (1.0 - uTint), 1.0);
}`;

async function loadTexture(THREE, renderer, url, { srgb, wrap }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`table: ${url} (${res.status})`);
  const bitmap = await createImageBitmap(await res.blob(), {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false; // flipped at decode; WebGL ignores UNPACK_FLIP_Y for ImageBitmap
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = wrap;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Lamp warm-up: eased segments between the intensity keys, 0 before the first and 1 after the last.
function warmup(t) {
  const { warmupT: ts, warmupK: ks } = T.lamp;
  if (t <= ts[0]) return ks[0];
  for (let i = 1; i < ts.length; i++) {
    if (t <= ts[i]) return ks[i - 1] + (ks[i] - ks[i - 1]) * smoothstep(ts[i - 1], ts[i], t);
  }
  return ks[ks.length - 1];
}

// Corners sorted counter-clockwise in the (x, z) plane, with their heights permuted to match.
// Insertion sort on four angles: no closures or arrays allocated per frame.
function sortQuad(xz, h, outXz, outH, order, ang) {
  const cx = (xz[0] + xz[2] + xz[4] + xz[6]) / 4;
  const cz = (xz[1] + xz[3] + xz[5] + xz[7]) / 4;
  for (let i = 0; i < 4; i++) {
    ang[i] = Math.atan2(xz[2 * i + 1] - cz, xz[2 * i] - cx);
    let j = i;
    while (j > 0 && ang[order[j - 1]] > ang[i]) {
      order[j] = order[j - 1];
      j--;
    }
    order[j] = i;
  }
  for (let i = 0; i < 4; i++) {
    outXz[2 * i] = xz[2 * order[i]];
    outXz[2 * i + 1] = xz[2 * order[i] + 1];
    outH[i] = h[order[i]];
  }
}

// Offset each edge of a convex counter-clockwise quad inward by r and intersect neighbours,
// so that sdQuad(inset) - r is a rounded quad with corner radius r.
function insetQuad(src, r, out) {
  let minEdge = Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    minEdge = Math.min(minEdge, Math.hypot(src[2 * j] - src[2 * i], src[2 * j + 1] - src[2 * i + 1]));
  }
  const rr = Math.min(r, 0.3 * minEdge);
  for (let i = 0; i < 4; i++) {
    const p = (i + 3) % 4;
    const n = (i + 1) % 4;
    // incoming edge p -> i and outgoing edge i -> n, both shifted to their left (inside)
    let ax = src[2 * i] - src[2 * p], az = src[2 * i + 1] - src[2 * p + 1];
    let bx = src[2 * n] - src[2 * i], bz = src[2 * n + 1] - src[2 * i + 1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const p0x = src[2 * p] - az * rr, p0z = src[2 * p + 1] + ax * rr;
    const p1x = src[2 * i] - bz * rr, p1z = src[2 * i + 1] + bx * rr;
    const den = ax * bz - az * bx;
    if (Math.abs(den) < 1e-6) {
      out[2 * i] = p1x;
      out[2 * i + 1] = p1z;
    } else {
      const s = ((p1x - p0x) * bz - (p1z - p0z) * bx) / den;
      out[2 * i] = p0x + ax * s;
      out[2 * i + 1] = p0z + az * s;
    }
  }
  return rr;
}

export async function createTable(THREE, { renderer, scene, tier, seed, reduced = false, count = 6 }) {
  const files = FILES[tier === 'lite' ? 'lo' : 'hi'];
  const base = `assets/table/${tier === 'lite' ? 'lo' : 'hi'}/`;
  const surfaceMap = await loadTexture(THREE, renderer, base + files.surface, { srgb: true, wrap: THREE.RepeatWrapping });

  const group = new THREE.Group();
  group.name = 'table';
  scene.add(group);
  const disposables = [surfaceMap];
  const own = (x) => (disposables.push(x), x);

  // ---- the surface ----
  const [surfW, surfH] = T.surfaceCm;
  surfaceMap.repeat.set(surfW / T.surfaceTileCm, surfH / T.surfaceTileCm);
  const surface = new THREE.Mesh(
    own(new THREE.PlaneGeometry(surfW, surfH).rotateX(-Math.PI / 2)),
    // Unlit and not tone-mapped: the surface reads exactly as painted; only the card shadows mark it.
    own(new THREE.MeshBasicMaterial({ map: surfaceMap, toneMapped: false })),
  );
  surface.renderOrder = T.order.surface;
  group.add(surface);

  // ---- lamp, fill ----
  const L = T.lamp;
  const lampColor = new THREE.Color(L.color);
  const coldColor = new THREE.Color(L.coldColor);
  const light = new THREE.SpotLight(L.color, 0, 0, THREE.MathUtils.degToRad(L.angleDeg), L.penumbra, L.decay);
  const restPos = new THREE.Vector3(...L.pos);
  const restTarget = new THREE.Vector3(...L.target);
  const pivot = new THREE.Vector3(...L.pivot);
  const swing = new THREE.Euler();
  const swingQ = new THREE.Quaternion();
  light.position.copy(restPos);
  light.target.position.copy(restTarget);
  group.add(light, light.target);
  const hemi = new THREE.HemisphereLight(T.hemi.sky, T.hemi.ground, T.hemi.intensity);
  group.add(hemi);

  // ---- environment for the gloss: a dark room, the light's bright disc, a warm strip low ----
  const E = T.env;
  const envScene = new THREE.Scene();
  const envGeos = [
    new THREE.SphereGeometry(E.sphereRadius, 32, 16),
    new THREE.CircleGeometry(E.discRadius, 48),
    new THREE.PlaneGeometry(...E.stripSize),
  ];
  const envMats = [
    new THREE.MeshBasicMaterial({ color: new THREE.Color(E.roomColor), side: THREE.BackSide }),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(E.discColor).multiplyScalar(E.discGain) }),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(E.stripColor).multiplyScalar(E.stripGain) }),
  ];
  const [room, disc, strip] = envGeos.map((g, i) => new THREE.Mesh(g, envMats[i]));
  disc.position.copy(restPos);
  disc.lookAt(0, 0, 0);
  strip.position.set(...E.stripPos);
  strip.lookAt(0, E.stripPos[1], 0);
  envScene.add(room, disc, strip);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(envScene, 0, 0.1, E.sphereRadius * 2);
  pmrem.dispose();
  envGeos.forEach((g) => g.dispose());
  envMats.forEach((m) => m.dispose());
  disposables.push(envTarget);

  // ---- shadow decals ----
  const S = T.shadow;
  const decalGeo = own(new THREE.PlaneGeometry(1, 1));
  const decals = [];
  for (let i = 0; i < count; i++) {
    const mat = own(new THREE.ShaderMaterial({
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      uniforms: {
        uBox: { value: new THREE.Vector4() },
        uLamp: { value: [0, 1, 2, 3].map(() => new THREE.Vector2()) },
        uFoot: { value: [0, 1, 2, 3].map(() => new THREE.Vector2()) },
        uOrigin: { value: new THREE.Vector2() },
        uRowU: { value: new THREE.Vector2() },
        uRowV: { value: new THREE.Vector2() },
        uHeight: { value: new THREE.Vector4() },
        uRadius: { value: S.cornerRadius },
        uAlpha: { value: 0 },
        uAo: { value: 0 },
        uTint: { value: new THREE.Vector3(...S.tint) },
        uSigma: { value: new THREE.Vector2(RS.sigma0, RS.sigmaH) },
        uContact: { value: new THREE.Vector3(S.contactCm, S.contactSigma, S.contactAlpha) },
        uAoSigma: { value: S.aoSigma },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    const mesh = new THREE.Mesh(decalGeo, mat);
    mesh.frustumCulled = false; // the vertex shader places it
    mesh.renderOrder = S.renderOrder + i;
    mesh.visible = false;
    group.add(mesh);
    decals.push(mesh);
  }

  // Scratch buffers for setShadows (no allocation per frame).
  const lampXz = new Float32Array(8), footXz = new Float32Array(8), heights = new Float32Array(4);
  const sortedXz = new Float32Array(8), sortedH = new Float32Array(4), inset = new Float32Array(8);
  const order = new Uint8Array(4), angles = new Float32Array(4);

  function placeDecal(mesh, entry) {
    const u = mesh.material.uniforms;
    const c = entry.corners;
    const lp = light.position;
    for (let k = 0; k < 4; k++) {
      const x = c[3 * k], y = c[3 * k + 1], z = c[3 * k + 2];
      const f = lp.y / Math.max(lp.y - y, 1); // ray from the lamp through the corner, onto y = 0
      lampXz[2 * k] = lp.x + (x - lp.x) * f;
      lampXz[2 * k + 1] = lp.z + (z - lp.z) * f;
      footXz[2 * k] = x;
      footXz[2 * k + 1] = z;
      heights[k] = y;
    }
    const h = entry.height;
    u.uAlpha.value = Math.max(RS.alphaMin, RS.alpha0 * (1 - RS.alphaH * h));
    u.uAo.value = S.aoAlpha * Math.max(0, 1 - h / S.aoFadeCm);

    sortQuad(lampXz, heights, sortedXz, sortedH, order, angles);
    const r = insetQuad(sortedXz, S.cornerRadius, inset);
    for (let k = 0; k < 4; k++) u.uLamp.value[k].set(inset[2 * k], inset[2 * k + 1]);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < 4; k++) {
      minX = Math.min(minX, sortedXz[2 * k]); maxX = Math.max(maxX, sortedXz[2 * k]);
      minZ = Math.min(minZ, sortedXz[2 * k + 1]); maxZ = Math.max(maxZ, sortedXz[2 * k + 1]);
    }

    sortQuad(footXz, heights, sortedXz, sortedH, order, angles);
    const rf = insetQuad(sortedXz, S.cornerRadius, inset);
    for (let k = 0; k < 4; k++) {
      u.uFoot.value[k].set(inset[2 * k], inset[2 * k + 1]);
      minX = Math.min(minX, sortedXz[2 * k]); maxX = Math.max(maxX, sortedXz[2 * k]);
      minZ = Math.min(minZ, sortedXz[2 * k + 1]); maxZ = Math.max(maxZ, sortedXz[2 * k + 1]);
    }
    u.uRadius.value = Math.min(r, rf);
    u.uHeight.value.set(sortedH[0], sortedH[1], sortedH[2], sortedH[3]);

    // Affine frame of the footprint (corner 0, edges 0->1 and 0->3) for the per-fragment height.
    const ox = sortedXz[0], oz = sortedXz[1];
    const ax = sortedXz[2] - ox, az = sortedXz[3] - oz;
    const bx = sortedXz[6] - ox, bz = sortedXz[7] - oz;
    const det = ax * bz - az * bx;
    u.uOrigin.value.set(ox, oz);
    if (Math.abs(det) > 1e-6) {
      u.uRowU.value.set(bz / det, -bx / det);
      u.uRowV.value.set(-az / det, ax / det);
    } else {
      u.uRowU.value.set(0, 0);
      u.uRowV.value.set(0, 0);
    }

    const maxH = Math.max(heights[0], heights[1], heights[2], heights[3]);
    const pad = S.margin * Math.max(RS.sigma0 + RS.sigmaH * maxH, u.uAo.value > 0 ? S.aoSigma : 0);
    u.uBox.value.set(minX - pad, minZ - pad, maxX + pad, maxZ + pad);
  }

  return {
    lamp: { pos: light.position, color: light.color, light },
    envMap: envTarget.texture,

    layout() {},

    update(t) {
      const k = reduced ? smoothstep(0, L.reducedFadeSec, t) : warmup(t);
      light.intensity = L.intensity * k;
      light.color.lerpColors(coldColor, lampColor, k);

      let ax = 0, az = 0;
      if (!reduced) {
        // A pendulum at its natural rate whose amplitude and phase wander with the room's air.
        const n = t / L.swayNoisePeriod;
        const w = 2 * Math.PI * L.swayHz * t;
        const amp = THREE.MathUtils.degToRad(L.swayDeg) / Math.SQRT2;
        const c = Math.cos(w), s = Math.sin(w);
        ax = amp * (valueNoise1(seed, n + SWAY_LANES[0]) * c + valueNoise1(seed, n + SWAY_LANES[1]) * s);
        az = amp * (valueNoise1(seed, n + SWAY_LANES[2]) * c + valueNoise1(seed, n + SWAY_LANES[3]) * s);
      }
      swing.set(az, 0, ax);
      swingQ.setFromEuler(swing);
      light.position.copy(restPos).sub(pivot).applyQuaternion(swingQ).add(pivot);
      light.target.position.copy(restTarget).sub(pivot).applyQuaternion(swingQ).add(pivot);
      light.target.updateMatrixWorld();
    },

    setShadows(list) {
      for (let i = 0; i < decals.length; i++) {
        const entry = list[i];
        decals[i].visible = Boolean(entry);
        if (entry) placeDecal(decals[i], entry);
      }
    },

    dispose() {
      scene.remove(group);
      disposables.forEach((d) => d.dispose());
    },
  };
}

