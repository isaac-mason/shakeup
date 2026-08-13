// Namespace-import calling style (crashcat): `import * as vec2` used as
// `vec2.add(...)`. Also imports vec3 the same way — the two namespaces keep the
// colliding `add`/`dot` apart. Consumes the barrel's named chain export (clamp).
import * as vec2 from '../math/vec2';
import * as vec3 from '../math/vec3';
import { clamp } from '../math';
import type { Particle } from '../types';
import { MotionType } from '../motion';

// one Euler step: STATIC never moves, DYNAMIC integrates vel, KINEMATIC moves
// at a fixed clamped rate. Enum switch over MotionType.
export const step = (p: Particle, dt: number): Particle => {
    switch (p.motion) {
        case MotionType.STATIC:
            return p;
        case MotionType.DYNAMIC: {
            // vec2.add via namespace calling style
            const pos = vec2.add(p.pos, { x: p.vel.x * dt, y: p.vel.y * dt });
            return { pos, vel: p.vel, mass: p.mass, motion: p.motion };
        }
        case MotionType.KINEMATIC: {
            const rate = clamp(dt, 0, 1);
            const pos = vec2.add(p.pos, vec2.create(rate, rate));
            return { pos, vel: p.vel, mass: p.mass, motion: p.motion };
        }
    }
    return p;
};

// use vec3 too (proves the vec3 namespace is distinct from vec2's collisions)
export const energy = (v: { x: number; y: number; z: number }): number => vec3.lengthSq(v);
