// The edges of the frame as a slow film burn: the scene is rendered to a texture, then a full-screen
// pass lets flame tongues (flowing noise) eat in from the left and right edges wherever a polaroid
// is: a white-hot core, orange flame, a charred smoky rim, and a little sideways smear inside the
// burn. The centre of the frame and the empty table are untouched.

import { CONFIG } from '../config.js';

const V = CONFIG.render.vortex;

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform sampler2D tScene;
uniform vec2 uRes;
uniform float uTime;
uniform float uBand;       // how far the burn reaches in (fraction of the width)
uniform float uScale;      // size of the flame tongues (noise cells per screen height)
uniform float uFlow;       // flame drift speed
uniform float uSmear;      // sideways smear inside the burn (fraction of the width)
uniform float uHeat;       // brightness of the core and flame
uniform vec3 uFlame;
uniform vec3 uCore;
uniform vec3 uChar;
varying vec2 vUv;

const int TAPS = 10;

float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return v;
}

void main() {
  float aspect = uRes.x / uRes.y;
  float e = min(vUv.x, 1.0 - vUv.x);
  float b = smoothstep(uBand, 0.0, e);               // 0 inside, 1 at the edge
  vec3 c0 = texture2D(tScene, vUv).rgb;
  if (b <= 0.0) {
    gl_FragColor = vec4(c0, 1.0);
  } else {
    float side = vUv.x < 0.5 ? -1.0 : 1.0;
    // Is a polaroid here? Look along the row toward the edge for card-bright pixels.
    vec3 smear = vec3(0.0);
    float card = 0.0, total = 0.0;
    for (int i = 0; i < TAPS; i++) {
      float s = float(i) / float(TAPS - 1);
      vec3 c = texture2D(tScene, vec2(clamp(vUv.x - side * uSmear * b * s, 0.0, 1.0), vUv.y)).rgb;
      float w = 1.0 - 0.7 * s;
      smear += w * c; total += w;
      card = max(card, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    }
    smear /= total;
    float onCard = smoothstep(0.12, 0.3, card);

    // Flame field: noise flowing out of the edge and curling upward, domain-warped into tongues.
    // Stretched along the row: the flames are dragged sideways into wisps.
    vec2 p = vec2((side < 0.0 ? vUv.x : 1.0 - vUv.x) * aspect * 0.3, vUv.y * 1.6) * uScale;
    float t = uTime * uFlow;
    vec2 warp = vec2(fbm(p + vec2(0.0, -t)), fbm(p + vec2(5.2, -t * 1.3)));
    float f = fbm(p * 1.4 + 2.2 * warp + vec2(t * 0.6, -t));
    float heat = b * 1.05 + (f - 0.5) * 1.5;          // wispy: the noise dominates the edge ramp

    // Soft, glowing wisps rather than a burning front: everything blends, nothing is cut.
    vec3 col = mix(c0, smear, smoothstep(0.2, 0.9, heat) * 0.8);
    col = mix(col, col * uChar, smoothstep(0.15, 0.6, heat) * 0.45);   // smoky darkening
    float flame = smoothstep(0.3, 0.95, heat);
    col += uFlame * flame * flame * uHeat;                             // warm glow, additive
    float core = smoothstep(0.75, 1.2, heat);
    col += uCore * core * core * uHeat * 0.9;                          // hot white in the brightest wisps
    gl_FragColor = vec4(mix(c0, col, onCard), 1.0);
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createVortex(THREE, renderer) {
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      tScene: { value: target.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uBand: { value: V.band },
      uScale: { value: V.scale },
      uFlow: { value: V.flow },
      uSmear: { value: V.smear },
      uHeat: { value: V.heat },
      uFlame: { value: new THREE.Color(V.flame) },
      uCore: { value: new THREE.Color(V.core) },
      uChar: { value: new THREE.Color(V.char) },
    },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.Camera();

  return {
    setSize(w, h, pixelRatio) {
      target.setSize(Math.round(w * pixelRatio), Math.round(h * pixelRatio));
      material.uniforms.uRes.value.set(w, h);
    },
    // Render the scene through the burn. t: seconds (drives the flames).
    render(sceneIn, cameraIn, t) {
      material.uniforms.uTime.value = t;
      renderer.setRenderTarget(target);
      renderer.render(sceneIn, cameraIn);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    dispose() {
      target.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}
