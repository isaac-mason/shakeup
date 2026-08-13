import type { ShapeDef } from './registry';

// `satisfies` must be stripped; the value survives.
export const def = {
    name: 'circle',
    // area of a circle with radius = size; use 3 as a stand-in PI so the
    // simulation stays exactly hand-computable (no float PI).
    area: (size: number): number => 3 * size * size,
} satisfies ShapeDef;
