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
import { dropDebugger } from './drop-debugger.ts';

/** The enabled compress passes, in application order. New passes (dead-code, fold-constants, …)
 *  register here; the fixed-point loop re-runs the whole set until nothing changes. */
const PASSES: Visitor[] = [dropDebugger];

/** Safety cap on the fixed-point loop (terser uses a similar bound) — a pass pair that oscillates
 *  never hangs the build. */
const MAX_ITERS = 8;

/** Run the compress passes over `program` to a fixed point. Returns a FRESH {@link Semantic}
 *  rebuilt from the compressed AST when anything changed (the caller swaps it in so all downstream
 *  sym-id lookups stay consistent), or `null` when the program was already minimal. */
export function runCompress(program: Node, semantic: Semantic): Semantic | null {
    let any = false;
    for (let i = 0; i < MAX_ITERS; i++) {
        if (!traverse(program, semantic, PASSES)) break;
        any = true;
    }
    if (!any) return null;
    const fresh = createSemantic();
    analyze(fresh, program);
    return fresh;
}
