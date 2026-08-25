// Compress driver (minification P4) — runs the AST compress passes to a FIXED POINT over one
// module's program, mirroring esbuild's `minifySyntax` / terser's squeeze loop. Each pass is a
// `Visitor` that mutates via `ctx.replaceWith`/`remove`; `traverse` reports whether anything
// changed so we can re-run until stable.
//
// PLACEMENT (the load-bearing decision): compress runs in SCAN, right after the TS/JSX lowering
// transforms and BEFORE `extractRecords`, on the fresh-parse path only. That keeps it upstream of
// every sym-id-keyed index (namedImports/Exports, link binds), so a fresh `analyze` after compress
// yields a consistent semantic with no downstream desync — and the parse cache stores the already-
// compressed AST (its key is compress-aware, so a minify toggle busts it). Compress is a transform
// (syntactic lowering), not an output-format concern, so scan is its natural home.
//
// SEMANTIC FRESHNESS: passes that only need syntax (drop-debugger, dead-code, fold-constants) are
// safe across loop iterations. Ref-counting passes (the future drop-unused) will need the semantic
// refreshed mid-loop; today we refresh ONCE at the end (returning a fresh `Semantic` when anything
// changed) and will tighten to per-iteration when such a pass lands.
import { stampPureCalls } from '../../analysis/purity.ts';
import { emitRefFacts, REF, verifyRefFacts } from '../../analysis/ref-facts.ts';
import type { RefCounts } from '../../analysis/movement.ts';
import { analyze, createSemantic, type Semantic } from '../../analysis/semantic.ts';
import type { Node } from '../../ast.ts';
import { applyRefDelta, type RefDelta, traverse, type Visitor } from '../traverse.ts';
import { substituteAlternateSyntax } from './alternate-syntax.ts';
import { blockFlatten } from './block-flatten.ts';
import { booleanContext } from './boolean-context.ts';
import { aliasInline } from './alias-inline.ts';
import { coalesceVariableNames } from './coalesce.ts';
import { constProp } from './const-prop.ts';
import { convertToDottedProperties } from './dotted-properties.ts';
import { deadCode } from './dead-code.ts';
import { dropDebugger } from './drop-debugger.ts';
import { dropUnused } from './drop-unused.ts';
import { foldConstants } from './fold-constants.ts';
import { inline } from './inline.ts';
import { joinVars, joinVarsOnExit } from './join-vars.ts';
import { minimizeConditionalExpr } from './minimize-conditional.ts';
import { minimizeConditions } from './minimize-conditions.ts';
import { minimizeExitPoints } from './minimize-exit-points.ts';
import { minimizeNot } from './minimize-not.ts';
import { normalize } from './normalize.ts';
import { minimizeLogical } from './minimize-logical.ts';
import { removeUnusedExpr } from './remove-unused-expr.ts';

/** How much of the pipeline to run.
 *
 *  Port of oxc's `CompressionMode` (`oxc_minifier/src/state.rs:14`). oxc states the split precisely:
 *  tree-shake mode runs "only the ones that remove code, plus the constant folds those removals need
 *  … Passes that only shrink code (`substitute_*`, `minimize_*`) are left out" — the folds stay on
 *  because the removal passes don't evaluate compound conditions themselves (`if ('production' ===
 *  'production')` must fold to `true` before the dead branch can be dropped).
 *
 *  This is what lets OPTIMISATION run identically in dev and in a bundle: `'dce'` is every pass that
 *  changes which code EXISTS, so dev and bundle keep the same branches, the same removals and the
 *  same behaviour — `'full'` adds only the cosmetic byte-shaving on top. */
export type CompressMode = 'full' | 'dce';

/** A pass plus whether its ONLY purpose is smaller syntax. Kept as one ordered list (rather than two
 *  arrays) so filtering by mode cannot perturb the relative pass order the fixed point depends on. */
type TaggedPass = { pass: Visitor; cosmetic?: true };

/** Passes run to a FIXED POINT — they compose productively (fold turns `1<2`→`true`, dead-code then
 *  collapses `if(true)`), keeping booleans in their CANONICAL `true`/`false` form so fold-constants
 *  can reason about them. */
