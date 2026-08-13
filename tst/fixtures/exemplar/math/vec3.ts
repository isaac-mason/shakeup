// vec3: 3D vector ops. Deliberate name collisions with vec2.ts.

export type Vec3 = { x: number; y: number; z: number };

// COLLISION: `scale` again, different value than vec2's.
export const scale = 3;

export const create = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const lengthSq = (a: Vec3): number => dot(a, a);
