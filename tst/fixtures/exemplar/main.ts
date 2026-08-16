// Entry. Order matters: the side-effect import comes FIRST — its observable
// result (registry.size === 2) proves it ran exactly once.
import './shapes/register-all';

import config from './config'; // anonymous default (object literal)
import { Emitter } from './emitter';
import labelFor from './label'; // named default (function)
import { clamp } from './math'; // 3-deep named re-export chain (a->b->c)
import * as vec2 from './math/vec2'; // namespace import, calling style
import { Collide, MotionType, Phase } from './motion';
// mixed named / default / namespace imports
import { areaOf, registry } from './shapes/registry';
import { step } from './sim/integrate';
import type { Particle } from './types';

// local `x`/`y` that COLLIDE with vec2.splat's shorthand locals after renaming
const x = 100;
const y = 200;

// a DYNAMIC particle, integrated two deterministic steps of dt=1
const p0: Particle = {
    pos: vec2.create(0, 0),
    vel: vec2.create(2, 1),
    mass: 1,
    motion: MotionType.DYNAMIC,
};
const p1 = step(p0, 1); // {2,1}
const p2 = step(p1, 1); // {4,2}

// class: instantiate + drive it
const emitter = new Emitter({ x: 10 });
const spawnA = emitter.spawn(); // {11, 0}
const spawnB = emitter.spawn(); // {12, 0}

// registry-driven areas (side-effect module must have populated it)
const circleArea = areaOf('circle', 2); // 3*2*2 = 12
const boxArea = areaOf('box', 2); // 2*2 = 4

// enum reverse mapping + flags + string enum
const motionName = MotionType[MotionType.DYNAMIC]; // 'DYNAMIC'
const collideBoth = Collide.BOTH; // 1 | 4 = 5
const phaseLive = Phase.LIVE; // 'live'

// deterministic snapshot — every number hand-computable and asserted exactly
export const snapshot = {
    finalPos: p2.pos, // {4,2}
    spawnA, // {11,0}
    spawnB, // {12,0}
    total: emitter.total?.() ?? -1, // 2
    circleArea, // 12
    boxArea, // 4
    clamped: clamp(5, 0, 3), // 3
    label: labelFor('/a/b/circle.ts'), // 'shape:circle'
    gravity: config.gravity, // 10
    sepLen: config.sepLen, // 1
    splatCollision: { x, y, splat: vec2.splat(7) }, // {x:100,y:200,splat:{x:7,y:7}}
};

// registry.size proves the side-effect module ran exactly once (2 shapes)
export const registrySize = registry.size; // 2

export const enums = { motionName, collideBoth, phaseLive };

// re-exports: named `export { ... } from` and `export * as ops from`
export { clamp } from './math';
export * as ops from './math/vec2';
