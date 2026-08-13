import type { ShapeDef } from './registry';

// second def object — `as ShapeDef` cast must be stripped.
export const def = {
    name: 'box',
    area: (size: number): number => size * size,
} as ShapeDef;
