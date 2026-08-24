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
import { analyze, createSemantic, type Semantic } from '../../analysis/semantic.ts';
import type { Node } from '../../ast.ts';
import { traverse, type Visitor } from '../traverse.ts';
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
import { joinVars } from './join-vars.ts';
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
const FINAL_PASSES: Visitor[] = [substituteAlternateSyntax];

// A SECOND final traversal, run after `FINAL_PASSES` completes. `substituteAlternateSyntax` rewrites
// `const` → `let`, which turns declaration runs that were previously unmergeable (a `let` run split by
// a `const` run) into one mergeable run — a real byte win. It must be its own traversal: `traverse`
// applies every visitor in ONE walk, and `joinVars` rewrites a statement LIST on the way down, before
// descent reaches the child declarations whose `kind` the substitution is about to change.
const POST_FINAL_PASSES: Visitor[] = [joinVars];

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
const loopPassesFor = (mode: CompressMode): Visitor[] =>
    LOOP_PASSES.filter((t) => mode === 'full' || t.cosmetic !== true).map((t) => t.pass);

/** Safety cap on the fixed-point loop (terser uses a similar bound) — a pass pair that oscillates
 *  never hangs the build. */
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
    const refresh = (): void => {
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
        const changed = traverse(program, cur, loop);
        if (!changed) break;
        any = true;
        // Rebuild semantic between iterations so ref-counting passes (drop-unused) see current
        // reference counts after this round's removals — the loop usually settles in 1–2 rounds.
        refresh();
    }
    // Both final traversals are purely cosmetic — `'dce'` stops after the fixed point. They share a
    // single rebuild: `joinVars` only merges adjacent declarations (pure syntax, no symbol lookups),
    // so it does not need a semantic refreshed by `substituteAlternateSyntax` before it.
    if (mode === 'full') {
        let finalChanged = traverse(program, cur, FINAL_PASSES);
        if (traverse(program, cur, POST_FINAL_PASSES)) finalChanged = true;
        if (COALESCE_ENABLED && traverse(program, cur, COALESCE_PASSES)) finalChanged = true;
        if (finalChanged) {
            any = true;
            refresh();
        }
    }
    return any ? cur : null;
}
