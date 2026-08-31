// Cross-module purity: run the interprocedural side-effect analysis over the whole module graph.
//
// The ANALYSIS lives in `analysis/purity.ts` and is deliberately graph-agnostic — `collect` and
// `stamp` take resolver closures rather than a module table, so the same machinery serves a single
// program and a whole bundle. This file is the bundler-side DRIVER that supplies those closures.
//
// It used to sit in `analysis/purity.ts`, which made that file — and with it the entire language
// toolchain — import the bundler's `Graph`/`Linked` data model for one function out of three. It was
// the last such import in `ast/ parser/ analysis/ passes/ print/ mangle/ util/`; see
// `llm/notes/bundler-toolchain-split-plan.md`.
//
// Runs AFTER link and BEFORE tree-shaking: proving an imported helper side-effect-free is what lets
// `isPureStatement` drop a discarded call to it. The per-module pass inside `runCompress` cannot see
// across module boundaries — scan analyses each module before link binds them together — so this is
// the point where the interprocedural answer becomes available.
import type { Node } from './ast/index.ts';
import { collect, solve, stamp, type Summary } from './analysis/purity.ts';
import type { Graph, Linked } from './graph-types.ts';
import { packRef } from './graph-types.ts';

/** Stamp every provably side-effect-free call across the graph. Returns whether anything changed. */
export function stampPureCallsGraph(graph: Graph, linked: Linked): boolean {
    /** Local symbol → a graph-wide key, following an import to the symbol that actually defines it. */
    const resolveIn =
        (idx: number) =>
        (sym: number): number | null => {
            if (!graph.modules[idx].namedImports.has(sym)) return packRef(idx, sym);
            const bind = linked.binds.get(packRef(idx, sym));
            return bind !== undefined && bind.kind === 'found' ? bind.ref : null;
        };

    const summaries = new Map<number, Summary>();
    // Candidate call sites per module, harvested by the collect walk so the stamp pass below needs no
    // walk of its own.
    const callsByModule = new Map<number, Node[]>();
    for (let idx = 0; idx < graph.modules.length; idx++) {
        const mod = graph.modules[idx];
        if (mod.program === null) continue;
        callsByModule.set(
            idx,
            collect(mod.program, summaries, (sym) => packRef(idx, sym), resolveIn(idx), mod.noSideEffects),
        );
    }
    if (summaries.size === 0) return false;
    solve(summaries);

    let stamped = false;
    for (const [idx, calls] of callsByModule) {
        if (stamp(calls, summaries, resolveIn(idx))) stamped = true;
    }
    return stamped;
}