const LOOP_PASSES: TaggedPass[] = [
    { pass: normalize },
    // Lifts the scaffolding blocks inlining emits, so the passes below see straight-line code.
    // Cosmetic: it reshapes without changing which code exists.
    { pass: blockFlatten, cosmetic: true },
    // `debugger` is dropped only for `'full'`: keeping the statement is the entire point in dev.
    { pass: dropDebugger, cosmetic: true },
    { pass: constProp },
    // Alias inline (compilecat `inline_variables` path 3): `const b = a` → reads of `b` become `a`.
    // Sits next to const-prop — both are pure read-substitutions that leave the dead declarator to
    // drop-unused. Cosmetic: it renames references, it does not expose new dead code.
    { pass: aliasInline, cosmetic: true },
    { pass: deadCode },
    { pass: foldConstants },
    // Turns an early-return guard into a negated `if`; the passes below finish the job.
    { pass: minimizeExitPoints, cosmetic: true },
    { pass: minimizeConditions, cosmetic: true },
    { pass: minimizeNot, cosmetic: true },
    { pass: minimizeConditionalExpr, cosmetic: true },
    { pass: minimizeLogical, cosmetic: true },
    { pass: booleanContext, cosmetic: true },
    { pass: convertToDottedProperties, cosmetic: true },
    // Single-use inline is full-only, matching oxc: `inline_identifier_reference` sits in the
    // full-mode branch of `exit_expression`, outside the tree-shake branch.
    { pass: inline, cosmetic: true },
    { pass: removeUnusedExpr },
    { pass: joinVars, cosmetic: true },
    { pass: dropUnused },
];

/** Passes run ONCE, after the loop settles — final byte-shaving substitutions that must NOT re-enter
 *  the loop. `substituteAlternateSyntax` (`true`→`!0`) is the canonical example: inside the loop it
 *  would ping-pong forever against fold-constants (`!0`→`true`), so it runs last, once. Entirely
 *  cosmetic, so `'dce'` skips this traversal altogether. */


// A SECOND final traversal, run after `FINAL_PASSES` completes. `substituteAlternateSyntax` rewrites
// `const` → `let`, which turns declaration runs that were previously unmergeable (a `let` run split by
// a `const` run) into one mergeable run — a real byte win. It must be its own traversal: `traverse`
// applies every visitor in ONE walk, and `joinVars` rewrites a statement LIST on the way down, before
// descent reaches the child declarations whose `kind` the substitution is about to change.
const FINAL_AND_JOIN: Visitor[] = [substituteAlternateSyntax, joinVarsOnExit];

/** Closure's placement for `CoalesceVariableNames`: ONCE, LATE, after everything else has settled —
 *  never inside the fixed point. It must follow `substituteAlternateSyntax` (which rewrites `const`→
 *  `let`), because a coalesced binding is assigned after its declaration and `const` forbids that.
 *  Closure marks the AST un-normalised from here and runs a peephole cleanup afterwards, since
 *  coalescing "creates identity assignments and more redundant code". We do NOT: the pass drops its own
 *  identity assignments at the point it would create them, and the `refresh()` below already covers the
 *  symbol changes. An explicit cleanup traversal plus a second `analyze()` was measured at more than
 *  HALF this pass's cost while changing not one byte of output. */
const COALESCE_PASSES: Visitor[] = [coalesceVariableNames];

/**
 * Coalescing is OFF by default — **because it makes COMPRESSED output BIGGER**, which is the size that
 * actually ships. Measured on both corpora, and they agree:
 *
 *   three.core.js       raw −0.121%   gzip **+0.041%**   brotli **+0.060%**
 *   three/src (750 mod) raw −0.121%   gzip **+0.077%**   brotli **+0.147%**
 *
 * This CONTRADICTS Closure's own stated rationale ("less unique variables in hope for better renaming,
 * and finally better gzip compression"). The likely reason it no longer holds: gzip thrives on
 * REPETITION, and a pipeline that has already mangled every local to one or two characters emits long
 * runs of near-identical `let a=…;let b=…` text that compress extremely well. Coalescing deletes some
 * of those declarations and replaces them with bare assignments, trading a few raw bytes for a less
 * regular token stream. Closure's claim may predate this much aggressive mangling.
 *
 * The pass itself is correct, tested (`tst/coalesce.test.ts`), and now cheap: +3.2% build time, down
 * from +28.8% (see below). It stays in-tree because it is the only optimisation in the whole
 * Closure/compilecat audit that oxc and esbuild both lack, and because it is the right thing to enable
 * for a target that ships UNCOMPRESSED. It is simply not a win for the web.
 *
 * ⚠ KNOWN BUG, found the moment a better corpus was added: coalescing CRASHES on crashcat
 * (`tst/crashcat.corpus.test.ts`'s codebase) with `STALE SYM 65 (table size 64)` in treeshake —
 * removing a merged declaration shrinks the module's symbol table while some node still holds the old
 * id, so `sem.symbols[sym]` is undefined. three.js never reached it; 97 modules of real TypeScript did,
 * immediately. **Fix this before ever flipping the default**, and note that the fix is worth doing only
 * if the compressed-size result above is first overturned.
 *
 * COST REDUCTION, for the record — the first implementation cost +28.8% and profiling showed why:
 * coalescing's own analysis (scope walk, candidates, CFG, liveness, interference, colouring, rewrite)
 * totalled **66ms of a 3,538ms build**. The rest was machinery I had wrapped around it — an explicit
 * `refresh()` that the existing `if (finalChanged)` already performed, and a cleanup traversal for
 * identity assignments that the pass now drops at the point it would create them. Removing both changed
 * not one byte of output and took the cost from +28.8% → +9.8% → +3.2%.
 */
