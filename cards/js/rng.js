// Seeded randomness. The simulation never touches Math.random.

// Project 2's generator: uniform floats in [0, 1).
export function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 53-bit string hash (bryc's cyrb53).
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ?seed= accepts an int or any string.
export function seedFrom(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : cyrb53(String(value)) % 2147483647;
}

// An independent stream for one named consumer ('wind', 'flight', 'card:A', ...).
export function fork(seed, name) {
  return mulberry32(cyrb53(name, seed | 0) % 4294967296);
}

export const range = (rand, a, b) => a + (b - a) * rand();
export const signed = (rand, amp) => (rand() * 2 - 1) * amp;
