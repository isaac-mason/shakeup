// Cosmetic compress over a WHOLE CHUNK, after linking and tree-shaking.
//
// WHY NOT PER MODULE. shakeup used to run its entire compress tier per module during scan, before
// tree-shaking — the only bundler that did. Every cosmetic decision was then made on partial
// information, and three separate mechanisms existed to paper over that: `crossModuleConstants` (so
// `if (DEBUG)` folds when `DEBUG` lives elsewhere), `stampPureCallsGraph` (post-link, because "the
// per-module pass inside `runCompress` cannot see across module boundaries"), and the
// touched-modules-are-re-compressed loop the first of those rides. Unfixed by any of them: `inline`
// decided single-use from INTRA-module counts, so a function used once from another module read as
// zero uses — a wrong decision, not a missed merge, and invisible to the byte gates.
//
// It also put statement-reshaping passes upstream of liveness, which produced two miscompiles in one
// day (`augmentedRefs`, declarator welding).
//
// WHAT THE PEERS DO. rolldown runs DCE per module pre-scan (`pre_process_ecma_ast.rs` step 5) and the
// full minifier per chunk post-shake (`minify_chunks.rs`); rspack minifies in `process_assets` over
// assets; rollup's minifier is a `renderChunk` plugin. oxc draws the same tier line we do —
// `CompressOptions::dce()` sets `join_vars: false` and `sequences: false`, exactly the transforms
// that caused the welding bug — and gives DCE its own entry point rather than an options flag,
// because it is a different PHASE, not a lesser intensity.
//
// SO: `dce` stays per module and cached (it feeds the purity analysis tree-shaking depends on); the
// cosmetic tier runs here instead, once, over the assembled chunk.
//
// THE CHUNK AS ONE PROGRAM. Every per-module concern (renames, dropped imports, unwrapped exports, the
// linker's rewrites) is settled by the module finalizer, and the chunk arrives as one program assembled
// from the finalized trees (`generate/chunk-program.ts`), so the compressor sees none of the link state.
// rolldown prints its modules and parses the chunk again to get the same program; building it directly
// skips that print and parse, and the map points straight at the module sources instead of being composed
// through the chunk text. Measured on crashcat, the re-parse and module printing were ~60ms of a ~290ms
// chunk pass.
import { resolveNoSideEffects } from '../analysis/purity.ts';
import { analyze, createSemantic } from '../analysis/semantic.ts';
import type { Node } from '../ast/index.ts';
import { mangleProgram } from '../mangle/program.ts';
import { setDropUnusedTopLevel } from '../passes/compress/drop-unused.ts';
import { type CompressMode, runCompress } from '../passes/compress/index.ts';
import { eliminateDeadCode } from '../passes/dce/compressor.ts';
import { rolldownChunkDceOptions } from '../passes/dce/options.ts';
import { printModule } from '../print/print-js.ts';
import type { PrinterConfig, PrintOptions, SourceRegion } from '../print/printer.ts';
import { createPrinter, finishPrinter } from '../print/printer.ts';
import type { Mappings } from '../util/sourcemap.ts';
import { trimMappings } from '../util/sourcemap.ts';
import { RESERVED } from './deconflict.ts';

export type ChunkCompressResult = { code: string; map: Mappings | null };

/** A chunk as one program: the tree, the text its positions and comments index, and the original source each
 *  position maps to. */
export type ChunkProgram = {
    program: Node;
    src: string;
    comments: Int32Array;
    /** Positions of `@__NO_SIDE_EFFECTS__` annotations. */
    noSideEffectsAt: readonly number[];
    /** Null when no map is wanted. */
    sources: SourceRegion[] | null;
};

