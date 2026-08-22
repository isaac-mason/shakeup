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
import { analyze, createSemantic, type Semantic } from '../../analysis/semantic.ts';
import type { Node } from '../../ast.ts';
import { traverse, type Visitor } from '../traverse.ts';
import { substituteAlternateSyntax } from './alternate-syntax.ts';
import { constProp } from './const-prop.ts';
import { convertToDottedProperties } from './dotted-properties.ts';
import { deadCode } from './dead-code.ts';
import { dropDebugger } from './drop-debugger.ts';
import { dropUnused } from './drop-unused.ts';
import { foldConstants } from './fold-constants.ts';
import { joinVars } from './join-vars.ts';
import { minimizeConditions } from './minimize-conditions.ts';

/** Passes run to a FIXED POINT — they compose productively (fold turns `1<2`→`true`, dead-code then
 *  collapses `if(true)`), keeping booleans in their CANONICAL `true`/`false` form so fold-constants
 *  can reason about them. */
const LOOP_PASSES: Visitor[] = [
    dropDebugger,
    constProp,
    deadCode,
    foldConstants,
    minimizeConditions,
    convertToDottedProperties,
    joinVars,
    dropUnused,
];

/** Passes run ONCE, after the loop settles — final byte-shaving substitutions that must NOT re-enter
 *  the loop. `substituteAlternateSyntax` (`true`→`!0`) is the canonical example: inside the loop it
 *  would ping-pong forever against fold-constants (`!0`→`true`), so it runs last, once. */
const FINAL_PASSES: Visitor[] = [substituteAlternateSyntax];

/** Safety cap on the fixed-point loop (terser uses a similar bound) — a pass pair that oscillates
 *  never hangs the build. */
const MAX_ITERS = 8;

/** Run the compress passes over `program` (loop to a fixed point, then the one-shot final pass).
 *  Returns a FRESH {@link Semantic} rebuilt from the compressed AST when anything changed (the caller
 *  swaps it in so all downstream sym-id lookups stay consistent), or `null` when nothing changed. */
export function runCompress(program: Node, semantic: Semantic): Semantic | null {
    let any = false;
    let cur = semantic;
    const refresh = (): void => {
        cur = createSemantic();
        analyze(cur, program);
    };
    for (let i = 0; i < MAX_ITERS; i++) {
        if (!traverse(program, cur, LOOP_PASSES)) break;
        any = true;
        // Rebuild semantic between iterations so ref-counting passes (drop-unused) see current
        // reference counts after this round's removals — the loop usually settles in 1–2 rounds.
        refresh();
    }
    if (traverse(program, cur, FINAL_PASSES)) {
        any = true;
        refresh();
    }
    return any ? cur : null;
}
