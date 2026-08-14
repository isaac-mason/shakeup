// Link: bind imports to their defining exports, order modules for execution,
// and deconflict top-level names. ESM-only port of rolldown's
// bind_imports_and_exports. Design notes: PLAN.md §6.

import { type Graph, type Module, NAME_DEFAULT, NAME_NAMESPACE } from './graph';

/* -------------------------------------------------------------- SymbolRef */

const MOD_SHIFT = 0x200000; // 2^21 symbols per module

/** Pack (moduleIdx, symbolId) into one SymbolRef number: `mod * 2^21 + sym`. Caps at 2M symbols/module. */
export const packRef = (mod: number, sym: number): number => mod * MOD_SHIFT + sym;
/** Module index of a packed SymbolRef. */
export const refMod = (ref: number): number => Math.floor(ref / MOD_SHIFT);
/** Symbol id of a packed SymbolRef. */
export const refSym = (ref: number): number => ref % MOD_SHIFT;

/* ------------------------------------------------------------------ types */

/** Where an import resolves: a graph symbol, an external, a module namespace, or unresolved. */
export type ImportBind =
    | { kind: 'found'; ref: number }
    | { kind: 'external'; specifier: string; name: string }
    | { kind: 'namespace'; module: number }
    | { kind: 'none' };

/** Result of linking: binds, exec order, final names, and synthesized namespaces. */
export type Linked = {
    graph: Graph;
    /** execution order: module idxs, dependencies first (cycle-tolerant) */
    order: number[];
    /** packed local SymbolRef (importer-side) -> bind */
    binds: Map<number, ImportBind>;
    /** packed SymbolRef -> final output name (only when it differs or is synthetic) */
    finalNames: Map<number, string>;
    /** modules whose namespace object must be synthesized (module idx -> ns name) */
    namespaceOf: Map<number, string>;
    /** per module: resolved export map (name -> bind), memoized; entry's drives output */
    exportMaps: Map<number, Map<string, ImportBind>>;
    /** synthetic symbol names: packed ref -> declared name */
    syntheticNames: Map<number, string>;
    /** hoisted external binding: `${specifier}\x00${importedName}` -> final local name */
    externalLocals: Map<string, string>;
    /** per module: synthetic ref for its anonymous `export default <expr>` */
    defaultRefs: Map<number, number>;
    errors: string[];
};

/** Key for the shared local of an external import: `${specifier}\x00${importedName}`. */
export const externalKey = (specifier: string, name: string): string => `${specifier}\x00${name}`;

/* ----------------------------------------------------------- match import */

type LinkCtx = {
    graph: Graph;
    linked: Linked;
    nextSynthetic: number[]; // per module: next synthetic symbol id
};

function syntheticRef(ctx: LinkCtx, mod: number, name: string): number {
    const sym = ctx.nextSynthetic[mod]++;
    const ref = packRef(mod, sym);
    ctx.linked.syntheticNames.set(ref, name);
    return ref;
}

/**
 * Resolve `name` against `module`'s exports, chasing re-exports and searching
 * star exports (with ambiguity detection). `seen` guards re-export cycles —
 * rolldown's MatchImportKind::Cycle case degrades to `none` with an error.
 */
function matchImport(ctx: LinkCtx, module: Module, name: string, seen: Set<number>): ImportBind {
    const { graph } = ctx;
    const seenKey = packRef(module.idx, 0) + hashName(name);
    if (seen.has(seenKey)) return { kind: 'none' }; // circular re-export
    seen.add(seenKey);

    const exp = module.namedExports.get(name);
    if (exp !== undefined) {
        if (exp.rec >= 0) {
            const rec = module.importRecords[exp.rec];
            if (rec.external) return { kind: 'external', specifier: rec.specifier, name: exp.sourceName };
            const target = graph.modules[rec.resolved];
            if (exp.sourceName === NAME_NAMESPACE) return namespaceBind(ctx, target); // export * as ns
            return matchImport(ctx, target, exp.sourceName, seen);
        }
        if (exp.symbol !== 0) return { kind: 'found', ref: packRef(module.idx, exp.symbol) };
        if (exp.exprNode !== null) {
            // anonymous `export default <expr>`: synthesize a binding emitted as
            // `const <name> = <expr>` in place of the export statement.
            const existing = ctx.linked.defaultRefs.get(module.idx);
            if (existing !== undefined) return { kind: 'found', ref: existing };
            const synth = syntheticRef(ctx, module.idx, `${reprName(module)}_default`);
            ctx.linked.defaultRefs.set(module.idx, synth);
            return { kind: 'found', ref: synth };
        }
        return { kind: 'none' };
    }

    // star-export search ('default' is never re-exported through stars per spec)
    if (name !== NAME_DEFAULT) {
        let found: ImportBind | null = null;
        for (const recIdx of module.starExports) {
            const rec = module.importRecords[recIdx];
            if (rec.external) continue; // can't see into external stars
            const candidate = matchImport(ctx, graph.modules[rec.resolved], name, new Set(seen));
            if (candidate.kind === 'none') continue;
            if (found === null) found = candidate;
            else if (!sameBind(found, candidate)) {
                ctx.linked.errors.push(
                    `ambiguous export '${name}' from '${module.id}' (multiple star re-exports provide it)`,
                );
                return { kind: 'none' };
            }
        }
        if (found !== null) return found;
    }
    return { kind: 'none' };
}

