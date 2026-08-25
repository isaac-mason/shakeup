// Does reusing a cleared Semantic beat allocating a fresh one?
//
// `analyze(out, program)` opens with `resetSem(out)`, whose doc says "Reset a warm Semantic for
// reuse across analyze() calls" — but INSTRUMENTATION SHOWS THE REUSE PATH IS NEVER TAKEN: all 287
// analyze() invocations in a crashcat bundle receive a freshly-allocated Semantic, because every
// call site is `semantic = createSemantic(); analyze(semantic, program)`. So `resetSem` is either an
// unrealised optimisation or dead code, and this bench decides which.
//
// oxc's motivation for the equivalent: its minifier passes `builder.with_stats(stats)` from the
// FIRST semantic build into the pre-mangle rebuild, so the rebuild pre-allocates capacity for
// AstNodes/ScopeTree/SymbolTable instead of growing from zero (oxc_semantic/src/stats.rs). JS `Map`
// takes no capacity hint, so the only available analogue is reusing a container that ALREADY grew.
// That only helps if V8's `Map.prototype.clear()` PRESERVES the backing store's capacity rather than
// resetting it — which is exactly what this measures.
//
// Sizes are the real ones from a crashcat bundle: median 94 symbols / 98 bindings / 87 refs per
// analyze, max 746 / 766 / 724.
//
// Paired round-robin with a negative control, for the reasons in ./lex-dispatch.paired.ts: labs
// measures each arm in its own window and this machine's comparison resolution is ~+-33%.

type Sem = {
    scopes: unknown[]; symbols: unknown[]; unresolved: unknown[];
    names: Map<string, number>; bindings: Map<number, number>; nodeScope: Map<unknown, number>;
    refs: Map<number, { reads: number; writes: number }>; uses: Map<number, number>;
    shorthand: Set<number>; exported: Set<number>; symbolInit: Map<number, unknown>;
};

function createSem(): Sem {
    return {
        scopes: [{ parent: 0, flags: 0, node: null }], symbols: [{ scope: 0, decl: null, flags: 0, nameId: 0 }],
        unresolved: [], names: new Map(), bindings: new Map(), nodeScope: new Map(),
        refs: new Map(), uses: new Map(), shorthand: new Set(), exported: new Set(), symbolInit: new Map(),
    };
}
function resetSem(o: Sem): void {
    o.scopes.length = 1; o.symbols.length = 1; o.unresolved.length = 0;
    o.names.clear(); o.bindings.clear(); o.nodeScope.clear(); o.refs.clear();
    o.uses.clear(); o.shorthand.clear(); o.exported.clear(); o.symbolInit.clear();
}

const NAMES: string[] = [];
for (let i = 0; i < 800; i++) NAMES.push(`ident_${i}_${(i * 2654435761) % 9973}`);
const KEYNODE: object[] = [];
for (let i = 0; i < 800; i++) KEYNODE.push({ k: i });

/** Fill a Semantic roughly the way analyze() does, at the measured per-module scale. */
function fill(o: Sem, n: number): void {
    const scopes = Math.max(1, n >> 2);
    for (let i = 0; i < scopes; i++) { o.scopes.push({ parent: 0, flags: 0, node: null }); o.nodeScope.set(KEYNODE[i % 800], i); }
    for (let i = 0; i < n; i++) {
        o.symbols.push({ scope: 0, decl: null, flags: 0, nameId: i });
        o.names.set(NAMES[i % 800], i);
        o.bindings.set(i * 8 + 1, i);
        o.refs.set(i, { reads: 1, writes: 0 });
        o.uses.set(i, 1);
        if ((i & 15) === 0) o.shorthand.add(i);
        if ((i & 31) === 0) o.exported.add(i);
    }
}

const N = Number(process.env.N ?? 94);
const PER_ROUND = 60; // analyze() calls simulated per timed round

// Arm A: fresh Semantic each time (today's behaviour at every call site).
function armFresh(): number {
    let acc = 0;
    for (let i = 0; i < PER_ROUND; i++) { const s = createSem(); fill(s, N); acc += s.symbols.length; }
    return acc;
}
// Arm A': byte-identical duplicate of A — the negative control.
function armFresh2(): number {
    let acc = 0;
    for (let i = 0; i < PER_ROUND; i++) { const s = createSem(); fill(s, N); acc += s.symbols.length; }
    return acc;
}
// Arm B: one Semantic, reset and refilled (the resetSem path that is currently never taken).
const WARM = createSem();
function armReuse(): number {
    let acc = 0;
    for (let i = 0; i < PER_ROUND; i++) { resetSem(WARM); fill(WARM, N); acc += WARM.symbols.length; }
    return acc;
}

const ARMS: [string, () => number][] = [
    ['A  fresh createSemantic() (today)', armFresh],
    ["A' identical copy of A (CONTROL)", armFresh2],
    ['B  reuse + resetSem()', armReuse],
];

// Correctness: all arms must produce the same totals.
{
    const vals = ARMS.map(([, f]) => f());
    if (new Set(vals).size !== 1) throw new Error(`arms disagree: ${vals.join(' vs ')}`);
}

const ROUNDS = Number(process.env.ROUNDS ?? 600);
for (let w = 0; w < 30; w++) for (const [, f] of ARMS) f();

const times: number[][] = ARMS.map(() => []);
for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < ARMS.length; k++) {
        const i = (r + k) % ARMS.length;
        const t0 = process.hrtime.bigint();
        ARMS[i][1]();
        times[i].push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
console.log(`\npaired round-robin — N=${N} symbols/analyze, ${PER_ROUND} analyze/round, ${ROUNDS} rounds`);
console.log(`${'arm'.padEnd(34)}${'median'.padStart(9)}${'speedup'.padStart(10)}${'faster'.padStart(11)}${'z'.padStart(8)}`);
for (let i = 1; i < ARMS.length; i++) {
    const ratios = times[0].map((t, r) => t / times[i][r]);
    const faster = ratios.filter((x) => x > 1).length;
    const z = (faster - ROUNDS / 2) / Math.sqrt(ROUNDS / 4);
    console.log(`${ARMS[i][0].padEnd(34)}${median(times[i]).toFixed(3).padStart(9)}${(median(ratios).toFixed(3) + 'x').padStart(10)}${(faster + '/' + ROUNDS).padStart(11)}${z.toFixed(1).padStart(8)}${Math.abs(z) > 3 ? '  <-- significant' : ''}`);
}
