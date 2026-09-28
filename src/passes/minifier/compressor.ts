// Port of oxc_minifier/src/compressor.rs: `dead_code_elimination_with_scoping` and `run_in_loop`.

import { refFor, retireSymbol, type Semantic } from '../../analysis/semantic.ts';
import { N, type Node, walk } from '../../ast/index.ts';
import { assertNoUnderPrune, finishNormalizePass, runPeepholePass } from './compression-pass.ts';
import type { CompressOptions } from './options.ts';
import { normalize } from './peephole/normalize.ts';
import type { CompressionMode, SourceType } from './state.ts';
import { ReferenceFlags, referenceIsRead, referenceIsWrite } from './syntax.ts';
import { createDceCtx, type DceCtx, referenceOf } from './traverse-context.ts';

export type DeadCodeEliminationResult = {
    /** Peephole passes run after the first, oxc's return value. */
    iterations: number;
    /** Whether the program was modified at all. */
    changed: boolean;
};

/** Fixed-point iteration loop for peephole optimizations. */
function runInLoop(maxIterations: number | null, program: Node, ctx: DceCtx): { iterations: number; changed: boolean } {
    let iteration = 0;
    let changed = false;
    // References minted during the loop are exempt from the under-prune check.
    const initialReferenceCount = ctx.scoping.references.length;
    // Consume Normalize's drops so pass 1 already sees the pruned counts, and so source-level dead
    // cycles (`function f() { f() }`) are visible to pass 1.
    finishNormalizePass(program, ctx);
    for (;;) {
        if (!runPeepholePass(program, ctx)) break;
        changed = true;
        if (maxIterations !== null) {
            if (iteration >= maxIterations) break;
        } else if (iteration > 10) {
            if (ctx.verify) throw new Error('dce: ran the peephole loop more than 10 times');
            break;
        }
        iteration++;
    }
    if (ctx.verify) assertNoUnderPrune(program, ctx, initialReferenceCount);
    return { iterations: iteration, changed };
}

/** Rewrite `semantic`'s reference facts from the references left in the program, and retire the
 *  symbols whose every declaration was removed, so the rest of the bundler sees the result. */
function finalizeSemantic(program: Node, ctx: DceCtx): void {
    const semantic = ctx.scoping.semantic;
    const symbolCount = ctx.scoping.symbolsWithBindings.length;
    const firstLiveBinding: (Node | undefined)[] = new Array(symbolCount);
    const declarationIsLive = new Uint8Array(symbolCount);
    const declarationPairs = semantic.declPairs;
    const liveBindingIds = declarationPairs === null ? null : new Set<number>();
    for (let symbolId = 1; symbolId < semantic.refs.length; symbolId++) semantic.refs[symbolId] = undefined;
    for (let symbolId = 1; symbolId < semantic.uses.length; symbolId++) semantic.uses[symbolId] = 0;
    semantic.unresolved.length = 0;
    const referencePairs = semantic.refPairs;
    if (referencePairs !== null) referencePairs.length = 0;
    walk(program, (visited) => {
        if (visited.type === N.BindingIdentifier) {
            const symbolId = visited.sym;
            if (symbolId === 0) return;
            if (firstLiveBinding[symbolId] === undefined) firstLiveBinding[symbolId] = visited;
            if (semantic.symbols[symbolId]?.decl === visited) declarationIsLive[symbolId] = 1;
            if (liveBindingIds !== null) liveBindingIds.add(visited.id);
            return;
        }
        if (visited.type !== N.IdentifierReference) return;
        const reference = referenceOf(ctx, visited);
        // not a reference at all (an `export { a } from` name), which analysis never recorded either
        if (reference === null && visited.sym === 0) return;
        const symbolId = reference === null ? visited.sym : reference.symbolId;
        if (symbolId === 0) {
            semantic.unresolved.push(visited);
            return;
        }
        // An identifier no helper registered counts as a read: over-counting only forgoes an optimization.
        const flags = reference === null ? ReferenceFlags.Read : reference.flags;
        if (referenceIsRead(flags) || referenceIsWrite(flags)) {
            const counts = refFor(semantic, symbolId);
            if (referenceIsRead(flags)) counts.reads++;
            if (referenceIsWrite(flags)) counts.writes++;
        }
        semantic.uses[symbolId] = (semantic.uses[symbolId] ?? 0) + 1;
        if (referencePairs !== null) {
            let pairs = referencePairs[symbolId];
            if (pairs === undefined) {
                pairs = [];
                referencePairs[symbolId] = pairs;
            }
            pairs.push(visited.id, reference === null ? 0 : reference.scopeId);
        }
    });
    for (let symbolId = 1; symbolId < symbolCount; symbolId++) {
        const binding = firstLiveBinding[symbolId];
        if (binding === undefined) {
            if (ctx.scoping.symbolsWithBindings[symbolId] === 1) retireSymbol(semantic, symbolId);
            continue;
        }
        if (declarationIsLive[symbolId] === 0) semantic.symbols[symbolId].decl = binding;
        const pairs = declarationPairs === null ? undefined : declarationPairs[symbolId];
        if (declarationPairs !== null && liveBindingIds !== null && pairs !== undefined) {
            const kept: number[] = [];
            for (let index = 0; index < pairs.length; index += 2) {
                if (liveBindingIds.has(pairs[index])) kept.push(pairs[index], pairs[index + 1]);
            }
            declarationPairs[symbolId] = kept;
        }
    }
}

