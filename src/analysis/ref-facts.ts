// Reference-role classification over a RESOLVED tree (`node.sym` already assigned).
//
// `analyze` classifies the same roles while BUILDING the semantic, where resolution is deferred and
// the role has to ride the pending record. Once a tree is resolved the job is much simpler: walk it
// and read `node.sym` directly. Two consumers need exactly that:
//   • the compress prelude ORACLE, which derives the facts independently for the differential;
//   • incremental maintenance, which needs the contribution of a subtree being DROPPED so it can be
//     subtracted from the maintained counts without rebuilding the semantic.
//
// Both go through this one walker so the two directions can never disagree about what a reference IS.
// That symmetry is the whole safety argument: a subtree's contribution is subtracted using the same
// classification that added it. Getting `writes` wrong in particular is not a size regression — an
// under-counted write makes `aliasInline` believe a binding is never reassigned, and it will happily
// substitute across the reassignment.
import { N, type Node, walk, walkChildren } from '../ast.ts';
import { analyze, createSemantic, type Semantic } from './semantic.ts';

/** Syntactic role of a reference. Mirrors the private flags in `semantic.ts` deliberately. */
export const REF = {
    READ: 1,
    WRITE: 2,
    SHORTHAND: 4,
    EXPORTED: 8,
} as const;

export type RefEmit = (sym: number, flags: number) => void;

/** Emit every resolved reference under `root` with its role. Unresolved (`sym === 0`) is skipped. */
export function emitRefFacts(root: Node, emit: RefEmit): void {
    const hit = (n: Node, flags: number): void => {
        const sym = (n as { sym: number }).sym;
        if (sym !== 0) emit(sym, flags);
    };

    // `{ x }` / `{ x = 1 }` — the value is a reference that cannot be substituted by span, because
    // rewriting it in place would change the property NAME with it. Orthogonal to direction: a
    // shorthand appears both as a read (`const o = { x }`) and as a write (`({ x } = o)`).
    const shorthandProp = (data: { shorthand: boolean; value: Node }, base: number): boolean => {
        if (!data.shorthand) return false;
        const v = data.value;
        if (v.type === N.IdentifierReference) {
            hit(v, base | REF.SHORTHAND);
            return true;
        }
        if (v.type === N.AssignmentPattern) {
            const l = v.data.left;
            if (l.type === N.IdentifierReference) hit(l, base | REF.SHORTHAND);
            else target(l);
            visit(v.data.right);
            return true;
        }
        return false;
    };

    /** An assignment TARGET: the identifiers it binds are WRITES. A member target is the exception —
     *  `a.b = 1` sets a property, so `a` itself is READ, which is why those arms hand back to `visit`. */
    const target = (n: Node | null): void => {
        if (n === null) return;
        switch (n.type) {
            case N.IdentifierReference:
                hit(n, REF.WRITE);
                return;
            case N.ArrayExpression:
                for (const el of n.data.elements) if (el !== null) target(el);
                return;
            case N.ObjectExpression:
                for (const p of n.data.properties) target(p);
                return;
            case N.ObjectProperty:
                if (n.data.computed) visit(n.data.key);
                if (shorthandProp(n.data, REF.WRITE)) return;
                target(n.data.value);
                return;
            case N.SpreadElement:
            case N.RestElement:
                target(n.data.argument);
                return;
            case N.AssignmentExpression:
            case N.AssignmentPattern:
                target(n.data.left);
                visit(n.data.right);
                return;
            case N.StaticMemberExpression:
            case N.ComputedMemberExpression:
                visit(n);
                return;
            default:
                visit(n);
        }
    };

    const visit = (n: Node | null): void => {
        if (n === null) return;
        switch (n.type) {
            case N.IdentifierReference:
                hit(n, REF.READ);
                return;
            case N.BindingIdentifier:
                return; // a declaration is not a reference
            case N.AssignmentExpression: {
                const { operator, left, right } = n.data;
                // `x += 1` READS x as well as writing it; `x = 1` only writes.
                if (operator !== '=' && left.type === N.IdentifierReference) hit(left, REF.READ | REF.WRITE);
                else target(left);
                visit(right);
                return;
            }
            case N.UpdateExpression: {
                const arg = n.data.argument;
                if (arg.type === N.IdentifierReference) hit(arg, REF.READ | REF.WRITE);
                else visit(arg);
                return;
            }
            case N.ForInStatement:
            case N.ForOfStatement: {
                // `for (x of xs)` ASSIGNS to `x` each turn; only a VariableDeclaration head declares.
                if (n.data.left.type === N.VariableDeclaration) visit(n.data.left);
                else target(n.data.left);
                visit(n.data.right);
                visit(n.data.body);
                return;
            }
            case N.ObjectProperty:
                if (n.data.computed) visit(n.data.key);
                if (shorthandProp(n.data, REF.READ)) return;
                visit(n.data.value);
                return;
            case N.ExportSpecifier: {
                // `export { b }` — the specifier's `local` IS a reference, and substituting it would
                // rewrite the PUBLIC export name.
                const local = n.data.local;
                if (local.type === N.IdentifierReference) {
                    hit(local, REF.READ | REF.EXPORTED);
                    return;
                }
                break;
            }
            default:
                break;
        }
        walkChildren(n, visit);
    };

    visit(root);
}

