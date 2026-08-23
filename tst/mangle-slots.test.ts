import { describe, expect, it } from 'vitest';
import { assignSlots, SLOT_UNASSIGNED } from '../src/mangle/slots';

// Hand-derived from the ported oxc `SlotAssignment::compute` algorithm. Each case's expected slots
// are traced by hand against the liveness rule (a slot is live from each use up to, excluding, the
// declaration scope; a symbol used only in its own scope has empty liveness → freely reusable).

describe('assignSlots — slot-liveness graph colouring', () => {
    it('reuses an outer name across sibling functions that do not reference it', () => {
        // root(0): A(0) used only at root, B(1) used in BOTH foo+bar, f(2) used at root.
        // foo(1)⊂root: x(3) used in foo.   bar(2)⊂root: y(4) used in bar.
        const { slots, totalSlots } = assignSlots({
            scopeCount: 3,
            root: 0,
            parent: [0, 0, 0],
            bindingsByScope: [[0, 1, 2], [3], [4]],
            refScopes: [[0], [1, 2], [0], [1], [2]],
            declScopes: [[0], [0], [0], [1], [2]],
            symbolCount: 5,
        });
        // A is used only at root → empty liveness → its slot 0 is reused by x (foo) and y (bar).
        // B is live in foo AND bar → blocks reuse there → keeps slot 1 alone.
        expect([...slots]).toEqual([0, 1, 2, 0, 0]);
        expect(totalSlots).toBe(3);
    });

    it('a name live across intermediate scopes blocks reuse on that path only', () => {
        // root(0): T(0) declared at root but used in the INNERmost scope.
        // outer(1)⊂root: o(1) used in outer.   inner(2)⊂outer: n(2) used in inner.
        const { slots, totalSlots } = assignSlots({
            scopeCount: 3,
            root: 0,
            parent: [0, 0, 1],
            bindingsByScope: [[0], [1], [2]],
            refScopes: [[2], [1], [2]],
            declScopes: [[0], [1], [2]],
            symbolCount: 3,
        });
        // T is live through outer→inner (used in inner, declared at root) → slot 0 blocked there.
        // o (outer, used only in outer) has empty liveness → n (inner) reuses o's slot 1.
        expect([...slots]).toEqual([0, 1, 1]);
        expect(totalSlots).toBe(2);
    });

    it('same-scope bindings never share a slot', () => {
        const { slots } = assignSlots({
            scopeCount: 2,
            root: 0,
            parent: [0, 0],
            bindingsByScope: [[], [0, 1, 2]],
            refScopes: [[1], [1], [1]],
            declScopes: [[1], [1], [1]],
            symbolCount: 3,
        });
        expect(new Set(slots).size).toBe(3);
    });

    it('a hoisted `var` stays live in the BLOCK it is written in (declScopes)', () => {
        // `function f() { { var x; let y; } }` — x is OWNED by the function scope (hoisted) but
        // physically declared in the block, where `y` also lives. They coexist, so they must NOT
        // share a slot. Only `declScopes` carries this: x has no references at all, so without it
        // x's liveness would be empty and `y` would wrongly reuse x's slot (same name for both).
        const { slots, totalSlots } = assignSlots({
            scopeCount: 3,
            root: 0,
            parent: [0, 0, 1],
            bindingsByScope: [[], [0], [1]], // fn scope owns x(0); block owns y(1)
            refScopes: [[], [2]],
            declScopes: [[2], [2]], // x's declaring identifier physically sits in the block
            symbolCount: 2,
        });
        expect([...slots]).toEqual([0, 1]);
        expect(totalSlots).toBe(2);
    });

    it('leaves symbols with no binding entry unassigned', () => {
        const { slots } = assignSlots({
            scopeCount: 1,
            root: 0,
            parent: [0],
            bindingsByScope: [[0]],
            refScopes: [[0], []],
            declScopes: [[0], []],
            symbolCount: 2,
        });
        expect(slots[1]).toBe(SLOT_UNASSIGNED);
    });
});
