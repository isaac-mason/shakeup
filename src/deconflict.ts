// Deconfliction / name-mangling — the GENERATE-stage name COMPUTE (rolldown `utils/renamer.rs` +
// `utils/chunk/deconflict_chunk_symbols.rs`, invoked from `generate_stage/mod.rs`). Writes name
// side-maps (`linked.finalNames`/`namespaceOf`/`externalLocals`) — NO AST mutation; the printer
// applies them via `nameOf`. Kept OUT of link (rolldown link_stage names nothing). Consumed by
// chunk-graph.ts (per-chunk) + single-scope callers (deconflictWholeBundle).
import { SCOPE, scopeOf } from './analysis/semantic';
import { N, type Node, walkChildren } from './ast';
import { externalKey, type Graph, type Linked, packRef, refMod, refSym } from './graph-types';
import { finalNameOf } from './link';

export const RESERVED = new Set([
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'export',
    'extends',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
    'await',
    'static',
    'enum',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
]);

/** A `claim` closure over a mutable `taken` set: returns a unique name derived from
 *  `base` (suffixing `$1`, `$2`, … on collision) and reserves it. */
export function makeClaim(taken: Set<string>): (base: string) => string {
    return (base: string): string => {
        let name = base;
        let n = 1;
        while (taken.has(name)) name = `${base}$${n++}`;
        taken.add(name);
        return name;
    };
}

// Frequency-ordered mangle alphabet — most-used JS identifier chars first, so short names
// bias toward bytes that gzip well. First char from the identifier-START set (54), the rest
// from the full identifier-PART set (adds digits). Ported verbatim from
// `llm/libs/oxc/crates/oxc_mangler/src/base54.rs:31`.
const BASE54_CHARS = 'etnriaoscludfpmhg_vybxSCwTEDOkAjMNPFILRzBVHUWGKqJYXZQ$1024368579';

/** The n-th shortest mangled identifier (`0→e`, `53→$`, `54→ee`, …). */
export function base54(n: number): string {
    let out = BASE54_CHARS[n % 54];
    let num = Math.floor(n / 54);
    while (num > 0) {
        num -= 1;
        out += BASE54_CHARS[num % 64];
        num = Math.floor(num / 64);
    }
    return out;
}

/** A `claim` closure that hands out the shortest unused base54 name, ignoring the requested
 *  base — the mangling name policy. Collisions with `taken` (reserved words, globals, and
 *  already-claimed names) are skipped. */
export function makeMangleClaim(taken: Set<string>): (base: string) => string {
    let i = 0;
    return (_base: string): string => {
        let name = base54(i++);
        while (taken.has(name)) name = base54(i++);
        taken.add(name);
        return name;
    };
}

/** Deconflict the module-scope symbols, synthetics, namespaces, and external locals of a
 *  set of modules (`memberOrder`, exec-ordered) into a FRESH scope. Whole-bundle deconflict
 *  is this run over `linked.order`; it runs once per chunk (each chunk = one lexical scope, so
 *  a name may safely repeat across chunks). Writes into `linked.finalNames` /
 *  `linked.namespaceOf` / `linked.externalLocals` — because a module lives in exactly one
 *  chunk, its `packRef→name` stays unambiguous. `seed` pre-reserves names the chunk pulls
 *  in from other chunks (cross-chunk import locals), so producer names win before consumers.
 *
 *  When `memberSet` is provided, only external binds whose owning module is in the chunk are
 *  claimed here (per-chunk external import locals); the whole-bundle path passes it as null
 *  and claims every external once. */