/** Recompute the four reference facts for `program` from scratch. Ground truth. */
export function computeRefFacts(program: Node): {
    refs: Map<number, { reads: number; writes: number }>;
    uses: Map<number, number>;
    shorthand: Set<number>;
    exported: Set<number>;
} {
    const refs = new Map<number, { reads: number; writes: number }>();
    const uses = new Map<number, number>();
    const shorthand = new Set<number>();
    const exported = new Set<number>();
    emitRefFacts(program, (sym, flags) => {
        if ((flags & (REF.READ | REF.WRITE)) !== 0) {
            let c = refs.get(sym);
            if (c === undefined) {
                c = { reads: 0, writes: 0 };
                refs.set(sym, c);
            }
            if ((flags & REF.READ) !== 0) c.reads++;
            if ((flags & REF.WRITE) !== 0) c.writes++;
        }
        uses.set(sym, (uses.get(sym) ?? 0) + 1);
        if ((flags & REF.SHORTHAND) !== 0) shorthand.add(sym);
        if ((flags & REF.EXPORTED) !== 0) exported.add(sym);
    });
    return { refs, uses, shorthand, exported };
}

/**
 * Compare INCREMENTALLY MAINTAINED counts against ground truth recomputed from `program`.
 *
 * oxc's `debug_assert_no_over_prune` / `debug_assert_no_under_prune`. The two directions are NOT
 * equally serious and the report says which is which: a maintained count that is too HIGH costs an
 * optimization, a maintained count that is too LOW deletes a binding that is still referenced.
 */
export function verifyRefFacts(
    maintained: { refs: Map<number, { reads: number; writes: number }>; uses: Map<number, number> },
    program: Node,
): string[] {
    const truth = computeRefFacts(program);
    const out: string[] = [];
    const syms = new Set<number>([...truth.refs.keys(), ...maintained.refs.keys()]);
    for (const sym of syms) {
        const m = maintained.refs.get(sym);
        const t = truth.refs.get(sym);
        const mr = m?.reads ?? 0;
        const tr = t?.reads ?? 0;
        const mw = m?.writes ?? 0;
        const tw = t?.writes ?? 0;
        if (mr !== tr) out.push(`sym ${sym} reads maintained=${mr} truth=${tr} ${mr < tr ? 'UNDER(unsafe)' : 'over(safe)'}`);
        if (mw !== tw) out.push(`sym ${sym} writes maintained=${mw} truth=${tw} ${mw < tw ? 'UNDER(unsafe)' : 'over(safe)'}`);
    }
    for (const sym of new Set<number>([...truth.uses.keys(), ...maintained.uses.keys()])) {
        const mu = maintained.uses.get(sym) ?? 0;
        const tu = truth.uses.get(sym) ?? 0;
        if (mu !== tu) out.push(`sym ${sym} uses maintained=${mu} truth=${tu} ${mu < tu ? 'UNDER(unsafe)' : 'over(safe)'}`);
    }
    return out;
}

/** `SEMANTIC_VERIFY=1` differentially checks the maintained semantic against a fresh `analyze()` at
 *  every mutation boundary. Off by default (it rebuilds the whole semantic each time); the point is to
 *  run it in CI and whenever a pass that mutates structure is touched.
 *
 *  Lives here rather than in the compress driver because BOTH the compress loop and the optimize tier
 *  check it — flow-inline's block-scope escape lived in the optimize tier and was only caught two
 *  stages later, at a compress boundary. */
let SEMANTIC_VERIFY = process.env.SEMANTIC_VERIFY === '1';
export const semanticVerifyOn = (): boolean => SEMANTIC_VERIFY;
/** Enable programmatically. The env var is read at MODULE LOAD, so a test setting `process.env` in its
 *  body has no effect — the first version of `tst/semantic-verify.test.ts` did that and was vacuous. */
