// INIT OBLIGATIONS — the one place that answers "which wrapped modules must this record initialize,
// and does this record carry that obligation at all?".
//
// Modelled on rolldown's `esm_init_obligations.rs`, whose header records WHY it exists: three
// consumers (emit, cross-chunk registration, cycle projection) each carried their own copy of the
// gating, "which let them drift apart — the C-class under-projection holes were exactly such drift".
//
// shakeup has two consumers today, both on the REQUIRE path:
//   * `chunk-graph.ts` — cross-chunk registration, so a consumer chunk imports the init symbol.
//   * `bundle.ts`      — lowering a `require()` site to `(init_X(), __toCommonJS(ns))`.
// A third is coming: replacing an included STATIC import statement with `init_X()`, which is how
// rolldown gets evaluation order right (`cjs.md` §7.25d). Registration and emission for that one must
// stay in lockstep, "or a registered-but-never-emitted wrapper import (or vice versa) appears" — so
// the predicate lives here rather than being written a third time at the new call site.
import { N, type Node } from './ast';
import { type Graph, type ImportRecord, isEsmFormat, type Linked } from './graph-types';

/**
 * Which kind of reference is asking. rolldown's predicate opens with
 * `if rec.kind != ImportKind::Import { return false }` — its init obligations are about STATIC
 * IMPORTS only, because a `require()` is lowered to a call expression that sequences the init
 * itself. shakeup needs both questions answered, so the kind is a parameter rather than a hard gate.
 */
export type InitObligationKind =
    /** A `require('./x')` site: the init is sequenced into the call's value. */
    | 'require'
    /** A static `import './x'`: the init replaces the import STATEMENT, inheriting its source
     *  position — which is what makes evaluation order correct. */
    | 'static-import';

/** Does `rec` carry an init obligation of `kind`? Records that resolve to nothing, or to an
 *  external, never do. */
export function recordIsInitObligation(rec: ImportRecord, kind: InitObligationKind): boolean {
    if (rec.external || rec.resolved < 0) return false;
    return kind === 'require' ? rec.kind === 'require' : rec.kind === 'static';
}

/**
 * The init symbol this record must call, or `undefined` when the target is not lazily initialised.
 *
 * A target has one iff `link.ts` decided to put it behind an `__esm` closure — which is exactly
 * `linked.esmInit`. Reading that map through this function (rather than inline at each site) is the
 * point: it is the single definition of "this record initializes that module".
 */
export function initRefForRecord(linked: Linked, rec: ImportRecord, kind: InitObligationKind): number | undefined {
    if (!recordIsInitObligation(rec, kind)) return undefined;
    return linked.esmInit.get(rec.resolved);
}

/**
 * Does this static import RUN its target at the statement — and so have to survive tree-shaking?
 *
 * Two targets do. A lazily-initialised ES module runs when the `init_X()` that replaces this
 * statement is called. A wrapped CommonJS module runs when its interop namespace is built, which is
 * also emitted here (at the owning statement — `computeInteropOwners`). Both are what Node does:
 * `import './x'` evaluates `x`, whether or not anything reads a binding from it.
 *
 * Dropping such a statement as "pure" therefore drops the only thing that ever evaluates the module.
 * This is the lock that keeps registration and emission together: the statement stays alive here,
 * `chunk-graph.ts` gives the names it emits somewhere to come from, and `bundle.ts` emits them.
 */
export function staticImportRunsTarget(linked: Linked, rec: ImportRecord): boolean {
    if (!recordIsInitObligation(rec, 'static-import')) return false;
    return linked.esmInit.has(rec.resolved) || linked.cjsWrap.has(rec.resolved);
}

/**
 * WHO OWNS the interop namespace of a wrapped CommonJS module — `var import_b = __toESM(require_b())`.
 *
 * The obligation is the same shape as the ESM one and for the same reason: `import b from './b.cjs'`
 * evaluates `b.cjs` at the IMPORT STATEMENT, so that is where the call has to sit. Emitting it beside
 * the wrapper, at the producer's own slot, runs the module ahead of everything the importer does
 * first — which is exactly the `esm first, then cjs` divergence (`node=[e,b,main]`, ours `[b,e,main]`).
 *
 * It differs from the ESM init in one way, and the difference is not cosmetic: `init_X()` is
 * idempotent (`__esm` nulls its own `fn`), so every importer can call it and the repeats are free.
 * A `var` declaration is not idempotent — declaring it twice is a redeclaration, and evaluating it
 * twice would build a second, non-identical namespace object. So exactly ONE statement emits it and
 * the rest emit nothing, which is what rolldown does: with two importers of one `.cjs` it renders the
 * decl inside the FIRST importer's region and leaves the second's import statement empty.
 *
 * "First" is first in `linked.order` — the module evaluation order — and among that module's
 * statements, the first one importing the target. Only INCLUDED statements can own it: a dropped
 * statement emits nothing, so handing it ownership would lose the namespace entirely. When no
 * included statement wants it (the only consumers are `require()` calls, which sequence the init
 * themselves) there is no owner and the decl stays beside the wrapper, where it was.
 */
export type InteropOwner = { module: number; stmtId: number };

export function computeInteropOwners(
    graph: Graph,
    linked: Linked,
    liveOf: (module: number) => Set<number> | null,
    chunkByModule: Int32Array,
): Map<number, InteropOwner> {
    const owners = new Map<number, InteropOwner>();
    for (const modIdx of linked.order) {
        const mod = graph.modules[modIdx];
        if (mod === undefined) continue;
        const live = liveOf(modIdx);
        // The namespace an importer reads is chosen by ITS format (`link.ts`'s `cjsBind`), so the
        // owner of each of the two must itself be an importer of that format.
        const nsMap = isEsmFormat(mod.defFormat) ? linked.cjsNamespaceNode : linked.cjsNamespace;
        for (const stmt of (mod.program.data as { body: Node[] }).body) {
            if (stmt.type !== N.ImportDeclaration) continue;
            if (live !== null && !live.has(stmt.id)) continue;
            const source = (stmt.data as { source: Node }).source;
            if (source.type !== N.StringLiteral) continue;
            const spec = mod.source.slice(source.start + 1, source.end - 1);
            const rec = mod.importRecords.find((r) => r.specifier === spec && r.kind === 'static');
            if (rec === undefined || !recordIsInitObligation(rec, 'static-import')) continue;
            const nsRef = nsMap.get(rec.resolved);
            if (nsRef === undefined || owners.has(nsRef)) continue;
            // SAME CHUNK ONLY. The declaration lands wherever the owner is rendered, so an owner in
            // another chunk would move the namespace out of the chunk that exports it: the producer
            // chunk would export a binding it no longer declares while the owner's chunk both
            // imported and redeclared it. Across a boundary the producer chunk is fully evaluated
            // before the consumer's body runs anyway, so the decl stays beside the wrapper.
            if (chunkByModule[modIdx] !== chunkByModule[rec.resolved]) continue;
            owners.set(nsRef, { module: modIdx, stmtId: stmt.id });
        }
    }
    return owners;
}
