import { describe, expect, it } from 'vitest';
import { base54 } from '../src/deconflict';
import { assignNames } from '../src/mangle/names';

describe('assignNames — rank + generate + apply', () => {
    it('gives the hottest slot the shortest name; symbols sharing a slot share the name', () => {
        // slots from the sibling-reuse case: A→0, B→1, f→2, x→0, y→0.
        // freq: slot0={A,x,y}=1+1+1=3 (hottest), slot1={B}=2, slot2={f}=1.
        const names = assignNames({
            slots: Int32Array.from([0, 1, 2, 0, 0]),
            totalSlots: 3,
            refCount: [1, 2, 1, 1, 1],
            isReserved: () => false,
            symbolCount: 5,
        });
        // A, x, y all share slot 0 → same name; B, f distinct.
        expect(names.get(0)).toBe(names.get(3));
        expect(names.get(0)).toBe(names.get(4));
        expect(new Set([names.get(0), names.get(1), names.get(2)]).size).toBe(3);
        // All three are the three shortest base54 names (one length bucket), handed out in slot order.
        expect(names.get(0)).toBe(base54(0)); // slot 0 (lowest id) gets the first name in the bucket
        expect(names.get(1)).toBe(base54(1));
        expect(names.get(2)).toBe(base54(2));
    });

    it('skips reserved candidate names', () => {
        const reserved = new Set([base54(0), base54(2)]);
        const names = assignNames({
            slots: Int32Array.from([0]),
            totalSlots: 1,
            refCount: [1],
            isReserved: (n) => reserved.has(n),
            symbolCount: 1,
        });
        expect(names.get(0)).toBe(base54(1)); // 0 and 2 reserved → first free is base54(1)
    });
});