export const setSemanticVerify = (on: boolean): void => { SEMANTIC_VERIFY = on; };

/**
 * Differential check for ANY stage that mutates the AST while maintaining the semantic: does the
 * MAINTAINED semantic (built before the
 * lowerings, then kept current by `attachScopeNode` + the `RefDelta` the lowering traversals record)
 * still describe the tree well enough to replace a from-scratch `analyze()`?
 *
 * Reports only UNSAFE divergences, following oxc's own rule for its `PassChanges` bookkeeping: a
 * STALE EXTRA reference costs an optimization but stays correct, whereas a reference the tree
 * contains and the table does NOT know about produces incorrect output. Concretely:
 *
 *   - under-counted refs   -> a live symbol looks dead, `dropUnused` deletes a declaration still in
 *                             use. MISCOMPILE.
 *   - missing `nodeScope`  -> `scopeOf`/`ctx.currentScope` resolve names from the wrong scope, so
 *                             every hygiene check inside that region works from bad data.
 *   - partition mismatch   -> two nodes share a symbol in one build and not the other; renaming or
 *                             substitution would then bind the wrong thing.
 *
 * Over-counts are deliberately NOT reported: they are safe by the rule above, and the real gate for
 * them is byte-identical output, which catches any that actually cost bytes.
 *
 * Builds its own ground truth and RESTORES the maintained `node.sym` association afterwards, so it
 * is side-effect free on the tree and safe to run inside a normal build.
 */
