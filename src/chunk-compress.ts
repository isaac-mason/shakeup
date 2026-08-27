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
// RE-PARSING, AND WHY — this REVERSES an earlier recorded decision, so it needs its reasons stated.
//
// Architecturally it decouples: by the time a chunk is assembled every per-module concern — renames,
// dropped imports, unwrapped exports, `linked` maps keyed by `(mod, sym)` — is already baked into the
// text, so the compressor needs none of it. rolldown does the same, and composes the two maps the
// same way (`minify_chunks.rs` -> `dce_or_minify(source_text)` -> `collapse_sourcemaps`).
//
// But "rolldown does it" is NOT sufficient here, and `llm/notes/chunk-level-compress-plan.md` was
// right to say so: peers decide ORDERING, JavaScript's cost model decides IMPLEMENTATION. That plan
// chose to concatenate module ASTs instead, on a measured spike where re-parse + re-analyse was 60%
// of the pass (parse 199ms, analyze 139ms, of 563ms).
//
// That premise expired. The parser perf work moved those numbers; measured in situ on the real input
// (crashcat, 1,176,861b of dce-only chunk text -> 445,872b out, 469.4ms total):
//
//     parse 46.9ms (10%)   analyze 33.0ms (7%)   compress 334.7ms (71%)   mangle 24.5ms   print 30.3ms
//
// Re-parse + re-analyse is 17%, not 60%, and COMPRESS is now the cost. Concatenating module ASTs
// would buy back ~80ms of a ~240ms regression and would entangle the compressor with per-module link
// state to do it. If this is revisited, the target is the 335ms compressor, not the 47ms parse.
import { analyze, createSemantic } from './analysis/semantic';
import type { Node } from './ast';
import { RESERVED } from './deconflict';
import { mangleProgram } from './mangle/program';
import { parse } from './parser';
import { runCompress } from './passes/compress';
import { printModule } from './print/print-js';
import type { PrinterConfig, PrintOptions } from './print/printer';
import { createPrinter, finishPrinter } from './print/printer';
import type { Mappings } from './sourcemap';
import { buildLineTable, trimMappings } from './sourcemap';

export type ChunkCompressResult = { code: string; map: Mappings | null };

/** Compress `code` as one program. `wantMap` produces chunk→compressed mappings for the caller to
 *  compose with the module→chunk mappings it already holds. */
export function compressChunk(
    code: string,
    opts: PrintOptions,
    wantMap: boolean,
    mangle: boolean,
    /** Run the cosmetic compress tier. False for `{ mangle: true, compress: false }`, which still
     *  needs this pass — mangling has nowhere else to run now that link-time mangling is gone. */
    compress: boolean,
): ChunkCompressResult {
    // The chunk is emitted JavaScript in module goal — never TS, never JSX by this stage.
    const parsed = parse(code, { ts: false, jsx: false, kind: 'module' });
    // A chunk we just emitted must parse; if it does not, that is a printer bug and the right move is
    // to surface the original rather than silently ship a half-compressed chunk.
    if (parsed.errors !== undefined && parsed.errors.length > 0) return { code, map: null };
    const semantic = createSemantic();
    analyze(semantic, parsed.program);
    if (compress) runCompress(parsed.program, semantic, 'full');
    // MANGLE LAST, after the compressor has finished deleting things — otherwise short names are
    // spent on bindings that do not survive. See `mangle/program.ts`.
    const names = mangle ? mangleProgram(parsed.program, semantic, new Set(RESERVED)) : null;
    const cfg: PrinterConfig = wantMap ? { srcLines: Uint32Array.from(buildLineTable(code)), sourceIdx: 0 } : {};
    if (names !== null) cfg.nameOf = (idNode: Node) => (idNode.sym === 0 ? idNode.name : (names.get(idNode.sym) ?? idNode.name));
    const printer = createPrinter(opts, cfg);
    printModule(printer, parsed.program);
    const raw = finishPrinter(printer);
    // `trimMappings` drops the printer's trailing newline AND the mapping line that goes with it —
    // without it the composed map claims one more generated line than the chunk has, which shifts
    // nothing visibly but makes the map disagree with the code. `renderBody` does the same.
    return printer.map === null ? { code: raw, map: null } : { code: trimMappings(raw, printer.map), map: printer.map };
}
