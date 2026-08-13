// Shared registry map — crashcat def-object registry. register-all.ts mutates
// this on import (side effect). Everyone else reads it.

export type ShapeDef = {
    name: string;
    area: (size: number) => number;
};

// the shared mutable registry (a module-level Map struct)
export const registry = new Map<string, ShapeDef>();

export const register = (def: ShapeDef): void => {
    registry.set(def.name, def);
};

export const areaOf = (name: string, size: number): number => {
    const def = registry.get(name);
    return def === undefined ? 0 : def.area(size);
};