export function verifySemantic(maintained: Semantic, program: Node): string[] {
    const out: string[] = [];

    // Snapshot before the rebuild — `analyze` overwrites `node.sym` with ITS OWN ids.
    const nodes: Node[] = [];
    const before = new Map<Node, number>();
    // Scope ids now live ON THE NODE (`data.scopeId`), so the ground-truth build below OVERWRITES the
    // maintained ones. They must be snapshotted and restored, exactly like `sym` — the Semantic is no
    // longer self-contained, which is the price of oxc's placement.
    const beforeScope = new Map<Node, number>();
    walk(program, (n) => {
        nodes.push(n);
        before.set(n, n.sym);
        const d = n.data as { scopeId?: number } | null;
        if (d !== null && d.scopeId !== undefined) beforeScope.set(n, d.scopeId);
    });
    const maintainedScopeNodes = new Set([...beforeScope].filter(([, id]) => id !== 0).map(([n]) => n));

    // Clear every association BEFORE building ground truth. `analyze` only WRITES `node.sym` when it
    // resolves a reference — an unresolved one keeps whatever it already held, so without this the
    // truth build silently inherits the maintained ids for exactly the nodes most likely to differ
    // (a reference whose declaration the lowering erased), making the two look equal when they are
    // not.
    for (const n of nodes) n.sym = 0;
    // Same reasoning for scope ids: a node that owns a scope in the MAINTAINED build but not in truth
    // would otherwise keep its stale id and read back as truth's, hiding exactly the divergence this
    // is looking for.
    for (const n of nodes) {
        const d = n.data as { scopeId?: number } | null;
        if (d !== null && d.scopeId !== undefined) d.scopeId = 0;
    }

    const truth = createSemantic();
    analyze(truth, program);

    for (const n of nodes) {
        const d = n.data as { scopeId?: number } | null;
        if (d === null || d.scopeId === undefined || d.scopeId === 0) continue; // truth says: owns none
        if (!maintainedScopeNodes.has(n))
            out.push(`scope-owning node ${n.type} @${n.start} has no scopeId in maintained (UNSAFE: resolves from the wrong scope)`);
    }

    // Symbol ids differ between builds; the PARTITION they induce must not.
    const mToT = new Map<number, number>();
    const tToM = new Map<number, number>();
    for (const n of nodes) {
        const m = before.get(n) ?? 0;
        const t = n.sym;
        if (m === 0 && t === 0) continue;
        if (m === 0) {
            out.push(`node ${n.type} @${n.start} '${n.name}' unbound in maintained, bound in truth (UNSAFE)`);
            continue;
        }
        if (t === 0) continue; // bound in maintained only — stale extra, safe
        const pm = mToT.get(m);
        const pt = tToM.get(t);
        if (pm === undefined && pt === undefined) {
            mToT.set(m, t);
            tToM.set(t, m);
        } else if (pm !== t || pt !== m) {
            out.push(`node ${n.type} @${n.start} '${n.name}' symbol partition mismatch (UNSAFE): maintained ${m} -> truth ${t}, but maintained ${m} already maps to ${pm} and truth ${t} maps back to ${pt}`);
        }
    }

    // ── Checks the PARTITION cannot see ────────────────────────────────────────────────────────────
    // The partition compares which NODES share a symbol. It says nothing about which SCOPE a symbol
    // CLAIMS, which scopes still exist, or whether a `decl` is still attached — and those are exactly
    // the facts `treeshake`, `deconflict` and the mangler read. `blockFlatten` lifting a block without
    // repointing `symbols[sym].scope` shipped two miscompiles that this function, as written, could
    // not see: the partition was intact the whole time.
    //
    // Scope ids differ between builds just as symbol ids do, so the comparison goes through a scope
    // partition built from the scope-OWNING nodes, which carry `data.scopeId` in both builds. This
    // must run BEFORE the restore below, while the tree still holds TRUTH's scope ids.
    {
        const mScopeToT = new Map<number, number>();
        for (const n of nodes) {
            const d = n.data as { scopeId?: number } | null;
            const t = d?.scopeId ?? 0;
            const m = beforeScope.get(n) ?? 0;
            if (t === 0 || m === 0) continue;
            const prev = mScopeToT.get(m);
            if (prev === undefined) mScopeToT.set(m, t);
            else if (prev !== t)
                out.push(`scope ${m} maps to two truth scopes (${prev} and ${t}) (UNSAFE: scope tree diverged)`);
        }

        // A symbol's OWNING SCOPE must agree with truth, mapped through both partitions.
        for (const [mSym, tSym] of mToT) {
            const mRec = maintained.symbols[mSym];
            const tRec = truth.symbols[tSym];
            if (mRec === undefined || tRec === undefined) continue;
            const expected = mScopeToT.get(mRec.scope);
            // `expected === undefined` means the maintained scope has no counterpart in truth — the
            // scope was removed from the tree and the symbol still claims it. That is the blockFlatten
            // shape exactly.
            if (mRec.scope !== 0 && expected === undefined)
                out.push(`sym ${mSym} '${mRec.decl?.name ?? '?'}' claims scope ${mRec.scope}, which does not exist in truth (UNSAFE: stale after a structural move)`);
            else if (expected !== undefined && expected !== tRec.scope)
                out.push(`sym ${mSym} '${mRec.decl?.name ?? '?'}' claims scope ${mRec.scope} (truth ${tRec.scope}) (UNSAFE: wrong owning scope)`);
        }

        // Every scope's parent must still exist. A removed scope left as a parent breaks the chain
        // walk that `resolveRef` and `lookupValue` depend on.
        for (let sc = 1; sc < maintained.scopes.length; sc++) {
            const parent = maintained.scopes[sc].parent;
            if (parent < 0 || parent >= maintained.scopes.length)
                out.push(`scope ${sc} has out-of-range parent ${parent} (table size ${maintained.scopes.length}) (UNSAFE)`);
        }
    }

    // Every `sym` a node still holds must be IN BOUNDS. This is the `STALE SYM 65 (table size 64)`
    // crash that keeps `coalesceVariableNames` disabled — a pass shrank the table while nodes held
    // old ids. Cheap, and it turns a downstream crash into a named divergence at the causing stage.
    for (const n of nodes) {
        const m = before.get(n) ?? 0;
        if (m >= maintained.symbols.length)
            out.push(`node ${n.type} @${n.start} '${n.name}' holds sym ${m} beyond the table (size ${maintained.symbols.length}) (UNSAFE)`);
    }

    // A LIVE symbol's `decl` must still be ATTACHED to the tree. `deconflict.ts:134` and `link.ts:210`
    // read `decl!.name` with a non-null assertion, and treeshake keys module-scope liveness off it.
    //
    // An EVICTED symbol is exempt. The established convention (`strip-ts.ts:140` `evictSym`) is
    // `rec.scope = 0` — "owned by no lexical scope", deliberately still a VALID index because an
    // out-of-range sentinel crashed chunk-graph. Every consumer filters on the owning scope, so a
    // detached `decl` behind scope 0 is unreachable, not stale. Flagging it produced a false positive
    // on the very first run (`sym 4 'T'`, a type-only decl `tsStrip` had correctly evicted).
    // NOT CHECKED: "a live symbol's decl is still in the tree". It is NOT an invariant here, and
    // trying to make it one produced three false positives against deliberate designs:
    //   • `mintParam` (`lower-ts.ts:23`) builds a throwaway `bindId` purely so `symbolName()` has a
    //     name to read; that node is never inserted.
    //   • `declare const g` KEEPS a live symbol with an erased decl ON PURPOSE, because references to
    //     `g` survive the strip and the symbol is what reserves the name (see `strip-ts.ts`).
    //   • an erased type PARAMETER was a genuine miss — fixed at the erasure sites instead.
    // A verifier that needs to know intent cannot be trusted to fail loudly, so it checks only facts
    // that are unambiguous: owning scope, scope-parent validity, and sym bounds.

    // Restore the maintained associations BEFORE deriving ref facts — they must be keyed by the
    // maintained symbol ids, not the throwaway rebuild's. Scope ids are restored for the same reason:
    // the truth build wrote its own into the shared tree.
    for (const n of nodes) n.sym = before.get(n) ?? 0;
    for (const n of nodes) {
        const d = n.data as { scopeId?: number } | null;
        if (d !== null && d.scopeId !== undefined) d.scopeId = beforeScope.get(n) ?? 0;
    }

    if (process.env.VERIFY_EXTRAS === '1') {
        // Diagnostic only: SAFE-direction divergence. Stale EXTRA symbols cost a mangled name, not
        // correctness — but they are exactly what makes the maintained table produce different
        // identifiers from a rebuilt one, which is what keeps `refreshFull` load-bearing.
        let liveM = 0;
        for (let i = 1; i < maintained.symbols.length; i++) if (maintained.symbols[i].scope !== 0) liveM++;
        let liveT = 0;
        for (let i = 1; i < truth.symbols.length; i++) if (truth.symbols[i].scope !== 0) liveT++;
        if (liveM !== liveT) out.push(`EXTRAS(safe): maintained has ${liveM} live symbols, truth ${liveT} (delta ${liveM - liveT})`);
    }
    for (const p of verifyRefFacts(maintained, program)) if (p.includes('UNDER(unsafe)')) out.push(p);

    // `symbolInit` / `shorthand` / `exported` are read by compress passes (alias-inline, const-prop)
    // and are NOT covered by the RefDelta, which carries only reads/writes/uses. A stale entry here
    // points at a node the lowering may have detached, so it is reported as unsafe.
    if (VERIFY_SYMBOL_INIT) {
        // Symbol IDS differ between the two builds — compare THROUGH the partition map established
        // above, or every entry looks divergent for no reason.
        for (const [mSym, mInit] of maintained.symbolInit) {
            const tSym = mToT.get(mSym);
            if (tSym === undefined) continue; // symbol absent from truth (stale decl) — safe
            const tInit = truth.symbolInit.get(tSym);
            if (tInit === undefined) out.push(`sym ${mSym} symbolInit is stale in maintained (truth has none)`);
            else if (tInit !== mInit) out.push(`sym ${mSym} symbolInit points at a DIFFERENT node (maintained ${mInit.type} vs truth ${tInit.type})`);
        }
        for (const [tSym, tInit] of truth.symbolInit) {
            const mSym = tToM.get(tSym);
            if (mSym !== undefined && !maintained.symbolInit.has(mSym))
                out.push(`sym ${mSym} symbolInit missing in maintained (truth has ${tInit.type})`);
        }
    }
    if (VERIFY_SYMBOL_INIT) {
        // What `Semantic.unresolved` is FOR is name reservation: `deconflict` seeds its taken set
        // from it. So compare RESERVATION, not list membership — a name can legitimately be reserved
        // through the symbol table in one build and through `unresolved` in the other. `declare const
        // g` is exactly that: the maintained build still has `g` declared (so the reference resolved
        // and never entered the list), while a rebuild on the stripped tree has no declaration and
        // reserves `g` as unresolved instead. Both reserve it; only the route differs.
        const declared = new Set<string>();
        for (let i = 1; i < maintained.symbols.length; i++) {
            const nm = maintained.symbols[i].decl?.name;
            if (nm !== undefined) declared.add(nm);
        }
        // Only UNDER-reservation is reported. A name the maintained build reserves and the rebuild
        // does not costs at most a rename; a name NEITHER route reserves is free for capture, which
        // is the direction that breaks code.
        const mNames = new Set(maintained.unresolved.map((n) => n.name));
        for (const n of truth.unresolved)
            if (!mNames.has(n.name) && !declared.has(n.name))
                out.push(`name '${n.name}' is reserved by neither unresolved nor a symbol in maintained (UNSAFE: free for capture)`);
    }
    return out;
}

/** `symbolInit` divergence is reported separately: it is real, but it is a SIZE effect (compress
 *  passes decline to fire), not a miscompile, so gating the default flip on it would be wrong.
 *  Set `VERIFY_SYMBOL_INIT=1` to include it. */
const VERIFY_SYMBOL_INIT = process.env.VERIFY_SYMBOL_INIT === '1';
