// scalar helpers — the leaf of a 3-deep NAMED re-export chain (c).
// clamp is re-exported: scalar.ts (c) -> scalar-barrel.ts (b) -> index.ts (a).

export const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
