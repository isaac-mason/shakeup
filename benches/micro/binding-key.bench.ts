import { bench, group } from '@pmndrs/labs';

// `bindingKey(scopeId, ns, nameId) = (scopeId * 2 + ns) * 0x400000 + nameId` (semantic.ts:195).
//
// 0x400000 is 4,194,304, so the key exceeds 2**31 as soon as `scopeId * 2 + ns >= 512`, i.e. from
// scope id 256 upward. Past that a V8 Smi becomes a heap-allocated double, and every `bindings.get`
// hashes a boxed double instead of a tagged integer.
//
// This is not hypothetical: crashcat's largest module has 344 scopes and three.core.js has 817+, and
// `bindings.get` is the single biggest map consumer in a bundle at 231,478 calls (96,124 references at
// 2.08 scope hops each).
//
// Arms: the SAME lookups, differing only in whether the composite key stays inside Smi range.
const SCOPES = 817;      // three.core.js
const NAMES = 5_047;     // distinct interned names, measured
const LOOKUPS = 231_478; // measured bindings.get calls per bundle

const bindingKeyWide = (scopeId: number, ns: number, nameId: number): number => (scopeId * 2 + ns) * 0x400000 + nameId;
// Same information, packed to stay under 2**31: 15 bits of scope+ns, 16 bits of nameId.
const bindingKeySmi = (scopeId: number, ns: number, nameId: number): number => ((scopeId * 2 + ns) << 16) | nameId;

function fill(key: (s: number, ns: number, n: number) => number): Map<number, number> {
    const m = new Map<number, number>();
    for (let s = 1; s <= SCOPES; s++) for (let n = 0; n < 34; n++) m.set(key(s, 0, (s * 34 + n) % NAMES), s);
    return m;
}
const WIDE = fill(bindingKeyWide);
const SMI = fill(bindingKeySmi);

let EXPECT = -1;
const same = (v: number): number => {
    if (EXPECT === -1) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
};

group(`bindings.get — ${LOOKUPS.toLocaleString()} lookups, ${SCOPES} scopes`, () => {
    bench('composite key > 2**31 (today, heap double)', () => {
        let acc = 0;
        for (let i = 0; i < LOOKUPS; i++) {
            const s = 1 + (i % SCOPES);
            acc += WIDE.get(bindingKeyWide(s, 0, (s * 34 + (i % 34)) % NAMES)) ?? 0;
        }
        return same(acc);
    });
    bench('composite key > 2**31 (CONTROL)', () => {
        let acc = 0;
        for (let i = 0; i < LOOKUPS; i++) {
            const s = 1 + (i % SCOPES);
            acc += WIDE.get(bindingKeyWide(s, 0, (s * 34 + (i % 34)) % NAMES)) ?? 0;
        }
        return same(acc);
    });
    bench('composite key in Smi range (packed)', () => {
        let acc = 0;
        for (let i = 0; i < LOOKUPS; i++) {
            const s = 1 + (i % SCOPES);
            acc += SMI.get(bindingKeySmi(s, 0, (s * 34 + (i % 34)) % NAMES)) ?? 0;
        }
        return same(acc);
    });
});