export function deconflictChunk(
    graph: Graph,
    linked: Linked,
    memberOrder: number[],
    memberSet: Set<number> | null,
    seed: Iterable<string>,
    mangle = false,
    taken: Set<string> = new Set<string>(),
    /** Per-top-level-symbol claim weight (`packRef` → its SLOT's total reference count), from
     *  `topLevelSlotWeights`. Null keeps the historical module/symbol-id claim order. */
    weights: Map<number, number> | null = null,
): (base: string) => string {
    for (const name of RESERVED) taken.add(name);
    for (const name of seed) taken.add(name);
    for (const idx of memberOrder) {
        const mod = graph.modules[idx];
        for (const node of mod.semantic.unresolved) taken.add(node.name);
    }
    // Mangling reassigns the shortest base54 names instead of readable deconflicted ones;
    // both share the same collision-free `taken` discipline (esbuild/oxc_mangler model).
    const claim = mangle ? makeMangleClaim(taken) : makeClaim(taken);
    // Top-level claims, hottest slot first (oxc Phase 3, `SlotRanking::tally`). `makeMangleClaim`
    // ignores its base and hands out base54 names in CALL order, and base54 names get LONGER as they
    // are consumed — 54 one-character names, then two-character. Claiming in module/symbol-id order
    // therefore spent every one-character name on whichever symbols came first: measured on crashcat,
    // all 54 were in use and the coldest of them was referenced 7 times.
    //
    // The weight is the SLOT's traffic, not the symbol's — see `topLevelSlotWeights`. Collecting the
    // list first and sorting it is what makes this a reordering and nothing more; the claims issued
    // are exactly the same ones, and `taken` (not order) is what keeps them collision-free.
    // External locals, deduped to one entry per (specifier, name) — several modules importing the
    // same name share ONE emitted local. Discovery only READS `binds`/`exportMaps`, so hoisting it
    // above the claim phase changes nothing; it just makes the set available to rank.
    const extBase = new Map<string, string>();
    const offerExternal = (specifier: string, name: string, base: string): void => {
        const key = externalKey(specifier, name);
        if (linked.externalLocals.has(key) || extBase.has(key)) return;
        extBase.set(key, base);
    };
    for (const [ref, bind] of linked.binds) {
        if (bind.kind !== 'external') continue;
        if (memberSet !== null && !memberSet.has(refMod(ref))) continue;
        offerExternal(bind.specifier, bind.name, graph.modules[refMod(ref)].semantic.symbols[refSym(ref)].decl!.name);
    }
    for (const [modIdx, map] of linked.exportMaps) {
        if (memberSet !== null && !memberSet.has(modIdx)) continue;
        for (const bind of map.values()) {
            if (bind.kind !== 'external') continue;
            offerExternal(
                bind.specifier,
                bind.name,
                bind.name === '*'
                    ? `${bind.specifier.replace(/[^A-Za-z0-9_$]/g, '_')}_ns`
                    : bind.name === 'default'
                      ? `${bind.specifier.replace(/[^A-Za-z0-9_$]/g, '_')}_default`
                      : bind.name,
            );
        }
    }

    // An external local anchors no slot — nothing inherits its name — so the number of times it is
    // PRINTED is simply its own reference count, which is directly comparable to a slot's weight.
    // Without this they were claimed after every module symbol and landed deep in the two-character
    // range: crashcat's `vec3`, at 2483 uses, came out as `$G`.
    const extWeight = new Map<string, number>();
    if (weights !== null) {
        for (const idx of memberOrder) {
            const mod = graph.modules[idx];
            for (const sym of mod.semantic.refSyms) {
                if (sym <= 0 || !mod.namedImports.has(sym)) continue;
                const bind = linked.binds.get(packRef(idx, sym));
                if (bind?.kind !== 'external') continue;
                const key = externalKey(bind.specifier, bind.name);
                extWeight.set(key, (extWeight.get(key) ?? 0) + 1);
            }
        }
    }

    const claimExternal = (key: string, base: string): void => {
        if (!linked.externalLocals.has(key)) linked.externalLocals.set(key, claim(base));
    };

    const topLevel: { ref: number; original: string }[] = [];
    for (const idx of memberOrder) {
        // A CJS-wrapped module's body is a closure: its top-level bindings are function-scoped and
        // cannot collide with the chunk root, so renaming them here would be noise. (rolldown skips
        // them for the same reason — `deconflict_chunk_symbols.rs:132-135`.) Its wrapper and
        // namespace names ARE chunk-root bindings and are claimed below.
        if (linked.cjsWrap.has(idx)) continue;
        const mod = graph.modules[idx];
        const moduleScope = scopeOf(mod.semantic, mod.program);
        const sem = mod.semantic;
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            if (sem.symbols[sym].scope !== moduleScope) continue;
            if (mod.namedImports.has(sym)) continue;
            topLevel.push({ ref: packRef(idx, sym), original: sem.symbols[sym].decl!.name });
        }
    }
    if (weights === null) {
        // No ranking: claim in exactly the historical order (readable names depend on it).
        for (const { ref, original } of topLevel) {
            const final = claim(original);
            if (final !== original) linked.finalNames.set(ref, final);
        }
    } else {
        // Module symbols and external locals compete in ONE queue — they draw from the same base54
        // sequence, so ranking either alone just moves the misallocation to the other. Stable sort,
        // so equal weights keep the deterministic order the lists were built in.
        const queue: { w: number; run: () => void }[] = [];
        for (const { ref, original } of topLevel) {
            queue.push({
                w: weights.get(ref) ?? 0,
                run: () => {
                    const final = claim(original);
                    if (final !== original) linked.finalNames.set(ref, final);
                },
            });
        }
        for (const [key, base] of extBase) queue.push({ w: extWeight.get(key) ?? 0, run: () => claimExternal(key, base) });
        queue.sort((a, b) => b.w - a.w);
        for (const q of queue) q.run();
    }
    // No ad-hoc claiming for the CJS wrapper/namespace: they are synthetic REFS now, so the
    // `syntheticNames` loop below already names them — the same path `*_default` uses.
    for (const [ref, base] of linked.syntheticNames) {
        if (memberSet !== null && !memberSet.has(refMod(ref))) continue;
        linked.finalNames.set(ref, claim(base));
    }
    for (const [modIdx, base] of linked.namespaceOf) {
        if (memberSet !== null && !memberSet.has(modIdx)) continue;
        linked.namespaceOf.set(modIdx, claim(base));
    }
    if (weights === null) for (const [key, base] of extBase) claimExternal(key, base);
    // AFTER every top-level name is final: only then is it known which names a nested binding would
    // capture.
    deshadowLocals(graph, linked, memberSet, claim);
    return claim;
}

