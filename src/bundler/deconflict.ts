// Deconfliction / name-mangling — the GENERATE-stage name COMPUTE (rolldown `utils/renamer.rs` +
// `utils/chunk/deconflict_chunk_symbols.rs`, invoked from `generate_stage/mod.rs`). Writes name
// side-maps (`linked.finalNames`/`namespaceOf`/`externalLocals`) — NO AST mutation; the printer
// applies them via `nameOf`. Kept OUT of link (rolldown link_stage names nothing). Consumed by
// chunk-graph.ts (per-chunk) + single-scope callers (deconflictWholeBundle).
import { SCOPE, scopeKind, scopeOf } from '../analysis/semantic.ts';
import { N, type Node, walk, walkChildren } from '../ast/index.ts';
import { externalKey, type Graph, type Linked, type Module, packRef, refMod, refSym } from './graph-types.ts';
import { finalNameOf } from './link.ts';

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
export function makeClaim(taken: Set<string>): (base: string, avoid?: ReadonlySet<string>) => string {
    return (base: string, avoid?: ReadonlySet<string>): string => {
        let name = base;
        let n = 1;
        // `avoid` is per-CALL, not global: a name forbidden to one symbol is still free for the
        // symbol that forbade it. Rollup's `Variable.forbidName` has the same per-variable shape.
        while (taken.has(name) || avoid?.has(name) === true) name = `${base}$${n++}`;
        taken.add(name);
        return name;
    };
}

/**
 * Names a top-level symbol must NOT take, because a NESTED class wants to keep that name.
 *
 * Under `keepNames`, a class whose binding gets renamed loses its `.name` unless the original is
 * moved onto the class itself — and the printer declines to do that when the name would capture
 * something the class reaches (`preservedClassName`). Rollup avoids ever reaching that point: for
 * every variable a class's scope accesses from outside, it calls `accessedVariable.forbidName(name)`
 * (`ClassDeclaration.applyDeoptimizations`, `VariableDeclarator.includeNode`), so the renamer gives
 * the OUTER symbol the suffix and the class keeps its name. Its `class-name-conflict-3` output is
 * `let Foo$1 = class Foo {}` at module level with the nested `class Foo` untouched.
 *
 * This computes that forbid set. Only NESTED classes contribute: a top-level class is claimed in the
 * same pass as everything it could collide with, so there is no inner binding to protect.
 */
function classNameForbids(graph: Graph, linked: Linked, memberSet: Set<number> | null): Map<number, Set<string>> {
    const forbids = new Map<number, Set<string>>();
    for (const mod of graph.modules) {
        if (memberSet !== null && !memberSet.has(mod.idx)) continue;
        if (mod.external) continue;
        const sem = mod.semantic;
        const moduleScope = scopeOf(sem, mod.program);
        /** The ref a reference ULTIMATELY names, following an import to its producer — the symbol
         *  whose claimed name the printer will emit. Null when it is not a claimable top-level
         *  binding (an external, a namespace, a nested local). */
        const producerRef = (sym: number): number | null => {
            if (mod.namedImports.get(sym) === undefined) {
                return sem.symbols[sym]?.scope === moduleScope ? packRef(mod.idx, sym) : null;
            }
            const bind = linked.binds.get(packRef(mod.idx, sym));
            if (bind === undefined) return null;
            return bind.kind === 'found' || bind.kind === 'cjs-member' ? bind.ref : null;
        };
        walk(mod.program, (n) => {
            const name = nestedClassName(n, sem, moduleScope);
            if (name === null) return;
            walk(n, (m) => {
                if (m.type !== N.IdentifierReference || m.sym === 0) return;
                const ref = producerRef(m.sym);
                if (ref === null) return;
                let set = forbids.get(ref);
                if (set === undefined) forbids.set(ref, (set = new Set()));
                set.add(name);
                return;
            });
            return;
        });
    }
    return forbids;
}

/** The name a NESTED class would keep — its own id, or the binding it is assigned to when the class
 *  is anonymous. Null for a top-level class, an unnamed one nothing can name, or a non-class. */