/** Compress `chunk` and print it. Its map points wherever `chunk.sources` does. */
export function compressChunk(
    chunk: ChunkProgram,
    opts: PrintOptions,
    mangle: boolean,
    /** The compress tier to run: `'full'`, or `'dce'` for dead code only (rolldown's `dce-only` chunk pass). False for
     *  `{ mangle: true, compress: false }`, which still needs this pass — mangling has nowhere else to run now that
     *  link-time mangling is gone. */
    compress: CompressMode | false,
    /** Which comment classes to keep; minification must not strip the licences this exists to preserve. */
    comments: { legal: boolean; jsdoc: boolean },
): ChunkCompressResult {
    const program = chunk.program;
    const semantic = createSemantic();
    analyze(semantic, program);
    // TOP-LEVEL drop-unused, enabled HERE and nowhere else. Per-module, `drop-unused` must not touch
    // module-scope bindings because treeshake has not run yet and another module may still reach
    // them. In this chunk it HAS run, the chunk is one closed program, and nothing downstream will
    // remove a top-level binding again — so the declarations that cross-module constant folding
    // strands (`let t=20,n="x",e=()=>21`, where rolldown emits just `const out=()=>21`) would
    // otherwise ship. Worth 243 raw / 146 brotli on crashcat, all of it provably dead.
    if (compress === 'dce') {
        // rolldown's `dce-only` chunk pass: oxc's tree-shake-only compressor over the chunk as one program
        eliminateDeadCode(
            program,
            semantic,
            rolldownChunkDceOptions(),
            'module',
            resolveNoSideEffects(program, chunk.noSideEffectsAt),
        );
    } else if (compress !== false) {
        setDropUnusedTopLevel(true);
        try {
            runCompress(program, semantic, compress);
        } finally {
            // Restored even if compress throws: the flag is module state shared with the per-module
            // pass, and leaking it there would let a top-level binding be dropped before treeshake
            // has had its say.
            setDropUnusedTopLevel(false);
        }
    }
    // A SECOND, FRESH semantic for the mangler — oxc's `Minifier::build` verbatim: one
    // `SemanticBuilder::build` for the compressor (`oxc_minifier/src/lib.rs:131`) and another for the
    // mangler (`:157`). Compress maintains reference COUNTS as it mutates, but nothing maintains the
    // scope a reference sits in, and oxc does not either — `Reference::scope_id` is write-once. So the
    // scopes the mangler reads have to come from a build over the tree as it now is.
    //
    // `true` opts into the per-symbol scope pairs, the way oxc's mangler build opts into
    // `with_build_nodes`/`with_class_table` that the compressor's build omits. The ~97 per-module
    // analyses stay on the cheap path.
    // MANGLE LAST, after the compressor has finished deleting things — otherwise short names are
    // spent on bindings that do not survive. See `mangle/program.ts`. No mangler, no second build: oxc's
    // `dce` has `mangle: None` and never builds one.
    let names: Map<number, string> | null = null;
    if (mangle) {
        const mangleSemantic = createSemantic(true);
        analyze(mangleSemantic, program);
        names = mangleProgram(program, mangleSemantic, new Set(RESERVED));
    }
    const cfg: PrinterConfig = chunk.sources === null ? {} : { sources: chunk.sources };
    cfg.comments = chunk.comments;
    cfg.src = chunk.src;
    // ordinary comments too, unless minifying: rolldown's `minify_chunks` codegen, `normal: !remove_whitespace`
    cfg.commentOpts = { ...comments, normal: !opts.minify };
    if (names !== null) cfg.nameOf = (idNode: Node) => (idNode.sym === 0 ? idNode.name : (names.get(idNode.sym) ?? idNode.name));
    const printer = createPrinter(opts, cfg);
    printModule(printer, program);
    const raw = finishPrinter(printer);
    // `trimMappings` drops the printer's trailing newline AND the mapping line that goes with it —
    // without it the composed map claims one more generated line than the chunk has, which shifts
    // nothing visibly but makes the map disagree with the code. `renderBody` does the same.
    return printer.map === null ? { code: raw, map: null } : { code: trimMappings(raw, printer.map), map: printer.map };
}
