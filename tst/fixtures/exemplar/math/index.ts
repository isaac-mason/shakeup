// math barrel.
//  - `export * as` namespace re-exports keep vec2/vec3's colliding names apart
//    (a bare `export *` of both would be ambiguous on add/dot/lengthSq/scale).
//  - `export * from './scalar-barrel'` is a bare star re-export.
//  - (a) top of the 3-deep NAMED chain: clamp/lerp resolve through
//    scalar-barrel (b) -> scalar (c).

export * as vec2 from './vec2';
export * as vec3 from './vec3';
export * from './scalar-barrel';
