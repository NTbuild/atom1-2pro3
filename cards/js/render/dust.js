// Dust motes in the lamp cone. DustSim is deterministic and DOM-free (stepped by the World, part of
// its snapshots); createDustPoints draws it with THREE.Points (THREE is passed in, like table.js).

import { CONFIG } from '../config.js';
import { fork, range } from '../rng.js';
import { createSimplex3 } from '../noise.js';

const DU = CONFIG.dust;
const BOX = DU.box;
const span = (r) => r[1] - r[0];
const wrapIn = (v, r) => (v < r[0] ? v + span(r) : v > r[1] ? v - span(r) : v);

export class DustSim {
  constructor(seed, count) {
    const rand = fork(seed, 'dust');
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.pos[3 * i] = range(rand, BOX.x[0], BOX.x[1]);
      this.pos[3 * i + 1] = range(rand, BOX.y[0], BOX.y[1]);
      this.pos[3 * i + 2] = range(rand, BOX.z[0], BOX.z[1]);
      this.size[i] = range(rand, DU.sizePx[0], DU.sizePx[1]);
      this.alpha[i] = range(rand, DU.alpha[0], DU.alpha[1]);
    }
    this.jitter = createSimplex3(rand);
    this.w = new Float64Array(3);
  }

  // swirls: [{x, y, z, ax, ay, az, rate}] for cards flipping faster than the threshold.
  step(t, dt, wind, swirls) {
    const p = this.pos, w = this.w, J = DU.jitter, f = DU.jitterFreq * t;
    const R2 = DU.swirl.radius * DU.swirl.radius;
    for (let i = 0; i < this.count; i++) {
      const o = 3 * i;
      let x = p[o], y = p[o + 1], z = p[o + 2];
      wind.sample(x, y, z, w);
      let vx = w[0] + J * this.jitter(i, f, 0);
      let vy = w[1] - DU.settle + J * this.jitter(i, f, 1);
      let vz = w[2] + J * this.jitter(i, f, 2);
      for (const s of swirls) {
        const rx = x - s.x, ry = y - s.y, rz = z - s.z;
        if (rx * rx + ry * ry + rz * rz > R2) continue;
        // The air the card catches: rotation about its flip axis.
        const g = DU.swirl.gain * s.rate;
        vx += g * (s.ay * rz - s.az * ry);
        vy += g * (s.az * rx - s.ax * rz);
        vz += g * (s.ax * ry - s.ay * rx);
      }
      x += vx * dt; y += vy * dt; z += vz * dt;
      p[o] = wrapIn(x, BOX.x); p[o + 1] = wrapIn(y, BOX.y); p[o + 2] = wrapIn(z, BOX.z);
    }
  }

  snapshotSize() { return this.pos.length; }
  writeSnapshot(buf, o) { buf.set(this.pos, o); return o + this.pos.length; }
  readSnapshot(buf, o) { this.pos.set(buf.subarray(o, o + this.pos.length)); return o + this.pos.length; }
}

// Additive points, alpha shaped by the lamp's cone. lamp = {pos: Vector3, angle, penumbra, target: Vector3}.
export function createDustPoints(THREE, sim, lamp) {
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(sim.pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('size', new THREE.BufferAttribute(sim.size, 1));
  geo.setAttribute('alpha', new THREE.BufferAttribute(sim.alpha, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(DU.color) },
      uLamp: { value: lamp.pos },
      uLampDir: { value: new THREE.Vector3() },
      uCone: { value: new THREE.Vector2() },
      uPixelRatio: { value: 1 },
      uOn: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float size; attribute float alpha;
      uniform vec3 uLamp; uniform vec3 uLampDir; uniform vec2 uCone; uniform float uPixelRatio; uniform float uOn;
      varying float vA;
      void main() {
        vec3 d = normalize(position - uLamp);
        float c = dot(d, uLampDir);
        vA = alpha * uOn * smoothstep(uCone.x, uCone.y, c);
        gl_PointSize = size * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; varying float vA;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float r = length(q) * 2.0;
        gl_FragColor = vec4(uColor * vA * (1.0 - smoothstep(0.4, 1.0, r)), 1.0);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 60;
  return {
    points,
    update(lampTarget, angle, penumbra, on, pixelRatio) {
      posAttr.needsUpdate = true;
      mat.uniforms.uLampDir.value.copy(lampTarget).sub(lamp.pos).normalize();
      mat.uniforms.uCone.value.set(Math.cos(angle), Math.cos(angle * (1 - penumbra)));
      mat.uniforms.uOn.value = on;
      mat.uniforms.uPixelRatio.value = pixelRatio;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
