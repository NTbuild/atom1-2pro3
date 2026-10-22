// Seeded simplex noise with analytic gradient, a divergence-free 2D curl, and 1D value noise.

import { cyrb53 } from './rng.js';

const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);
const F3 = 1 / 3, G3 = 1 / 6;

// Returns noise3(x, y, z, grad?) in about [-1, 1]; when grad (length 3) is given it receives d/dx, d/dy, d/dz.
export function createSimplex3(rand) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512), pm12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = perm[i] % 12; }

  let n, dx, dy, dz;
  const corner = (x, y, z, gi) => {
    const t = 0.6 - x * x - y * y - z * z;
    if (t <= 0) return;
    const gx = GRAD3[gi], gy = GRAD3[gi + 1], gz = GRAD3[gi + 2];
    const gd = gx * x + gy * y + gz * z;
    const t2 = t * t, t4 = t2 * t2;
    n += t4 * gd;
    const c = -8 * t2 * t * gd;
    dx += c * x + t4 * gx; dy += c * y + t4 * gy; dz += c * z + t4 * gz;
  };

  return function noise3(xin, yin, zin, grad) {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const ii = i & 255, jj = j & 255, kk = k & 255;
    n = 0; dx = 0; dy = 0; dz = 0;
    corner(x0, y0, z0, pm12[ii + perm[jj + perm[kk]]] * 3);
    corner(x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3, pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3);
    corner(x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3, pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3);
    corner(x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3, pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3);
    if (grad) { grad[0] = 32 * dx; grad[1] = 32 * dy; grad[2] = 32 * dz; }
    return 32 * n;
  };
}

// Horizontal curl of psi(x/l, z/l, phase): (d psi/dz, -d psi/dx). Divergence free by construction.
const g = new Float64Array(3);
export function curl2(noise, x, z, phase, l, out) {
  noise(x / l, z / l, phase, g);
  out[0] = g[1] / l;
  out[1] = -g[0] / l;
  return out;
}

// Smooth 1D value noise in [-1, 1] (quintic fade between hashed lattice values).
const lattice = (seed, i) => (cyrb53(String(i), seed | 0) % 2000001) / 1000000 - 1;
export function valueNoise1(seed, x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = lattice(seed, i), b = lattice(seed, i + 1);
  return a + (b - a) * u;
}
