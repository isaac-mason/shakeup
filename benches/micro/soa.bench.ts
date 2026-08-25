import { bench, group } from '@pmndrs/labs';

// ISOLATED REPRODUCTIONS of the storage patterns inside `analyze`, benchmarked BEFORE any source
// change. Four plausible-sounding optimisations were written into `src/` this session and then
// disproven by measurement; the rule now is that the pattern earns its place here first.
//
// Sizes come from a real analyze of three.core.js: 7,332 symbols, 94,036 references, 4,393 scopes.
// The access pattern is the real one too — a tally loop that reads-modify-writes per reference, with
// symbol ids drawn from a skewed distribution (a few symbols are referenced constantly, most once).
// TWO SCALES, because the corpora differ in shape and a win at one is not a win at the other:
//   big   — three.core.js is ONE module: 7,332 symbols, 26k references in a single Semantic.
//   small — crashcat is 97 modules, so each Semantic is ~75 symbols / ~970 references. Small maps are
//           fast, so this is where a typed-array rewrite could plausibly LOSE (it must allocate and
//           zero an array per module) — which is exactly why it is measured rather than assumed.
const SCALES = [
    { name: 'big (1 module)', symbols: 7_332, refs: 26_000, iters: 1 },
    { name: 'small (per module x97)', symbols: 75, refs: 970, iters: 97 },
] as const;

/** Symbol ids as `analyze` sees them: dense, small, and heavily skewed toward a hot minority. */
function refStream(symbols: number, refs: number): Int32Array {
    const out = new Int32Array(refs);
    let seed = 12345;
    const hot = Math.max(1, Math.floor(symbols / 10));
    for (let i = 0; i < refs; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        // 70% of references hit the first 10% of symbols — mirrors real identifier usage.
        out[i] = seed % 10 < 7 ? seed % hot : seed % symbols;
    }
    return out;
}

for (const S of SCALES) {
    group(`refs tally ${S.name} @micro @soa`, () => {
        bench('Map<number, {reads,writes}>', function* () {
            const stream = refStream(S.symbols, S.refs);
            yield () => {
                let total = 0;
                for (let m = 0; m < S.iters; m++) {
                    const refs = new Map<number, { reads: number; writes: number }>();
                    for (let i = 0; i < stream.length; i++) {
                        const sym = stream[i];
                        let c = refs.get(sym);
                        if (c === undefined) {
                            c = { reads: 0, writes: 0 };
                            refs.set(sym, c);
                        }
                        c.reads++;
                        if ((i & 7) === 0) c.writes++;
                    }
                    total += refs.size;
                }
                return total;
            };
        }).gc(true);

        bench('two Int32Arrays indexed by symbol', function* () {
            const stream = refStream(S.symbols, S.refs);
            yield () => {
                let total = 0;
                for (let m = 0; m < S.iters; m++) {
                    const reads = new Int32Array(S.symbols);
                    const writes = new Int32Array(S.symbols);
                    for (let i = 0; i < stream.length; i++) {
                        const sym = stream[i];
                        reads[sym]++;
                        if ((i & 7) === 0) writes[sym]++;
                    }
                    total += reads.length;
                }
                return total;
            };
        }).gc(true);
    });

    group(`uses counter ${S.name} @micro @soa`, () => {
        bench('Map<number, number> get+set', function* () {
            const stream = refStream(S.symbols, S.refs);
            yield () => {
                let total = 0;
                for (let m = 0; m < S.iters; m++) {
                    const uses = new Map<number, number>();
                    for (let i = 0; i < stream.length; i++) uses.set(stream[i], (uses.get(stream[i]) ?? 0) + 1);
                    total += uses.size;
                }
                return total;
            };
        }).gc(true);

        bench('Int32Array increment', function* () {
            const stream = refStream(S.symbols, S.refs);
            yield () => {
                let total = 0;
                for (let m = 0; m < S.iters; m++) {
                    const uses = new Int32Array(S.symbols);
                    for (let i = 0; i < stream.length; i++) uses[stream[i]]++;
                    total += uses.length;
                }
                return total;
            };
        }).gc(true);
    });
}