function sameBind(a: ImportBind, b: ImportBind): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'found' && b.kind === 'found') return a.ref === b.ref;
    if (a.kind === 'namespace' && b.kind === 'namespace') return a.module === b.module;
    if (a.kind === 'external' && b.kind === 'external') return a.specifier === b.specifier && a.name === b.name;
    return true;
}

function namespaceBind(ctx: LinkCtx, target: Module): ImportBind {
    if (!ctx.linked.namespaceOf.has(target.idx)) {
        ctx.linked.namespaceOf.set(target.idx, `${reprName(target)}_ns`);
    }
    return { kind: 'namespace', module: target.idx };
}

/** Short identifier-safe name derived from a module's path. */
export function reprName(module: Module): string {
    const base = module.id.split('/').pop() ?? 'mod';
    return base.replace(/\.[a-z]+$/i, '').replace(/[^A-Za-z0-9_$]/g, '_');
}

function hashName(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0) % 0x1fffff;
}

/* ------------------------------------------------------- resolved exports */

/** Full resolved export surface of a module (own exports plus star-inherited), memoized. */
export function exportMapOf(ctx: LinkCtx, module: Module): Map<string, ImportBind> {
    const cached = ctx.linked.exportMaps.get(module.idx);
    if (cached !== undefined) return cached;
    const map = new Map<string, ImportBind>();
    ctx.linked.exportMaps.set(module.idx, map); // set-before-fill breaks cycles
    // star-inherited first (own exports shadow them)
    for (const recIdx of module.starExports) {
        const rec = module.importRecords[recIdx];
        if (rec.external) continue;
        const inner = exportMapOf(ctx, ctx.graph.modules[rec.resolved]);
        for (const [name, bind] of inner) {
            if (name === NAME_DEFAULT) continue;
            const prior = map.get(name);
            if (prior !== undefined && !sameBind(prior, bind)) {
                map.set(name, { kind: 'none' }); // ambiguous through stars — poisoned
            } else map.set(name, bind);
        }
    }
    for (const name of module.namedExports.keys()) {
        map.set(name, matchImport(ctx, module, name, new Set()));
    }
    return map;
}

/* ------------------------------------------------------------- exec order */

function sortModules(graph: Graph): number[] {
    const order: number[] = [];
    const state = new Uint8Array(graph.modules.length); // 0 new, 1 visiting, 2 done
    const visit = (idx: number): void => {
        if (idx < 0 || state[idx] !== 0) return; // cycle tolerance: visiting => skip
        state[idx] = 1;
        const mod = graph.modules[idx];
        for (const rec of mod.importRecords) {
            if (!rec.external && rec.resolved >= 0) visit(rec.resolved);
        }
        state[idx] = 2;
        order.push(idx);
    };
    visit(graph.entry);
    return order;
}

/* -------------------------------------------------------------- deconflict */

const RESERVED = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
    'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
    'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'await', 'static', 'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public',
]);

/**
 * Assign final names for every top-level symbol of every included module, all
 * synthetic symbols, and every namespace object. Names must not collide with:
 * each other, any module's unresolved globals (Math, console, ...), or
 * reserved words. First-come keeps its name; later collisions get `name$N`.
 */
