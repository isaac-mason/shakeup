import { describe, expect, it } from 'vitest';
import { NODE_TYPE_NAMES } from '../src/ast.ts';
import { ESTREE_MAP } from './estree-map.ts';

describe('estree-map', () => {
    // Belt + braces for runtime drift: the Record<TypeName, ...> type already
    // makes tsc enforce exhaustiveness, but assert the runtime key set matches
    // NODE_TYPE_NAMES exactly (no stray/missing keys) in case types get loose.
    it('keys equal NODE_TYPE_NAMES as sets', () => {
        const mapKeys = new Set(Object.keys(ESTREE_MAP));
        const names = new Set<string>(NODE_TYPE_NAMES);
        const missing = [...names].filter((n) => !mapKeys.has(n));
        const extra = [...mapKeys].filter((n) => !names.has(n));
        expect(missing, `missing mappings for: ${missing.join(', ')}`).toEqual([]);
        expect(extra, `stray mappings for: ${extra.join(', ')}`).toEqual([]);
        expect(mapKeys.size).toBe(names.size);
    });
});
