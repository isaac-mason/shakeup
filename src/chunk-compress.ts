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
// RE-PARSING IS THE POINT, not a limitation routed around. By the time a chunk is assembled every
// per-module concern — renames, dropped imports, unwrapped exports, `linked` maps keyed by
// `(mod, sym)` — is already baked into the text, so the compressor needs none of it. rolldown's
// `dce_or_minify` takes `source_text` for the same reason.
import { analyze, createSemantic } from './analysis/semantic';
import { buildLineTable } from './sourcemap';
import type { Mappings } from './sourcemap';
import { runCompress } from './passes/compress';
import { parse } from './parser';
import { printModule } from './print/print-js';
import { createPrinter, finishPrinter } from './print/printer';
import type { PrintOptions } from './print/printer';

export type ChunkCompressResult = { code: string; map: Mappings | null };

/** Compress `code` as one program. `wantMap` produces chunk→compressed mappings for the caller to
 *  compose with the module→chunk mappings it already holds. */
export function compressChunk(code: string, opts: PrintOptions, wantMap: boolean): ChunkCompressResult {
    // The chunk is emitted JavaScript in module goal — never TS, never JSX by this stage.
    const parsed = parse(code, { ts: false, jsx: false, kind: 'module' });
    // A chunk we just emitted must parse; if it does not, that is a printer bug and the right move is
    // to surface the original rather than silently ship a half-compressed chunk.
    if (parsed.errors !== undefined && parsed.errors.length > 0) return { code, map: null };
    const semantic = createSemantic();
    analyze(semantic, parsed.program);
    runCompress(parsed.program, semantic, 'full');
    const printer = createPrinter(opts, wantMap ? { srcLines: Uint32Array.from(buildLineTable(code)), sourceIdx: 0 } : {});
    printModule(printer, parsed.program);
    return { code: finishPrinter(printer), map: printer.map };
}
