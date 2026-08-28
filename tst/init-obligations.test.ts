import { describe, expect, it } from 'vitest';
import type { ImportRecord, Linked } from '../src/graph-types.ts';
import { initRefForRecord, recordIsInitObligation } from '../src/init-obligations.ts';

// The single definition of "which wrapped modules must this record initialize" — see
// `init-obligations.ts`. rolldown keeps this in one file because three consumers each carried their
// own copy of the gating and drifted apart; these tests pin the predicate itself so the next consumer
// cannot quietly re-derive a different one.
const rec = (over: Partial<ImportRecord>): ImportRecord =>
    ({ specifier: './x', resolved: 3, external: false, kind: 'static', hasDynamicLiteral: false, ...over }) as ImportRecord;

const linkedWith = (esmInit: Map<number, number>): Linked => ({ esmInit }) as unknown as Linked;

describe('recordIsInitObligation', () => {
    it('a static import carries a static-import obligation, not a require one', () => {
        const r = rec({ kind: 'static' });
        expect(recordIsInitObligation(r, 'static-import')).toBe(true);
        expect(recordIsInitObligation(r, 'require')).toBe(false);
    });

    it('a require carries a require obligation, not a static-import one', () => {
        const r = rec({ kind: 'require' });
        expect(recordIsInitObligation(r, 'require')).toBe(true);
        expect(recordIsInitObligation(r, 'static-import')).toBe(false);
    });

    it('a DYNAMIC import carries neither — rolldown gates on ImportKind::Import', () => {
        const r = rec({ kind: 'dynamic' });
        expect(recordIsInitObligation(r, 'require')).toBe(false);
        expect(recordIsInitObligation(r, 'static-import')).toBe(false);
    });

    it.each([
        ['external', rec({ external: true })],
        ['unresolved', rec({ resolved: -1 })],
    ])('%s records carry nothing', (_name, r) => {
        expect(recordIsInitObligation(r, 'require')).toBe(false);
        expect(recordIsInitObligation(r, 'static-import')).toBe(false);
    });
});

describe('initRefForRecord', () => {
    it('returns the target’s init symbol when it is lazily initialised', () => {
        expect(initRefForRecord(linkedWith(new Map([[3, 77]])), rec({ kind: 'require' }), 'require')).toBe(77);
    });

    it('returns undefined when the target is NOT lazy', () => {
        expect(initRefForRecord(linkedWith(new Map()), rec({ kind: 'require' }), 'require')).toBeUndefined();
    });

    it('returns undefined when the record does not carry the obligation, even if the target is lazy', () => {
        // The gate comes first: a lazy target reached through the wrong record kind is still no
        // obligation for that kind.
        const l = linkedWith(new Map([[3, 77]]));
        expect(initRefForRecord(l, rec({ kind: 'static' }), 'require')).toBeUndefined();
        expect(initRefForRecord(l, rec({ kind: 'dynamic' }), 'static-import')).toBeUndefined();
    });
});
