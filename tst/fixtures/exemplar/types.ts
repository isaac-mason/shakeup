// Types everywhere — none may survive into the bundle.

// type-only external import (must vanish entirely from the bundle)
import type { ParsedPath } from 'node:path';
import type { Vec2 } from './math/vec2';
import type { MotionType } from './motion';

export interface Particle {
    pos: Vec2;
    vel: Vec2;
    mass: number;
    motion: MotionType;
}

// interface with a computed key off an enum member
export interface MotionCosts {
    [MotionType.STATIC]: number;
    [MotionType.DYNAMIC]: number;
    [MotionType.KINEMATIC]: number;
}

// generic + conditional type alias
export type Unwrap<T> = T extends Array<infer U> ? U : T;

// tuple type
export type Bounds = [min: Vec2, max: Vec2];

// alias referencing an external type-only import (still vanishes)
export type PathInfo = ParsedPath;

// mapped/generic alias
export type Dict<V> = { [k: string]: V };
