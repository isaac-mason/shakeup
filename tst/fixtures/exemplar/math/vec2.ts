// vec2: 2D vector ops. Crashcat house style — plain struct + free functions.
// Collides on purpose with vec3.ts: both export `add`, `dot`, `lengthSq`, and
// both declare a top-level `const scale` with different meaning.

export type Vec2 = { x: number; y: number };

// COLLISION: a top-level const named `scale` (vec3 has one too, different value).
export const scale = 2;

export const create = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

export const lengthSq = (a: Vec2): number => dot(a, a);

// object shorthand where the names collide with the consumer's locals
export const splat = (n: number): Vec2 => {
    const x = n;
    const y = n;
    return { x, y };
};
