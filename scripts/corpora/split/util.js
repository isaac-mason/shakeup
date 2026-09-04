// A leaf with several exports, only some of which each consumer uses — so tree-shaking, not just
// chunking, decides what crosses the chunk boundary.
export const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
export const lerp = (a, b, t) => a + (b - a) * t;
export const unusedEverywhere = () => 'dead';
export function chain(...fns) {
    return (x) => fns.reduce((acc, f) => f(acc), x);
}