let COALESCE_ENABLED = false;
export const setCoalesceEnabled = (on: boolean): void => {
    COALESCE_ENABLED = on;
};

/** The loop passes for `mode`, in their canonical order. */
// MEMOISED PER MODE. `traverse` caches its per-node-type hook tables on the visitor ARRAY, so
// handing it a freshly-built array call (this runs once per module) would miss that cache every
// time. There are only a handful of modes, so one array each is kept for the process.
const LOOP_PASSES_BY_MODE = new Map<CompressMode, Visitor[]>();
const loopPassesFor = (mode: CompressMode): Visitor[] => {
    let v = LOOP_PASSES_BY_MODE.get(mode);
    if (v === undefined) {
        v = LOOP_PASSES.filter((t) => mode === 'full' || t.cosmetic !== true).map((t) => t.pass);
        LOOP_PASSES_BY_MODE.set(mode, v);
    }
    return v;
};

/** Safety cap on the fixed-point loop (terser uses a similar bound) — a pass pair that oscillates
 *  never hangs the build. */
/**
 * Incremental reference maintenance (oxc `PassChanges` / `flush_pass_changes`).
 *   'off'    — recompute the facts each round with `refreshRefs` (the shipped default until this is
 *              proven; a full walk, but never wrong).
 *   'on'     — apply the traversal's recorded deltas; no walk.
 *   'verify' — apply deltas AND recompute ground truth, throwing on any divergence. This is the
 *              development and test mode: subtree MOVES are the hazard (a pass that relocates a node
 *              and then drops its old parent double-counts the move as a removal), and a hand audit of
 *              every pass is exactly what this exists to replace.
 */
export type DeltaMode = 'off' | 'on' | 'verify';
// Default 'on': measured ~27% faster compress on three.core.js than recomputing the facts each round
// (interleaved, alternating order, same process — min 383ms -> 279ms, median 513ms -> 368ms), with
// byte-identical output on both corpora. Env-selectable so the WHOLE suite can be run under
// verification with `DELTA_MODE=verify pnpm test`; `tst/delta-refs-verify.test.ts` pins a subset.
let DELTA_MODE: DeltaMode = (process.env.DELTA_MODE as DeltaMode | undefined) ?? 'on';
export const setDeltaMode = (m: DeltaMode): void => {
    DELTA_MODE = m;
};

const MAX_ITERS = 8;

/** Run the compress passes over `program` (loop to a fixed point, then the one-shot final pass).
 *  Returns a FRESH {@link Semantic} rebuilt from the compressed AST when anything changed (the caller
 *  swaps it in so all downstream sym-id lookups stay consistent), or `null` when nothing changed. */
