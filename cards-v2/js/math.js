// Small scalar and rotation helpers shared by the simulation and the view. No DOM, no THREE.

export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// Project 2's damped spring: step response from 0 to 1, t seconds after it starts.
// w is how quick, z how much it bounces (lower = more).
export function spr(t, w, z) {
  if (t <= 0) return 0;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
}

// d/dt of spr().
export function sprRate(t, w, z) {
  if (t <= 0) return 0;
  const wd = w * Math.sqrt(1 - z * z);
  return (w * w / wd) * Math.exp(-z * w * t) * Math.sin(wd * t);
}

// Cubic Hermite through keys [[tau, y, dy/dtau], ...]; returns [y, dy/dtau].
export function hermite(keys, tau, out) {
  let k = 0;
  while (k < keys.length - 2 && tau > keys[k + 1][0]) k++;
  const [t0, y0, m0] = keys[k];
  const [t1, y1, m1] = keys[k + 1];
  const h = t1 - t0;
  const s = clamp((tau - t0) / h, 0, 1);
  const s2 = s * s, s3 = s2 * s;
  out[0] = (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * h * m1;
  out[1] = ((6 * s2 - 6 * s) * y0 + (3 * s2 - 4 * s + 1) * h * m0 + (-6 * s2 + 6 * s) * y1 + (3 * s2 - 2 * s) * h * m1) / h;
  return out;
}

// Card orientation as a 3x3 matrix (column-major: local x, local y = face normal, local z).
// R = Ry(yaw) * Rx(-pitch) * Raxis(roll), the roll axis tilted by beta inside the card plane.
// Positive pitch raises the card's +z edge (the edge nearest the player at rest);
// positive roll raises the +x edge.
export function cardBasis(yaw, pitch, roll, beta, m) {
  // Rotation about the in-plane axis a = (sin beta, 0, cos beta) by roll (Rodrigues).
  const ax = Math.sin(beta), az = Math.cos(beta);
  const c = Math.cos(roll), s = Math.sin(roll), t = 1 - c;
  // columns of Raxis
  const r00 = t * ax * ax + c, r10 = s * az, r20 = t * ax * az;
  const r01 = -s * az, r11 = c, r21 = s * ax;
  const r02 = t * ax * az, r12 = -s * ax, r22 = t * az * az + c;
  // Rx(-pitch)
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // Rx(a) rows: [1,0,0],[0,ca,-sa],[0,sa,ca] with a = -pitch -> ca = cp, sa = -sp
  const p00 = r00, p10 = cp * r10 + sp * r20, p20 = -sp * r10 + cp * r20;
  const p01 = r01, p11 = cp * r11 + sp * r21, p21 = -sp * r11 + cp * r21;
  const p02 = r02, p12 = cp * r12 + sp * r22, p22 = -sp * r12 + cp * r22;
  // Ry(yaw) rows: [cy,0,sy],[0,1,0],[-sy,0,cy]
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  m[0] = cy * p00 + sy * p20; m[1] = p10; m[2] = -sy * p00 + cy * p20;
  m[3] = cy * p01 + sy * p21; m[4] = p11; m[5] = -sy * p01 + cy * p21;
  m[6] = cy * p02 + sy * p22; m[7] = p12; m[8] = -sy * p02 + cy * p22;
  return m;
}

// Quaternion [x, y, z, w] from a column-major rotation matrix.
export function quatFromBasis(m, q) {
  const m00 = m[0], m10 = m[1], m20 = m[2], m01 = m[3], m11 = m[4], m21 = m[5], m02 = m[6], m12 = m[7], m22 = m[8];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q[3] = 0.25 / s; q[0] = (m21 - m12) * s; q[1] = (m02 - m20) * s; q[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q[3] = (m21 - m12) / s; q[0] = 0.25 * s; q[1] = (m01 + m10) / s; q[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q[3] = (m02 - m20) / s; q[0] = (m01 + m10) / s; q[1] = 0.25 * s; q[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q[3] = (m10 - m01) / s; q[0] = (m02 + m20) / s; q[1] = (m12 + m21) / s; q[2] = 0.25 * s;
  }
  return q;
}

// World position of a card-local point (x along the width, d along the normal, z along the height).
export function cardPoint(m, cx, cy, cz, x, d, z, out, o = 0) {
  out[o] = cx + m[0] * x + m[3] * d + m[6] * z;
  out[o + 1] = cy + m[1] * x + m[4] * d + m[7] * z;
  out[o + 2] = cz + m[2] * x + m[5] * d + m[8] * z;
  return out;
}