// ── REPRESENTATION AND RESIZING ───────────────────────────────────────────────────────────────────
// Two open questions before any of this reaches `src/`:
//
//  1. Is a plain `number[]` as good as `Int32Array`? V8 backs an all-smi array with PACKED_SMI_ELEMENTS
//     — unboxed machine words, so in principle it should match. It also GROWS, which `Int32Array` does
//     not. If it matches, the resizing question mostly evaporates.
//
//  2. What does RESIZING cost? The tally currently runs after `visit`, when `symbols.length` is final,
//     so an exact allocation is possible TODAY. But that is a fragile precondition to build on: any
//     future pass that mints a symbol mid-flight would need growth. So measure the pessimistic case —
//     start small and grow — against the exact-size case, and find out what the precondition is worth.
const GROW_FROM = 16;

group('representation: Int32Array vs number[] @micro @soa @repr', () => {
    const S = { symbols: 7_332, refs: 26_000 };

    bench('Int32Array, exact size', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const uses = new Int32Array(S.symbols);
            for (let i = 0; i < stream.length; i++) uses[stream[i]]++;
            return uses.length;
        };
    }).gc(true);

    bench('number[] fill(0), exact size', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const uses = new Array<number>(S.symbols).fill(0);
            for (let i = 0; i < stream.length; i++) uses[stream[i]]++;
            return uses.length;
        };
    }).gc(true);

    bench('number[] grown by push (no preallocation)', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const uses: number[] = [];
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                while (uses.length <= sym) uses.push(0);
                uses[sym]++;
            }
            return uses.length;
        };
    }).gc(true);

    bench('Int32Array grown by doubling + copy', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            let uses = new Int32Array(GROW_FROM);
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                if (sym >= uses.length) {
                    let cap = uses.length;
                    while (cap <= sym) cap *= 2;
                    const next = new Int32Array(cap);
                    next.set(uses);
                    uses = next;
                }
                uses[sym]++;
            }
            return uses.length;
        };
    }).gc(true);
});

// ── DECOMPOSING THE WIN: is it dropping the MAP, or dropping the OBJECTS? ──────────────────────────
// The comparison above changes TWO things at once — hashing becomes indexing, AND a per-symbol object
// becomes a primitive slot. That conflation would have justified a bigger refactor than the evidence
// supports, so isolate the middle ground: an ARRAY of monomorphic records indexed by symbol id. Same
// `{reads, writes}` shape the consumers already destructure, no hashing.
//
// Every object here is built by the SAME constructor path so V8 sees one hidden class — a
// deliberately monomorphic comparison, since a polymorphic version would be measuring the wrong thing.
group('decompose: Map vs record-array vs SoA @micro @soa @decompose', () => {
    const S = { symbols: 7_332, refs: 26_000 };

    bench('Map<number, {reads,writes}>', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const refs = new Map<number, { reads: number; writes: number }>();
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                let c = refs.get(sym);
                if (c === undefined) {
                    c = { reads: 0, writes: 0 };
                    refs.set(sym, c);
                }
                c.reads++;
                if ((i & 7) === 0) c.writes++;
            }
            return refs.size;
        };
    }).gc(true);

    bench('record[] indexed by sym, PREFILLED', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const refs: { reads: number; writes: number }[] = new Array(S.symbols);
            for (let i = 0; i < S.symbols; i++) refs[i] = { reads: 0, writes: 0 };
            for (let i = 0; i < stream.length; i++) {
                const c = refs[stream[i]];
                c.reads++;
                if ((i & 7) === 0) c.writes++;
            }
            return refs.length;
        };
    }).gc(true);

    bench('record[] indexed by sym, LAZY (holes)', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const refs: ({ reads: number; writes: number } | undefined)[] = new Array(S.symbols);
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                let c = refs[sym];
                if (c === undefined) {
                    c = { reads: 0, writes: 0 };
                    refs[sym] = c;
                }
                c.reads++;
                if ((i & 7) === 0) c.writes++;
            }
            return refs.length;
        };
    }).gc(true);

    bench('two Int32Arrays (SoA)', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const reads = new Int32Array(S.symbols);
            const writes = new Int32Array(S.symbols);
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                reads[sym]++;
                if ((i & 7) === 0) writes[sym]++;
            }
            return reads.length;
        };
    }).gc(true);
});