function deconflict(ctx: LinkCtx): void {
    const { graph, linked } = ctx;
    const taken = new Set<string>(RESERVED);
    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        for (const node of mod.semantic.unresolved) taken.add(node.name);
    }
    const claim = (base: string): string => {
        let name = base;
        let n = 1;
        while (taken.has(name)) name = `${base}$${n++}`;
        taken.add(name);
        return name;
    };
    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        const moduleScope = mod.semantic.nodeScope[mod.program.id];
        const sem = mod.semantic;
        for (let sym = 1; sym < sem.symCount; sym++) {
            if (sem.symScope[sym] !== moduleScope) continue;
            // import locals are rewritten to their canonical target's name — skip
            if (mod.namedImports.has(sym)) continue;
            const original = sem.symDecl[sym]!.name;
            const final = claim(original);
            if (final !== original) linked.finalNames.set(packRef(idx, sym), final);
        }
    }
    for (const [ref, base] of linked.syntheticNames) {
        linked.finalNames.set(ref, claim(base));
    }
    for (const [modIdx, base] of linked.namespaceOf) {
        linked.namespaceOf.set(modIdx, claim(base));
    }
    // hoisted external bindings: one shared local per (specifier, imported name),
    // preferring the first importer's local name as the base
    const claimExternal = (specifier: string, name: string, base: string): void => {
        const key = externalKey(specifier, name);
        if (linked.externalLocals.has(key)) return;
        linked.externalLocals.set(key, claim(base));
    };
    for (const [ref, bind] of linked.binds) {
        if (bind.kind !== 'external') continue;
        const mod = graph.modules[refMod(ref)];
        const localName = mod.semantic.symDecl[refSym(ref)]!.name;
        claimExternal(bind.specifier, bind.name, localName);
    }
    for (const map of linked.exportMaps.values()) {
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
}

/* ------------------------------------------------------------------ entry */

/** Bind imports/exports across `graph`, order modules, and deconflict names into a {@link Linked}. */
export function linkGraph(graph: Graph): Linked {
    const linked: Linked = {
        graph,
        order: sortModules(graph),
        binds: new Map(),
        finalNames: new Map(),
        namespaceOf: new Map(),
        exportMaps: new Map(),
        syntheticNames: new Map(),
        externalLocals: new Map(),
        defaultRefs: new Map(),
        errors: [],
    };
    const ctx: LinkCtx = {
        graph,
        linked,
        nextSynthetic: graph.modules.map((m) => m.semantic.symCount),
    };

    // bind every named import of every included module
    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        for (const [localSym, imp] of mod.namedImports) {
            const rec = mod.importRecords[imp.rec];
            let bind: ImportBind;
            if (rec.external) {
                bind = { kind: 'external', specifier: rec.specifier, name: imp.name };
            } else if (imp.name === NAME_NAMESPACE) {
                bind = namespaceBind(ctx, graph.modules[rec.resolved]);
            } else {
                bind = matchImport(ctx, graph.modules[rec.resolved], imp.name, new Set());
                if (bind.kind === 'none') {
                    linked.errors.push(
                        `'${imp.name}' is not exported by '${graph.modules[rec.resolved].id}' (imported by '${mod.id}')`,
                    );
                }
            }
            linked.binds.set(packRef(idx, localSym), bind);
        }
        // ensure the module's own anonymous default synthetic exists if exported
        const def = mod.namedExports.get(NAME_DEFAULT);
        if (def !== undefined && def.symbol === 0 && def.rec < 0 && def.exprNode !== null) {
            matchImport(ctx, mod, NAME_DEFAULT, new Set());
        }
    }

    // materialize export maps for namespace-synthesized modules + the entry
    for (const modIdx of linked.namespaceOf.keys()) exportMapOf(ctx, graph.modules[modIdx]);
    if (graph.entry >= 0) exportMapOf(ctx, graph.modules[graph.entry]);

    deconflict(ctx);
    return linked;
}

/** Final output name for a packed ref (the declared name when no rename was recorded). */
export function finalNameOf(linked: Linked, ref: number): string {
    const renamed = linked.finalNames.get(ref);
    if (renamed !== undefined) return renamed;
    const synth = linked.syntheticNames.get(ref);
    if (synth !== undefined) return synth;
    const mod = linked.graph.modules[refMod(ref)];
    return mod.semantic.symDecl[refSym(ref)]!.name;
}
