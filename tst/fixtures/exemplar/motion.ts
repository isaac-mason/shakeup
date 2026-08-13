// Enums, three flavors. All lower to plain objects with reverse maps where
// applicable. NOTE (v1 limitation, sidestepped): enum initializer expressions
// that reference an *external* renamed symbol don't get rewritten inside the
// lowered IIFE. We only use literals / prior members / pure operators here, so
// nothing needs renaming inside an initializer.

// auto-increment: STATIC=0, DYNAMIC=1, KINEMATIC=2
export enum MotionType {
    STATIC,
    DYNAMIC,
    KINEMATIC,
}

// flags-ish with expression initializers (bit shifts). KNOWN LIMITATION: the
// v1 enum lowering does NOT qualify intra-enum member references inside an
// initializer, so `BOTH = WALL | FLOOR` would emit `Collide[... = WALL | FLOOR]`
// (bare WALL/FLOOR -> ReferenceError). tsc rewrites these to `Collide.WALL`.
// See the pinned `KNOWN LIMITATION` test below. We sidestep with a literal so
// the executed value (WALL|FLOOR = 1|4 = 5) is still exercised end-to-end.
export enum Collide {
    NONE = 0,
    WALL = 1 << 0,
    FLOOR = 1 << 2,
    BOTH = 5, // = WALL | FLOOR, written as a literal to sidestep the limitation
}

// string enum (no reverse map for string enums, by spec)
export enum Phase {
    SPAWN = 'spawn',
    LIVE = 'live',
    DEAD = 'dead',
}