// ── HOW CLOSE CAN AN OBJECT FORM GET TO SoA? ──────────────────────────────────────────────────────
// `record[]` captured 90% of the saving while keeping `{reads, writes}` — worth pushing further,
// because every metre closed here is refactor NOT spent rewriting four passes to `reads[sym]`.
//
// Two levers left on the object side:
//   • CLASS instances — one constructor, so V8 fixes the hidden class up front rather than
//     transitioning through it on each literal.
//   • REUSE — `analyze` already recycles its `Semantic` ("reuse it across analyze() calls to keep warm
//     capacity"), so the record array can persist and have its fields ZEROED instead of reallocated.
//     That removes per-call allocation entirely, which is what SoA's advantage really is.
// The SoA arm gets the same treatment (`fill(0)` on a kept buffer) so the comparison stays fair.
class RefCount {
    reads = 0;
    writes = 0;
}

group('object forms: how close to SoA? @micro @soa @objform', () => {
    const S = { symbols: 7_332, refs: 26_000 };

    bench('Map (baseline)', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const refs = new Map<number, { reads: number; writes: number }>();
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                let c = refs.get(sym);
                if (c === undefined) { c = { reads: 0, writes: 0 }; refs.set(sym, c); }
                c.reads++;
                if ((i & 7) === 0) c.writes++;
            }
            return refs.size;
        };
    }).gc(true);

    bench('literal record[], lazy', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const refs: ({ reads: number; writes: number } | undefined)[] = new Array(S.symbols);
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                let c = refs[sym];
                if (c === undefined) { c = { reads: 0, writes: 0 }; refs[sym] = c; }
                c.reads++;
                if ((i & 7) === 0) c.writes++;
            }
            return refs.length;
        };
    }).gc(true);

    bench('class record[], lazy', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const refs: (RefCount | undefined)[] = new Array(S.symbols);
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                let c = refs[sym];
                if (c === undefined) { c = new RefCount(); refs[sym] = c; }
                c.reads++;
                if ((i & 7) === 0) c.writes++;
            }
            return refs.length;
        };
    }).gc(true);

    bench('class record[], REUSED + zeroed', function* () {
        const stream = refStream(S.symbols, S.refs);
        const refs: RefCount[] = new Array(S.symbols);
        for (let i = 0; i < S.symbols; i++) refs[i] = new RefCount();
        yield () => {
            for (let i = 0; i < S.symbols; i++) { const c = refs[i]; c.reads = 0; c.writes = 0; }
            for (let i = 0; i < stream.length; i++) {
                const c = refs[stream[i]];
                c.reads++;
                if ((i & 7) === 0) c.writes++;
            }
            return refs.length;
        };
    }).gc(true);

    bench('SoA Int32Array, fresh', function* () {
        const stream = refStream(S.symbols, S.refs);
        yield () => {
            const reads = new Int32Array(S.symbols);
            const writes = new Int32Array(S.symbols);
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                reads[sym]++;
                if ((i & 7) === 0) writes[sym]++;
            }
            return reads.length;
        };
    }).gc(true);

    bench('SoA Int32Array, REUSED + fill(0)', function* () {
        const stream = refStream(S.symbols, S.refs);
        const reads = new Int32Array(S.symbols);
        const writes = new Int32Array(S.symbols);
        yield () => {
            reads.fill(0);
            writes.fill(0);
            for (let i = 0; i < stream.length; i++) {
                const sym = stream[i];
                reads[sym]++;
                if ((i & 7) === 0) writes[sym]++;
            }
            return reads.length;
        };
    }).gc(true);
});