export function runCompress(program: Node, semantic: Semantic, mode: CompressMode = 'full'): Semantic | null {
    let any = false;
    let cur = semantic;
    const loop = loopPassesFor(mode);
    // Interprocedural purity runs ONCE up front, before the loop: it only ever ADDS information
    // (`CallExpression.pure`) that the removal passes then act on, so it belongs to the semantic tier
    // and runs in every mode. Stamping does not itself change the program, hence no `any = true`.
    stampPureCalls(program);
    /**
     * Between-round refresh. Recomputes ONLY the reference facts, in one walk over the already
     * resolved tree, instead of rebuilding the whole `Semantic`.
     *
     * WHY THIS IS ENOUGH, measured rather than argued. Running the loop with NO refresh at all costs
     * output size but never correctness (three +204 bytes, crashcat +1,646; across 1509 tests the only
     * failures were four `aliasInline` assertions that an optimization FIRED — stale counts are pure
     * over-counting, which is oxc's documented safe direction). Running it with a refs-only refresh is
     * BYTE-IDENTICAL to the full rebuild on both corpora. So the entire value of the old
     * `createSemantic() + analyze()` was its reference counts; the scopes, symbols, bindings and
     * `nodeScope` it also rebuilt were worth nothing between rounds — and `analyze` is not cheap, since
     * it re-creates every scope, re-declares every binding and re-runs `resolveRef`'s scope-chain walk
     * per reference (4.0% of profile on its own).
     *
     * `node.sym` is NOT reassigned, so symbol ids stay stable across rounds and every id already in
     * `symbols`/`bindings`/`symbolInit` remains valid.
     *
     * STALENESS THAT REMAINS, deliberately. `symbolInit` keeps entries for declarators later removed or
     * moved. That is safe because it is only ever read together with the FRESH counts: a symbol whose
     * declarator went away has no reads left, and both consumers skip on `reads === 0`. A future pass
     * that reads `symbolInit` WITHOUT checking counts would need this revisited.
     */
    const refreshRefs = (): void => {
        const refs = new Map<number, RefCounts>();
        const uses = new Map<number, number>();
        const shorthand = new Set<number>();
        const exported = new Set<number>();
        emitRefFacts(program, (sym, flags) => {
            if ((flags & (REF.READ | REF.WRITE)) !== 0) {
                let c = refs.get(sym);
                if (c === undefined) {
                    c = { reads: 0, writes: 0 };
                    refs.set(sym, c);
                }
                if ((flags & REF.READ) !== 0) c.reads++;
                if ((flags & REF.WRITE) !== 0) c.writes++;
            }
            uses.set(sym, (uses.get(sym) ?? 0) + 1);
            if ((flags & REF.SHORTHAND) !== 0) shorthand.add(sym);
            if ((flags & REF.EXPORTED) !== 0) exported.add(sym);
        });
        cur.refs = refs;
        cur.uses = uses;
        cur.shorthand = shorthand;
        cur.exported = exported;
    };

    /**
     * FULL rebuild — a genuinely fresh `Semantic`, symbol ids renumbered and `node.sym` reassigned.
     *
     * Needed exactly once, at the end: `runCompress` RETURNS this object and the caller installs it for
     * the downstream tier, where the MANGLER walks `symbols` to assign short names. A semantic that has
     * been carried through the loop still lists symbols whose declarations were deleted, so the mangler
     * would allocate names against a stale set — output the same LENGTH but with different identifiers,
     * which is exactly how this was caught (three.core.js unchanged at 381,846 bytes but a different
     * hash). Between rounds nothing reads that; `refreshRefs` is enough there.
     */
    /** Fold one round's signed movements into the maintained counts. */
    const applyDeltas = (delta: Map<number, RefDelta>): void => applyRefDelta(cur, delta);

    const refreshFull = (): void => {
        cur = createSemantic();
        analyze(cur, program);
    };
    for (let i = 0; i < MAX_ITERS; i++) {
        // No pre-pass at all: the reference facts every pass here reads (`refs`/`uses`/`shorthand`/
        // `exported`) are now maintained by `analyze` itself, which already walks every node and
        // already collects every reference. They were a SHARED prelude walk before that, and one
        // pre-pass PER PASS before that — 23.8% of this loop when last measured.
        //
        // The ordering that makes this sound: `refresh()` runs at the END of the previous round and
        // nothing mutates between there and here, so the facts describe exactly the tree this
        // traversal is about to see. Round 1 is the same case via the caller's own `analyze`.
        const delta = DELTA_MODE === 'off' ? null : new Map<number, RefDelta>();
        const changed = traverse(program, cur, loop, delta);
        if (!changed) break;
        any = true;
        // Rebuild semantic between iterations so ref-counting passes (drop-unused) see current
        // reference counts after this round's removals — the loop usually settles in 1–2 rounds.
        if (delta === null) refreshRefs();
        else {
            applyDeltas(delta);
            if (DELTA_MODE === 'verify') {
                const problems = verifyRefFacts(cur, program);
                if (problems.length > 0)
                    throw new Error(`incremental reference facts diverged after round ${i + 1}:\n  ${problems.slice(0, 20).join('\n  ')}`);
            }
        }
    }
    // Both final traversals are purely cosmetic — `'dce'` stops after the fixed point. They share a
    // single rebuild: `joinVars` only merges adjacent declarations (pure syntax, no symbol lookups),
    // so it does not need a semantic refreshed by `substituteAlternateSyntax` before it.
    if (mode === 'full') {
        // ONE walk: `substituteAlternateSyntax` on enter, `joinVarsOnExit` on exit, so the join sees
        // the `const` -> `let` rewrites its merging depends on. These were two full traversals.
        let finalChanged = traverse(program, cur, FINAL_AND_JOIN);
        if (COALESCE_ENABLED && traverse(program, cur, COALESCE_PASSES)) finalChanged = true;
        if (finalChanged) {
            any = true;
            refreshFull();
        }
    }
    return any ? cur : null;
}
