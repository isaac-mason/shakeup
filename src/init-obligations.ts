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
import type { ImportRecord, Linked } from './graph-types';

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
