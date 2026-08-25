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
