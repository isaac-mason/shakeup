// Deconfliction / name-mangling — the GENERATE-stage name COMPUTE (rolldown `utils/renamer.rs` +
// `utils/chunk/deconflict_chunk_symbols.rs`, invoked from `generate_stage/mod.rs`). Writes name
// side-maps (`linked.finalNames`/`namespaceOf`/`externalLocals`) — NO AST mutation; the printer
// applies them via `nameOf`. Kept OUT of link (rolldown link_stage names nothing). Consumed by
// chunk-graph.ts (per-chunk) + single-scope callers (deconflictWholeBundle).
import { scopeOf } from './analysis/semantic';
import { externalKey, type Graph, type Linked, packRef, refMod, refSym } from './graph-types';

const RESERVED = new Set([
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
    for (const idx of memberOrder) {
        const mod = graph.modules[idx];
        const moduleScope = scopeOf(mod.semantic, mod.program);
        const sem = mod.semantic;
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            if (sem.symbols[sym].scope !== moduleScope) continue;
            if (mod.namedImports.has(sym)) continue;
            const original = sem.symbols[sym].decl!.name;
            const final = claim(original);
            if (final !== original) linked.finalNames.set(packRef(idx, sym), final);
        }
    }
    for (const [ref, base] of linked.syntheticNames) {
        if (memberSet !== null && !memberSet.has(refMod(ref))) continue;
        linked.finalNames.set(ref, claim(base));
    }
    for (const [modIdx, base] of linked.namespaceOf) {
        if (memberSet !== null && !memberSet.has(modIdx)) continue;
        linked.namespaceOf.set(modIdx, claim(base));
    }
    const claimExternal = (specifier: string, name: string, base: string): void => {
        const key = externalKey(specifier, name);
        if (linked.externalLocals.has(key)) return;
        linked.externalLocals.set(key, claim(base));
    };
    for (const [ref, bind] of linked.binds) {
        if (bind.kind !== 'external') continue;
        if (memberSet !== null && !memberSet.has(refMod(ref))) continue;
        const mod = graph.modules[refMod(ref)];
        const localName = mod.semantic.symbols[refSym(ref)].decl!.name;
        claimExternal(bind.specifier, bind.name, localName);
    }
    for (const [modIdx, map] of linked.exportMaps) {
        if (memberSet !== null && !memberSet.has(modIdx)) continue;
        for (const bind of map.values()) {
            if (bind.kind !== 'external') continue;
            const base =
                bind.name === '*'
                    ? `${bind.specifier.replace(/[^A-Za-z0-9_$]/g, '_')}_ns`
                    : bind.name === 'default'
                      ? `${bind.specifier.replace(/[^A-Za-z0-9_$]/g, '_')}_default`
                      : bind.name;
            claimExternal(bind.specifier, bind.name, base);
        }
    }
    return claim;
}

/** Mangle every NON-module-scope binding (function params, locals, nested declarations) in a
 *  chunk to short base54 names, after {@link deconflictChunk} has fixed all chunk-top names.
 *
 *  `taken` must be the chunk's fully-populated top-level name set (module symbols + globals +
 *  reserved words + cross-chunk import locals + namespace/external names). The walk visits each
 *  module's scope tree depth-first, assigning names not in `taken` and backtracking on scope
 *  exit — so a sibling scope reuses the same short names (esbuild/oxc_mangler model,
 *  `llm/libs/oxc/crates/oxc_mangler/src/lib.rs:130-213`), while a descendant never shadows a
 *  name still live in an enclosing scope. Names are added to / removed from `taken` in place. */
export function mangleNestedScopes(graph: Graph, linked: Linked, chunkModules: number[], taken: Set<string>): void {
    for (const idx of chunkModules) {
        const mod = graph.modules[idx];
        const sem = mod.semantic;
        const moduleScope = scopeOf(sem, mod.program);

        // Child scopes per scope id, and the bindings declared directly in each (non-top) scope.
        const childScopes: number[][] = sem.scopes.map(() => []);
        for (let s = 1; s < sem.scopes.length; s++) childScopes[sem.scopes[s].parent].push(s);
        const symsByScope: number[][] = sem.scopes.map(() => []);
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            const sc = sem.symbols[sym].scope;
            if (sc !== moduleScope) symsByScope[sc].push(sym);
        }

        const walk = (scope: number): void => {
            const added: string[] = [];
            let i = 0;
            for (const sym of symsByScope[scope]) {
                if (mod.namedImports.has(sym)) continue; // import binding — already resolved
                let name = base54(i++);
                while (taken.has(name)) name = base54(i++);
                taken.add(name);
                added.push(name);
                linked.finalNames.set(packRef(idx, sym), name);
            }
            for (const child of childScopes[scope]) walk(child);
            for (const name of added) taken.delete(name); // backtrack → sibling scopes reuse
        };
        for (const child of childScopes[moduleScope]) walk(child);
    }
}

/** Whole-bundle deconflict — treat the entire graph as one lexical scope. The bundle path does NOT
 *  use this (it deconflicts per-chunk in {@link deconflictChunk} via buildChunkGraph); it's for
 *  single-scope callers/tests. Generate-stage naming — kept out of {@link linkGraph} so Link binds+
 *  sorts and names nothing (rolldown `link_stage` does no naming). */
export function deconflictWholeBundle(graph: Graph, linked: Linked): void {
    deconflictChunk(graph, linked, linked.order, null, []);
}