/**
 * oxc `Compressor::dead_code_elimination_with_scoping`, the tree-shake-only compressor rolldown runs
 * per module: Normalize with rolldown's `NormalizeOptions`, then the peephole loop to a fixed point.
 * `semantic` must describe `program`; unless `updateSemantic` is false, its reference counts are rewritten from
 * the result.
 */
export function eliminateDeadCode(
    program: Node,
    semantic: Semantic,
    options: CompressOptions,
    sourceType: SourceType,
    noSideEffectSymbols: ReadonlySet<number> = new Set(),
    verify = false,
    /** Rewrite `semantic` from the result; false when the caller discards it. */
    updateSemantic = true,
): DeadCodeEliminationResult {
    return compress(program, semantic, options, 'tree-shake-only', sourceType, noSideEffectSymbols, verify, updateSemantic);
}

/**
 * oxc `Compressor::build_with_scoping`, the full minifier's compressor: Normalize converting `while` to
 * `for`, `const` to `let` and dropping redundant `"use strict"`, then the peephole loop in full mode.
 * `semantic` must describe `program`; unless `updateSemantic` is false, its reference counts are rewritten from
 * the result.
 */
export function buildWithScoping(
    program: Node,
    semantic: Semantic,
    options: CompressOptions,
    sourceType: SourceType,
    noSideEffectSymbols: ReadonlySet<number> = new Set(),
    verify = false,
    /** Rewrite `semantic` from the result; false when the caller discards it. */
    updateSemantic = true,
): DeadCodeEliminationResult {
    return compress(program, semantic, options, 'full', sourceType, noSideEffectSymbols, verify, updateSemantic);
}

function compress(
    program: Node,
    semantic: Semantic,
    options: CompressOptions,
    mode: CompressionMode,
    sourceType: SourceType,
    noSideEffectSymbols: ReadonlySet<number>,
    verify: boolean,
    updateSemantic: boolean,
): DeadCodeEliminationResult {
    const ctx = createDceCtx(program, semantic, options, mode, sourceType, noSideEffectSymbols, verify);
    const full = mode === 'full';
    const normalized = normalize(program, ctx, {
        convertWhileToFors: full,
        convertConstToLet: full,
        removeUnnecessaryUseStrict: full,
    });
    const loop = runInLoop(options.maxIterations, program, ctx);
    if (updateSemantic) finalizeSemantic(program, ctx);
    return { iterations: loop.iterations, changed: normalized || loop.changed };
}