/**
 * DESHADOWING — rename a nested binding that would capture an outer name referenced through it.
 *
 * Deconfliction gives top-level symbols their final names, but says nothing about the scopes those
 * names are READ from. If an import lands on `foo` and some function takes a parameter `foo`, every
 * reference to the import inside that function silently binds to the parameter instead:
 *
 *     import { foo as _foo } from './lib.js';
 *     function g(foo) { return _foo(); }     ->     function g(foo) { return foo(); }
 *
 * Four shapes were broken this way — a named function expression's own id (infinite recursion, and
 * three of rollup's samples), a function parameter, a catch parameter, and a class expression's id.
 * Only a plain `let` inside a function appeared to work, and that was luck: the unused local had
 * been tree-shaken away, so nothing was left to shadow.
 *
 * DIRECTION, from rollup (`ChildScope.deconflict` / `addUsedOutsideNames`): rename the INNER
 * binding, not the outer one. Reserving every local name globally would also be correct but would
 * push a `$1` onto vast numbers of top-level symbols; rollup renames only the bindings that actually
 * capture something, and so does this.
 */
function deshadowLocals(graph: Graph, linked: Linked, memberSet: Set<number> | null, claim: (base: string) => string): void {
    for (const mod of graph.modules) {
        if (memberSet !== null && !memberSet.has(mod.idx)) continue;
        if (mod.external) continue;
        const sem = mod.semantic;
        /**
         * The name the PRINTER will emit for a symbol — which for an import is NOT `finalNameOf` on
         * the local. `import { foo as _foo }` keeps the local symbol `_foo`, and the printer resolves
         * it through `linked.binds` to the producer's final name (`foo`). Comparing against `_foo`
         * found no collision, which is why the first attempt at this pass changed nothing.
         *
         * Resolved from `linked` alone, i.e. the whole-bundle perspective. A cross-chunk import
         * renders as a chunk-local alias instead; missing that under-detects, which is the previous
         * behaviour rather than a regression.
         */
        const outerName = (modIdx: number, sym: number): string | null => {
            if (mod.namedImports.get(sym) === undefined) return finalNameOf(linked, packRef(modIdx, sym));
            const bind = linked.binds.get(packRef(modIdx, sym));
            if (bind === undefined) return null;
            switch (bind.kind) {
                case 'found':
                    return finalNameOf(linked, bind.ref);
                case 'cjs-member':
                    return finalNameOf(linked, bind.ref);
                case 'namespace':
                    return linked.namespaceOf.get(bind.module) ?? null;
                case 'external':
                    return linked.externalLocals.get(externalKey(bind.specifier, bind.name)) ?? null;
                default:
                    return null;
            }
        };
        /** Per scope: names read inside it that resolve OUTSIDE it, so a local of that name captures. */
        const captured = new Map<number, Set<string>>();
        const visit = (n: Node, scope: number): void => {
            const own = (n.data as { scopeId?: number } | null)?.scopeId ?? 0;
            const cur = own === 0 ? scope : own;
            if (n.type === N.IdentifierReference && n.sym !== 0) {
                const rec = sem.symbols[n.sym];
                if (rec !== undefined && rec.scope !== cur) {
                    const name = outerName(mod.idx, n.sym);
                    if (name === null) {
                        walkChildren(n, (c) => visit(c, cur));
                        return;
                    }
                    // Mark every scope between the READ and the DECLARATION: a binding anywhere on
                    // that chain would capture the reference.
                    for (let s = cur; s !== 0 && s !== rec.scope; s = sem.scopes[s].parent) {
                        let set = captured.get(s);
                        if (set === undefined) captured.set(s, (set = new Set()));
                        set.add(name);
                    }
                }
            }
            walkChildren(n, (c) => visit(c, cur));
        };
        visit(mod.program, 0);
        if (captured.size === 0) continue;
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            const rec = sem.symbols[sym];
            const decl = rec?.decl;
            if (decl === null || decl === undefined) continue;
            // Top-level symbols are the ones deconfliction already named; only NESTED bindings here.
            const flags = sem.scopes[rec.scope]?.flags;
            if (flags === undefined || flags === SCOPE.MODULE) continue;
            const ref = packRef(mod.idx, sym);
            if (linked.finalNames.has(ref)) continue;
            if (captured.get(rec.scope)?.has(decl.name) === true) linked.finalNames.set(ref, claim(decl.name));
        }
    }
}

export function deconflictWholeBundle(graph: Graph, linked: Linked): void {
    deconflictChunk(graph, linked, linked.order, null, []);
}