function nestedClassName(n: Node, sem: Module['semantic'], moduleScope: number): string | null {
    if (n.type === N.ClassDeclaration) {
        const id = (n.data as { id: Node | null }).id;
        if (id === null || id.sym === 0) return null;
        return sem.symbols[id.sym]?.scope === moduleScope ? null : (id.name as string);
    }
    if (n.type !== N.VariableDeclarator) return null;
    const d = n.data as { id: Node; init: Node | null };
    if (d.init === null || d.init.type !== N.ClassExpression || (d.init.data as { id: Node | null }).id !== null) return null;
    if (d.id.type !== N.BindingIdentifier || d.id.sym === 0) return null;
    return sem.symbols[d.id.sym]?.scope === moduleScope ? null : (d.id.name as string);
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
    taken: Set<string> = new Set<string>(),
    /** See {@link classNameForbids} — only consulted under `output.keepNames`. */
    keepNames = false,
): (base: string, avoid?: ReadonlySet<string>) => string {
    for (const name of RESERVED) taken.add(name);
    for (const name of seed) taken.add(name);
    for (const idx of memberOrder) {
        const mod = graph.modules[idx];
        for (const node of mod.semantic.unresolved) taken.add(node.name);
    }
    const claim = makeClaim(taken);
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
    // Claimed in the order the modules were walked — readable names depend on it. (There used to be a
    // frequency-ranked alternative here, feeding shortest names to the busiest slots; it was reachable
    // only from the link-time mangler, which no longer exists. The chunk mangler ranks its own slots.)
    const forbids = keepNames ? classNameForbids(graph, linked, memberSet) : null;
    for (const { ref, original } of topLevel) {
        const final = claim(original, forbids?.get(ref));
        if (final !== original) linked.finalNames.set(ref, final);
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
    for (const [key, base] of extBase) claimExternal(key, base);
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
        // Explicit stack, not recursion: this descends one frame per AST level, and a deeply nested
        // program (300 blocks is enough) overflowed the call stack. The budget also shrank whenever a
        // node type was added, because `walkChildren` is generated from the schema and a bigger
        // generated function means a bigger frame — a nesting limit that moves when the AST grows.
        const nodes: Node[] = [mod.program];
        const scopes: number[] = [0];
        while (nodes.length > 0) {
            const n = nodes.pop() as Node;
            const scope = scopes.pop() as number;
            const own = (n.data as { scopeId?: number } | null)?.scopeId ?? 0;
            const cur = own === 0 ? scope : own;
            if (n.type === N.IdentifierReference && n.sym !== 0) {
                const rec = sem.symbols[n.sym];
                if (rec !== undefined && rec.scope !== cur) {
                    const name = outerName(mod.idx, n.sym);
                    // Mark every scope between the READ and the DECLARATION: a binding anywhere on
                    // that chain would capture the reference.
                    if (name !== null)
                        for (let s = cur; s !== 0 && s !== rec.scope; s = sem.scopes[s].parent) {
                            let set = captured.get(s);
                            if (set === undefined) captured.set(s, (set = new Set()));
                            set.add(name);
                        }
                }
            }
            walkChildren(n, (c) => {
                nodes.push(c);
                scopes.push(cur);
            });
        }
        if (captured.size === 0) continue;
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            const rec = sem.symbols[sym];
            const decl = rec?.decl;
            if (decl === null || decl === undefined) continue;
            // Top-level symbols are the ones deconfliction already named; only NESTED bindings here.
            const flags = sem.scopes[rec.scope]?.flags;
            if (flags === undefined || scopeKind(flags) === SCOPE.MODULE) continue;
            const ref = packRef(mod.idx, sym);
            if (linked.finalNames.has(ref)) continue;
            if (captured.get(rec.scope)?.has(decl.name) === true) linked.finalNames.set(ref, claim(decl.name));
        }
    }
}

export function deconflictWholeBundle(graph: Graph, linked: Linked): void {
    deconflictChunk(graph, linked, linked.order, null, []);
}
