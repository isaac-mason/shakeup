// The compressor and mangler over a whole chunk, after linking and tree-shaking: rolldown's `minify_chunks`.
// `'dce'` is oxc's tree-shake-only compressor over the chunk, rolldown's default `'dce-only'`; `'full'` is
// oxc's `Minifier::minify`, the full compressor and then the mangler over a fresh semantic.
//
// THE CHUNK AS ONE PROGRAM. Every per-module concern (renames, dropped imports, unwrapped exports, the
// linker's rewrites) is settled by the module finalizer, and the chunk arrives as one program assembled
// from the finalized trees (`generate/chunk-program.ts`), so the compressor sees none of the link state.
// rolldown prints its modules and parses the chunk again to get the same program; building it directly
// skips that print and parse, and the map points straight at the module sources instead of being composed
// through the chunk text.
import { resolveNoSideEffects } from '../analysis/purity.ts';
import { analyze, createSemantic } from '../analysis/semantic.ts';
import type { Node } from '../ast/index.ts';
import { keepNamesFrom } from '../mangle/keep-names.ts';
import { buildWithSemantic } from '../mangle/mangler.ts';
import { buildWithScoping, eliminateDeadCode } from '../passes/minifier/compressor.ts';
import { rolldownChunkDceOptions, rolldownMinifyOptions } from '../passes/minifier/options.ts';
import { printModule } from '../print/print-js.ts';
import type { PrinterConfig, PrintOptions, SourceRegion } from '../print/printer.ts';
import { createPrinter, finishPrinter } from '../print/printer.ts';
import type { Mappings } from '../util/sourcemap.ts';
import { trimMappings } from '../util/sourcemap.ts';
import type { ChunkCompress } from './output-options.ts';

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
    /** False for `{ mangle: true, compress: false }`, which still needs this pass: the mangler runs nowhere else. */
    compress: ChunkCompress | false,
    /** Which comment classes to keep; minification must not strip the licences this exists to preserve. */
    comments: { legal: boolean; jsdoc: boolean },
    /** `output.keepNames`, which rolldown hands the compressor and the mangler as `keep_names`. */
    keepNames: boolean,
): ChunkCompressResult {
    const program = chunk.program;
    if (compress !== false) {
        const semantic = createSemantic();
        analyze(semantic, program);
        const noSideEffects = resolveNoSideEffects(program, chunk.noSideEffectsAt);
        if (compress === 'dce') eliminateDeadCode(program, semantic, rolldownChunkDceOptions(), 'module', noSideEffects);
        else buildWithScoping(program, semantic, rolldownMinifyOptions(undefined, keepNames), 'module', noSideEffects);
    }
    // A second, fresh semantic for the mangler, as oxc's `Minifier::build` makes one: the compressor keeps
    // reference counts as it mutates but not the scope each reference sits in.
    let names: Map<number, string> | null = null;
    let privateMemberMappings: Map<string, string>[] | null = null;
    if (mangle) {
        // rolldown's mangle options: `top_level` because the format is not IIFE (shakeup emits only ESM),
        // `keep_names` from `output.keepNames`, nothing reserved.
        const mangleSemantic = createSemantic(true);
        analyze(mangleSemantic, program, true);
        const mangled = buildWithSemantic(
            { topLevel: true, keepNames: keepNamesFrom(keepNames), reserved: new Set(), debug: false },
            mangleSemantic,
            program,
        );
        names = mangled.names;
        privateMemberMappings = mangled.classPrivateMappings;
    }
    const cfg: PrinterConfig = chunk.sources === null ? {} : { sources: chunk.sources };
    if (privateMemberMappings !== null) cfg.privateMemberMappings = privateMemberMappings;
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
