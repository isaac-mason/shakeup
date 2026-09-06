import { isPureExpr, isPureStatement } from '../analysis/effects.ts';
import { analyzeDynamicUsage, analyzeNsUsage, type NsUsage } from '../analysis/ns-usage.ts';
import { walkRefIdents } from '../analysis/refs.ts';
import { scopeOf, symbolOf } from '../analysis/semantic.ts';
import { N, type Node, walk } from '../ast/index.ts';
import { type Graph, type ImportBind, type Linked, type Module, NAME_NAMESPACE, packRef, refMod, refSym } from './graph-types.ts';
import { staticImportRunsTarget } from './init-obligations.ts';

export type TreeshakeResult = {
    live: Set<number>[];
    dropped: [number, Node][];
    /** Per-target narrowed namespace surface: module idx → the exact member names its
     *  `import * as ns` consumers read. A module absent here keeps its whole surface (it escapes,
     *  is an entry, is dynamically imported, or is re-exported as a namespace). Consumed by the
     *  emit so the namespace object lists only these members. */
    nsUsage: Map<number, Set<string>>;
    /** Dead pure dynamic-import targets: modules reached ONLY via `import()` whose result is never
     *  used and that have no side effects. Not rooted, not promoted to a chunk; their `import()`
     *  sites are rewritten to `Promise.resolve({})`. Consumed by chunk-graph and the emit. */
    deadDynamic: Set<number>;
    /** Every `packRef` referenced by a live statement (rolldown's `reference_needed_symbols`). An
     *  external import binding is needed iff its ref is here — lets us drop unused side-effect-free
     *  externals (e.g. the injected jsx runtime) via symbol liveness, not a JSX-specific AST walk. */
    liveRefs: Set<number>;
    /** Targets whose namespace object need not EXIST: every appearance of every `import * as ns`
     *  binding for them is a static member read, so each `ns.foo` can name `foo`'s own binding
     *  instead. A strict subset of {@link nsUsage}'s keys — narrowing only needs the reads to be
     *  statically known, while elision additionally needs the object to be unobservable, every read
     *  to resolve to a real export, and no `import()` (whose result IS the namespace, at runtime).
     *
     *  rolldown decides the same thing with `ModuleNamespaceIncludedReason`, materialising only a
     *  namespace that is "semantically observed". Measured on crashcat: 63 objects to rolldown's 0. */
    elidableNs: Set<number>;
};

export type StatementInfo = {
    /** The shaking UNIT — a top-level statement, or ONE declarator of a split declaration. */
    statement: Node;
    /** The top-level statement the unit belongs to; `=== statement` unless it is a declarator.
     *  Including a unit marks BOTH ids live, so a consumer can gate on the statement without
     *  knowing whether it was split. */
    owner: Node;
    refs: number[];
    pure: boolean;
};

export type TreeshakeCache = {
    moduleIds: string[];
    infos: StatementInfo[][];
    decls: [number, [number, number]][][];
};

function collectRefs(
    mod: Module,
    linked: Linked,
    statement: Node,
    out: number[],
    declared: number[],
    /** Identifier nodes that are the OBJECT of a read the emitter replaces with an enum constant.
     *  They are not references: `Kind.DYNAMIC` becomes `2` and names nothing. Counting them is what
     *  kept every lowered enum object alive — 231 string literals on crashcat, where rolldown emits
     *  2. Built from `linked.enumInlines`, the SAME map the emitter substitutes from, so the two
     *  cannot disagree. */
    inlinedObjects: Set<Node> | null,
): void {
    const moduleScope = scopeOf(mod.semantic, mod.program);
    const sem = mod.semantic;
    const pushSym = (sym: number): void => {
        if (sym === 0) return;
        if (mod.namedImports.has(sym)) {
            const bind = linked.binds.get(packRef(mod.idx, sym));
            if (bind === undefined) return;
            if (bind.kind === 'found') out.push(bind.ref);
            else if (bind.kind === 'namespace') out.push(packRef(bind.module, NS_MARKER));
            // An external ref roots no internal statement, but recording it lets `liveRefs` gate
            // external-import emission (drop an unused side-effect-free external).
            else if (bind.kind === 'external') out.push(packRef(mod.idx, sym));
            return;
        }
        if (sem.symbols[sym].scope === moduleScope) out.push(packRef(mod.idx, sym));
    };
    // One scan yields both `referenced_symbols` (uses → `out`) and `declared_symbols` (module-scope
    // bindings → `declared`), keyed by SymbolRef identity — the rolldown `StmtInfo` model. No spans:
    // this is robust to synthetic (lowered) nodes, which carry symbols but have no meaningful span.
    // An `import` DECLARES its locals and REFERENCES nothing (rolldown's `StmtInfo` for an import
    // decl carries no referenced_symbols — the module dependency lives on the ImportRecord). Running
    // it through `pushSym` made each specifier's own BindingIdentifier a reference to itself, and
    // since ONE statement carries every specifier, including it for a used name (`mat3`) also rooted
    // the unused ones — crashcat kept `vec4` in its `math` import with zero uses, where oxc drops it.
    // Liveness is per-specifier once the decl stops rooting itself: the specifier is included via
    // `declared` when something actually references it.
    const isImport = statement.type === N.ImportDeclaration;
    walkRefIdents(statement, (ident) => {
        if (inlinedObjects !== null && inlinedObjects.has(ident)) return;
        const sym = symbolOf(sem, ident);
        if (!isImport) pushSym(sym);
        if (ident.type === N.BindingIdentifier && sym !== 0 && sem.symbols[sym].scope === moduleScope) {
            declared.push(packRef(mod.idx, sym));
        }
    });
    // (JSX runtime refs are collected normally now — jsxLower lowers JSX to `jsx(...)` calls before
    // treeshake, so their callee IdentifierReferences are ordinary refs. No JSX-specific walk.)
}

/** The bindings a statement AUGMENTS — every `X.a = …` whose target chain roots at a module-scope
 *  binding, found ANYWHERE in the statement.
 *
 *  `Texture.DEFAULT_IMAGE = null`, `Object3D.DEFAULT_UP = new Vector3(…)`,
 *  `KeyframeTrack.prototype.ValueTypeName = ''` are not free-standing effects: they belong to the
 *  binding. Nothing references them, so under `sideEffects: false` (where impure statements are not
 *  auto-rooted) they drop and the exported class silently loses its statics — which is how honouring
 *  three's `sideEffects` broke `three.core.js` with
 *  `TypeError: Cannot read properties of undefined (reading 'clone')`. rolldown keeps them, and oxc
 *  models the position explicitly as `ReferenceFlags::MemberWriteTarget` ("`A` in `A.foo = 1` …
 *  helps the minifier determine if a symbol's only reads are property-modification targets").
 *
 *  A WHOLE-STATEMENT WALK, deliberately, not a match on statement shape. `compress` runs BEFORE
 *  treeshake, and by the time liveness is computed these writes have been folded well away from the
 *  top level: `joinVars` merges adjacent statements into a `SequenceExpression`, nests those
 *  sequences across rounds, and FUSES runs into a following `if`/`return`/`throw`, after which
 *  `minimizeConditions` can rewrite the `if` into `test && (…)`. Chasing those shapes one at a time
 *  missed a new one every round — sequence, nested sequence, fused if-test, then the left operand of
 *  a `&&`. Rollup does not pattern-match either: it attributes an effect to the VARIABLE, and
 *  including the variable includes its mutations. This walk is that model.
 *
 *  Over-retention is safe (a statement kept because a live binding is written somewhere inside it);
 *  under-retention is a miscompile. So the walk is greedy and does not reason about whether a branch
 *  actually executes. */
function augmentedRefs(mod: Module, linked: Linked, statement: Node): number[] {
    const out: number[] = [];
    walk(statement, (n) => {
        const ref = augmentedByAssignment(mod, linked, n);
        if (ref !== 0 && !out.includes(ref)) out.push(ref);
        return undefined;
    });
    return out;
}

/** The binding one `X.a.b = …` expression augments, or 0. */
function augmentedByAssignment(mod: Module, linked: Linked, expr: Node): number {
    if (expr.type !== N.AssignmentExpression || expr.data.operator !== '=') return 0;
    let target: Node = expr.data.left;
    let sawMember = false;
    while (target.type === N.StaticMemberExpression || target.type === N.ComputedMemberExpression) {
        if (target.type === N.ComputedMemberExpression) return 0; // key may have its own effects
        sawMember = true;
        target = target.data.object;
    }
    if (!sawMember || target.type !== N.IdentifierReference) return 0;
    const sym = symbolOf(mod.semantic, target);
    if (sym === 0) return 0;
    if (mod.namedImports.has(sym)) {
        const bind = linked.binds.get(packRef(mod.idx, sym));
        return bind !== undefined && bind.kind === 'found' ? bind.ref : 0;
    }
    return mod.semantic.symbols[sym].scope === scopeOf(mod.semantic, mod.program) ? packRef(mod.idx, sym) : 0;
}

/** The tree-shaking UNITS of a top-level statement.
 *
 *  Normally one: the statement. But a multi-declarator `var a = 1, b = 2` is one STATEMENT holding
 *  several independent bindings, and shaking whole statements means demanding `a` keeps `b` too.
 *  esbuild solves this by emitting one PART per declarator (`js_parser.go`, "Split up top-level
 *  multi-declaration variable statements"); rolldown rewrites the AST into separate statements before
 *  scanning (`tweak_ast_for_scanning.rs` `split_multi_declarator`).
 *
 *  shakeup takes esbuild's shape rather than rolldown's: the UNIT changes, the tree does not. Nothing
 *  is mutated, so spans and source maps are untouched, no pass ordering moves, and — the reason it
 *  matters here — `compress` runs BEFORE treeshake and would simply re-merge anything a rewrite had
 *  split. Keying liveness on the declarator survives that.
 *
 *  GUARD (rolldown's): every declarator must bind a plain identifier. A pattern
 *  (`const [a] = iterable, b = 2`) stays one unit — destructuring performs iterator/property work
 *  that is not represented once a declarator is considered alone. */
function shakeUnits(statement: Node): Node[] {
    const decl =
        statement.type === N.VariableDeclaration
            ? statement
            : statement.type === N.ExportNamedDeclaration &&
                (statement.data.declaration as Node | null)?.type === N.VariableDeclaration
              ? (statement.data.declaration as Node)
              : null;
    if (decl === null) return [statement];
    const decls = (decl.data as { declarations: Node[] }).declarations;
    if (decls.length < 2 || !decls.every((d) => (d.data as { id: Node }).id.type === N.BindingIdentifier)) return [statement];
    return decls;
}

/** A declarator is pure exactly when its initializer is — the declaration itself binds and nothing more. */
function unitIsPure(mod: Module, linked: Linked, unit: Node, statement: Node): boolean {
    if (unit === statement) return statementIsPure(mod, linked, statement);
    const d = unit.data as { id: Node; init: Node | null };
    // DESTRUCTURING READS PROPERTIES, and a property read can run a getter:
    //
    //     Object.defineProperty(obj, 'x', { get() { ++effects } });
    //     const { x } = obj;        // x unused — but the getter must still fire
    //
    // We judged the declarator by its INIT alone (`obj`, a bare identifier, is pure) and dropped it,
    // losing the side effect. All three oracles keep it: rollup's `propertyReadSideEffects` defaults
    // to true, and rolldown and esbuild agree — measured on this exact input.
    //
    // Conservative on purpose: an object literal with only data properties could safely be dropped,
    // but array destructuring also invokes `Symbol.iterator`, and neither is worth proving for the
    // handful of bytes it would save. A pattern is a read.
    if (d.id.type !== N.BindingIdentifier) return false;
    return isPureExpr(d.init);
}

function statementIsPure(mod: Module, linked: Linked, statement: Node): boolean {
    // AN INIT OBLIGATION IS A SIDE EFFECT — see `staticImportRunsTarget` for which targets have one
    // and why dropping the statement would lose the module's evaluation entirely. A re-export is the
    // same dependency edge as an import, so it is asked the same question: `export { v } from './e'`
    // in a barrel is what runs `e`, and shaking it away left `e` never evaluated.
    if (
        statement.type === N.ImportDeclaration ||
        statement.type === N.ExportNamedDeclaration ||
        statement.type === N.ExportAllDeclaration
    ) {
        const src = statement.data.source as Node | null;
        if (src !== null && src.type === N.StringLiteral) {
            const spec = mod.source.slice(src.start + 1, src.end - 1);
            const rec = mod.importRecords.find((r) => r.specifier === spec && r.kind === 'static');
            if (rec !== undefined && staticImportRunsTarget(linked, rec)) return false;
        }
    }
    if (statement.type === N.ImportDeclaration) {
        const source = statement.data.source;
        if (source.type !== N.StringLiteral) return true;
        const spec = mod.source.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec && r.kind === 'static');
        if (statement.data.specifiers.length > 0) return true;
        return !(rec?.external ?? false);
    }
    if (statement.type === N.ExportAllDeclaration) {
        // An ENTRY's `export * from '<external>'` is part of its public export surface, but the names
        // it contributes are not statically known, so it never appears in an export map and nothing
        // roots it — it was shaken away and `basename` from `export * from 'path'` simply vanished.
        // Treated as impure so it survives, the same way a bare `import '<external>'` is kept for its
        // side effect just above.
        //
        // ENTRY only: a non-entry external star is already reported as dropped
        // (`trackChunkSpecs`), because there is nowhere in a concatenated bundle to put it.
        const source = statement.data.source;
        if (source.type !== N.StringLiteral) return true;
        const spec = mod.source.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec);
        return !(mod.isEntry && (rec?.external ?? false));
    }
    return isPureStatement(statement);
}

/** pseudo-symbol id marking "the whole namespace of this module" */
const NS_MARKER = 0x1fffff;

/** Determine which namespace-import targets can have their materialized namespace object narrowed
 *  to the exact members read. A target is narrowable only if EVERY namespace bind to it is a
 *  non-escaping member read (static `import * as ns` OR dynamic `import()` result) — so any of
 *  these forces the whole surface instead: it's an entry, it's re-exported as a namespace
 *  (`export * as ns` — opaque downstream), or some consumer escapes. A dead target is dropped
 *  outright. Returns target idx → the union of member names read across all its consumers. */
function computeNsUsage(
    graph: Graph,
    dynUsage: Map<number, NsUsage>,
    deadDynamic: Set<number>,
    /** Out-param: target → the member names some consumer CALLED off it. */
    called: Map<number, Set<string>>,
    /** Out-param: every `ns.foo` read, positioned — see {@link computeNsSites}. */
    reads: NsRead[],
): Map<number, Set<string>> {
    const forceWhole = new Set<number>();
    for (const { module } of graph.entries) forceWhole.add(module);
    // `export * as ns from './m'` re-exports m's whole namespace opaquely.
    for (const mod of graph.modules) {
        for (const exp of mod.namedExports.values()) {
            if (exp.sourceName !== NAME_NAMESPACE || exp.rec < 0) continue;
            const rec = mod.importRecords[exp.rec];
            if (!rec.external && rec.resolved >= 0) forceWhole.add(rec.resolved);
        }
    }

    // Accumulate member reads (and escape) per target across BOTH `import * as ns` consumers and
    // `import()` consumers — a module's namespace surface is the union of everything read of it.
    const acc = new Map<number, NsUsage>();
    const fold = (target: number, u: NsUsage): void => {
        let a = acc.get(target);
        if (a === undefined) {
            a = { escapes: false, called: new Set(), members: new Set() };
            acc.set(target, a);
        }
        if (u.escapes) a.escapes = true;
        for (const m of u.called) a.called.add(m);
        for (const m of u.members) a.members.add(m);
    };
    for (const mod of graph.modules) {
        const nsSyms = new Map<number, number>(); // local ns symbol → target module idx
        for (const [localSym, imp] of mod.namedImports) {
            if (imp.name !== NAME_NAMESPACE) continue;
            const rec = mod.importRecords[imp.rec];
            if (rec.external || rec.resolved < 0) continue;
            nsSyms.set(localSym, rec.resolved);
        }
        if (nsSyms.size === 0) continue;
        const usage = analyzeNsUsage(mod.program, mod.semantic, new Set(nsSyms.keys()), (sym, name, at) =>
            reads.push({ mod: mod.idx, target: nsSyms.get(sym) as number, name, at }),
        );
        for (const [localSym, target] of nsSyms) fold(target, usage.get(localSym)!);
    }
    for (const [target, u] of dynUsage) fold(target, u);

    const narrowable = new Map<number, Set<string>>();
    for (const [target, a] of acc) {
        // Dead targets are dropped entirely (no namespace object); escaping / entry / re-exported
        // targets need their whole surface.
        if (a.escapes || forceWhole.has(target) || deadDynamic.has(target)) continue;
        narrowable.set(target, a.members);
        if (a.called.size > 0) called.set(target, a.called);
    }
    return narrowable;
}

/** One `ns.foo` READ: which module it is in, which target's member it names, and where. */
type NsRead = { mod: number; target: number; name: string; at: number };

/**
 * WHICH TOP-LEVEL UNITS READ EACH NAMESPACE MEMBER.
 *
 * {@link computeNsUsage} unions the member reads across a whole consumer MODULE, which made the
 * narrowed surface independent of liveness: a member named only by code the shaker drops survived,
 * and — when the object is materialised — was still stamped onto it. Isolated in
 * `llm/repro/expandns`: `function neverUsed(){ return ns.onlyInDeadCode() }` is dropped from the
 * chunk that contains it while `onlyInDeadCode` stays in the bundle. rolldown emits neither, because
 * its member-expr refs are resolved per REFERENCE (`bind_imports_and_exports.rs`) and a reference
 * inside a dropped statement is not one.
 *
 * The provenance has to be recorded against the same thing `live` is keyed by, and that is the UNIT
 * — a DECLARATOR for a split declaration — which does not exist yet when the reads are collected.
 * So the reads are collected by POSITION during the walk `computeNsUsage` already does, and bound to
 * units here by binary search over their spans. Re-walking each unit instead cost 7.2ms on crashcat
 * for the same answer; this reuses the walk and costs one array of `{mod,target,name,at}`.
 *
 * A member with NO recorded site is treated as live by {@link treeshake}. That is the sound
 * direction, and it is what carries members contributed by `import()` usage (`dynUsage`), whose
 * reads are not attributed to a unit here.
 */
function computeNsSites(
    reads: NsRead[],
    infos: StatementInfo[][],
    narrowable: Map<number, Set<string>>,
): Map<number, Map<string, [number, number][]>> {
    const out = new Map<number, Map<string, [number, number][]>>();
    for (const { mod, target, name, at } of reads) {
        if (!narrowable.has(target)) continue;
        // Units tile the module in source order and never overlap, so the one containing a read is
        // the last whose span starts at or before it. A read that lands in NO unit (between two, or
        // in a construct `shakeUnits` does not yield) records no site and is therefore kept.
        const list = infos[mod];
        let lo = 0;
        let hi = list.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].statement.start <= at) {
                found = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        if (found < 0 || list[found].statement.end < at) continue;
        let byName = out.get(target);
        if (byName === undefined) out.set(target, (byName = new Map()));
        let sites = byName.get(name);
        if (sites === undefined) byName.set(name, (sites = []));
        sites.push([mod, found]);
    }
    return out;
}

/** Does this module contain a `this` anywhere? The over-approximation behind the namespace-method
 *  widening above: if nothing in the module that defines an export mentions `this`, no call of that
 *  export can read a member off the namespace it was called on. Cached — only ever asked about the
 *  handful of modules that provide a called namespace member. */
function moduleMentionsThis(graph: Graph, modIdx: number, cache: Map<number, boolean>): boolean {
    const hit = cache.get(modIdx);
    if (hit !== undefined) return hit;
    let found = false;
    walk(graph.modules[modIdx].program, (n) => {
        if (n.type === N.ThisExpression) found = true;
        return found ? false : undefined;
    });
    cache.set(modIdx, found);
    return found;
}

/** {@link TreeshakeResult.elidableNs}. Runs off the SAME accumulator narrowing uses, then removes
 *  everything narrowing tolerates but elision cannot. */
function computeElidableNs(graph: Graph, linked: Linked, narrowable: Map<number, Set<string>>): Set<number> {
    // A dynamically imported module's namespace is a real runtime value — `import()` resolves TO it —
    // so it must exist however statically its members are read. `hasDynamicLiteral` and not just
    // `kind === 'dynamic'`: a specifier imported both ways is deduped into one static record and the
    // dynamic-ness survives only on that flag.
    const dynamicTargets = new Set<number>();
    for (const mod of graph.modules)
        for (const rec of mod.importRecords)
            if ((rec.kind === 'dynamic' || rec.hasDynamicLiteral) && !rec.external && rec.resolved >= 0)
                dynamicTargets.add(rec.resolved);

    const out = new Set<number>();
    for (const [target, members] of narrowable) {
        if (dynamicTargets.has(target)) continue;
        // A module that `export *`s from CommonJS has a surface that is only known once `__reExport`
        // has run, so no member read can be resolved here.
        if (linked.dynamicExports.has(target)) continue;
        const map = linked.exportMaps.get(target);
        if (map === undefined) continue;
        // Every read must resolve to a real export. `ns.missing` has no binding to name, and
        // silently emitting `undefined` would turn a diagnosable mistake into a wrong value.
        let allResolve = true;
        for (const name of members)
            if (!map.has(name)) {
                allResolve = false;
                break;
            }
        if (!allResolve) continue;
        // SHADOWING is NOT decided here. `dep.mutate(…)` inside `function test(mutate){…}` cannot be
        // emitted as `mutate(…)` — the parameter wins — but the answer is to RENAME THE PARAMETER,
        // which is deconfliction's job and not a reason to refuse the elision. `linked.elidableNs`
        // carries this set into `deshadowLocals`, which already does exactly that for ordinary
        // imports; rolldown likewise resolves member-expr refs in link_stage and deconflicts after.
        //
        // Refusing instead was worth 7,362 raw / 431 brotli on crashcat, and 122 of its 129 refusals
        // were a top-level binding that could not have captured anything in the first place.
        out.add(target);
    }
    return out;
}

/** Aggregate how each dynamic-import target's resolved module is consumed, unioned across every
 *  `import()` site (in any module) that resolves to it. */
function computeDynamicUsage(graph: Graph): Map<number, NsUsage> {
    const acc = new Map<number, NsUsage>();
    for (const mod of graph.modules) {
        // The scan already recorded every `import()` site, so a module with none cannot produce one —
        // checking that is O(records) against a walk of the whole module.
        //
        // `hasDynamicLiteral` is load-bearing, not belt-and-braces: when a specifier is imported BOTH
        // statically and dynamically the records are deduped into a single `static` one, and the
        // dynamic-ness survives only on that flag. Gating on `kind === 'dynamic'` alone silently
        // skipped those modules — caught by `dynamic-narrow` and `treeshake`, which cover exactly the
        // mixed case.
        if (!mod.importRecords.some((r) => r.kind === 'dynamic' || r.hasDynamicLiteral)) continue;
        const sites = analyzeDynamicUsage(mod.program, mod.semantic, mod.source);
        for (const { specifier, usage } of sites) {
            const rec = mod.importRecords.find((r) => r.specifier === specifier);
            if (rec === undefined || rec.external || rec.resolved < 0) continue;
            let a = acc.get(rec.resolved);
            if (a === undefined) {
                a = { escapes: false, called: new Set(), members: new Set() };
                acc.set(rec.resolved, a);
            }
            if (usage.escapes) a.escapes = true;
            for (const m of usage.called) a.called.add(m);
            for (const m of usage.members) a.members.add(m);
        }
    }
    return acc;
}

/** Dead pure dynamic imports: a target reached ONLY through `import()` (no static edge), never an
 *  entry, whose every `import()` result is discarded (usage is `none`), and which is declared
 *  side-effect-free — so loading it is observably a no-op and it can be dropped entirely. */
function computeDeadDynamic(graph: Graph, dynUsage: Map<number, NsUsage>): Set<number> {
    const entrySet = new Set(graph.entries.map((e) => e.module));
    const staticTargets = new Set<number>();
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.kind === 'static' && !rec.external && rec.resolved >= 0) staticTargets.add(rec.resolved);
        }
    }
    const dead = new Set<number>();
    for (const [target, usage] of dynUsage) {
        if (usage.escapes || usage.members.size > 0) continue; // result is used somewhere
        if (entrySet.has(target) || staticTargets.has(target)) continue; // reachable another way
        if (graph.modules[target].sideEffects !== false) continue; // loading it may be observable
        dead.add(target);
    }
    return dead;
}

/** Compute statement-level liveness over the linked graph, rooted at the entry's exports and every effectful statement. */
export function treeshake(graph: Graph, linked: Linked, cache?: TreeshakeCache): TreeshakeResult {
    const dynUsage = computeDynamicUsage(graph);
    const deadDynamic = computeDeadDynamic(graph, dynUsage);
    const thisCache = new Map<number, boolean>();
    const nsCalled = new Map<number, Set<string>>();
    const nsReads: NsRead[] = [];
    const nsUsage = computeNsUsage(graph, dynUsage, deadDynamic, nsCalled, nsReads);
    const elidableNs = computeElidableNs(graph, linked, nsUsage);
    // A namespace some consumer CALLS a member off (`ns.foo()`) and that still gets built keeps its
    // WHOLE surface: the callee receives the object as `this`, so `this.other` must find `other`.
    //
    // Two things keep this from costing the narrowing everywhere (+1,704 minified bytes on crashcat
    // when it did). Elision runs FIRST and is allowed to keep narrowing: an elided namespace has no
    // object, `ns.foo()` becomes `foo()`, and losing `this` there is what Rollup does too. And a
    // callee that cannot mention `this` cannot observe the namespace — approximated per MODULE (does
    // the module defining that export contain a `this` at all), which is cheap, sound, and false only
    // in the direction of keeping too much.
    for (const [target, names] of nsCalled) {
        if (elidableNs.has(target) || !nsUsage.has(target)) continue;
        const map = linked.exportMaps.get(target);
        if (map === undefined) continue;
        let observable = false;
        for (const name of names) {
            const bind = map.get(name);
            // An unresolved or namespace-valued export: no single defining module to consult.
            if (bind === undefined || (bind.kind !== 'found' && bind.kind !== 'cjs-member')) {
                observable = true;
                break;
            }
            if (moduleMentionsThis(graph, refMod(bind.ref), thisCache)) {
                observable = true;
                break;
            }
        }
        if (observable) nsUsage.delete(target);
    }
    const live: Set<number>[] = graph.modules.map(() => new Set());
    const infos: StatementInfo[][] = [];
    const declArrays: [number, [number, number]][][] = [];

    /** packed declared-symbol ref -> [moduleIdx, statement list index] */
    /** binding → the statements that augment it (`X.foo = …`), pulled in when the binding goes live. */
    const augmentsOf = new Map<number, [number, number][]>();
    const declToStatement = new Map<number, [number, number]>();
    /**
     * The OTHER units that declare a symbol, when there is more than one.
     *
     * `var b = 3; var b = b - 1;` declares `b` twice, and a `Map` keyed by symbol keeps only the last
     * write — so marking `b` live included the second declarator and shook the first, emitting
     * `var b = b - 1` with `b` undefined. That is a miscompile, not a missed optimisation: the second
     * declarator READS what the first wrote. Rollup's own suite catches it four ways
     * (`unused-{while,do-while,for-in,for-of}-loop-declaration`), where the duplicate `var` is the
     * loop body.
     *
     * A separate map rather than making every value an array: duplicate declarations are rare, so the
     * common path keeps its single tuple and allocates nothing.
     */
    const extraDecls = new Map<number, [number, number][]>();
    /** Record that `ref` is declared by unit `val`, keeping any declaration already recorded. */
    const noteDecl = (ref: number, val: [number, number]): void => {
        const prev = declToStatement.get(ref);
        if (prev === undefined) {
            declToStatement.set(ref, val);
            return;
        }
        if (prev[0] === val[0] && prev[1] === val[1]) return;
        const list = extraDecls.get(ref);
        if (list === undefined) extraDecls.set(ref, [val]);
        else if (!list.some((e) => e[0] === val[0] && e[1] === val[1])) list.push(val);
    };

    // Incremental reuse: when topology is unchanged (module id list identical → stable indices),
    // reuse a module's infos unless it was re-parsed or imports a re-parsed module (whose new
    // symbol ids would change this module's binds/refs). The rest rebuild; propagation re-runs.
    const moduleIds = graph.modules.map((m) => m.id);
    const topoStable =
        cache !== undefined &&
        cache.moduleIds.length === moduleIds.length &&
        moduleIds.every((id, i) => id === cache.moduleIds[i]);
    const reshake = new Set<number>();
    if (topoStable) {
        for (let i = 0; i < graph.modules.length; i++) if (graph.changed.has(moduleIds[i])) reshake.add(i);
        for (const c of [...reshake]) {
            for (const impId of graph.modules[c].importers) {
                const ii = graph.byId.get(impId);
                if (ii !== undefined) reshake.add(ii);
            }
        }
    }

    for (const mod of graph.modules) {
        if (topoStable && cache !== undefined && !reshake.has(mod.idx)) {
            infos.push(cache.infos[mod.idx]);
            declArrays.push(cache.decls[mod.idx]);
            for (const [ref, val] of cache.decls[mod.idx]) noteDecl(ref, val);
            continue;
        }
        const list: StatementInfo[] = [];
        const localDecls: [number, [number, number]][] = [];
        // Once per module, not per statement: the map is keyed by member-expression node and the
        // reference walk needs the OBJECT identifiers those hang off.
        const inlines = linked.enumInlines.get(mod.idx);
        let inlinedObjects: Set<Node> | null = null;
        if (inlines !== undefined) {
            inlinedObjects = new Set<Node>();
            for (const n of inlines.keys()) inlinedObjects.add((n.data as { object: Node }).object);
        }
        const body = mod.program.data.body;
        for (let idx = 0; idx < body.length; idx++) {
            const statement = body[idx];
            // One info per UNIT, not per statement — see `shakeUnits`. `live` therefore holds
            // DECLARATOR ids for a split declaration, and the printer emits only those.
            // NOTE indices below are into `list` (units), NOT into `body` — they diverge as soon as
            // one statement yields several units, and `includeStatement` indexes `list`.
            const unitStart = list.length;
            for (const unit of shakeUnits(statement)) {
                const refs: number[] = [];
                const declared: number[] = [];
                collectRefs(mod, linked, unit, refs, declared, inlinedObjects);
                list.push({ statement: unit, owner: statement, refs, pure: unitIsPure(mod, linked, unit, statement) });
                for (const ref of declared) {
                    noteDecl(ref, [mod.idx, list.length - 1]);
                    localDecls.push([ref, [mod.idx, list.length - 1]]);
                }
            }
            for (const aug of augmentedRefs(mod, linked, statement)) {
                let sites = augmentsOf.get(aug);
                if (sites === undefined) augmentsOf.set(aug, (sites = []));
                sites.push([mod.idx, unitStart]);
            }
        }
        const defRef = linked.defaultRefs.get(mod.idx);
        if (defRef !== undefined) {
            for (let i = 0; i < list.length; i++) {
                if (list[i].statement.type === N.ExportDefaultDeclaration) {
                    noteDecl(defRef, [mod.idx, i]);
                    localDecls.push([defRef, [mod.idx, i]]);
                    break;
                }
            }
        }
        infos.push(list);
        declArrays.push(localDecls);
    }

    // Provenance for the narrowed namespace surfaces, now that there are units to attribute reads to.
    const nsSites = computeNsSites(nsReads, infos, nsUsage);
    /** Does any unit that reads `target.name` survive? No recorded site means "not attributed" —
     *  `import()` usage, most of it — and those are kept unconditionally. */
    const nsMemberLive = (target: number, name: string): boolean => {
        const sites = nsSites.get(target)?.get(name);
        if (sites === undefined) return true;
        for (const [m, i] of sites) if (live[m].has(infos[m][i].statement.id)) return true;
        return false;
    };

    const worklist: number[] = [];
    const liveRefs = new Set<number>();
    const markRef = (ref: number): void => {
        if (liveRefs.has(ref)) return;
        liveRefs.add(ref);
        worklist.push(ref);
    };
    const includeStatement = (modIdx: number, idx: number): void => {
        const info = infos[modIdx][idx];
        if (live[modIdx].has(info.statement.id)) return;
        live[modIdx].add(info.statement.id);
        // ONE SOURCE OF TRUTH. `live` records every id an emitter needs to test, so nothing
        // downstream has to re-derive which declarations were split:
        //   • the OWNER statement, so the statement-level gate works for a split unit too;
        //   • every declarator of an UNSPLIT declaration, so "keep declarators present in `live`"
        //     is a uniform rule rather than one conditional on how this statement was treated.
        if (info.owner !== info.statement) live[modIdx].add(info.owner.id);
        else if (info.statement.type === N.VariableDeclaration || info.statement.type === N.ExportNamedDeclaration) {
            const decl =
                info.statement.type === N.VariableDeclaration ? info.statement : (info.statement.data.declaration as Node | null);
            if (decl !== null && decl.type === N.VariableDeclaration) {
                for (const d of decl.data.declarations as Node[]) live[modIdx].add(d.id);
            }
        }
        for (const r of info.refs) markRef(r);
    };

    // A WRAPPED CommonJS module is all-or-nothing: its exports are built imperatively at runtime, so
    // no statement in it can be shown dead by symbol liveness. rolldown reaches the same place via
    // whole-module inclusion for `WrapKind::Cjs`.
    for (const modIdx of linked.cjsWrap.keys()) {
        for (let i = 0; i < infos[modIdx].length; i++) includeStatement(modIdx, i);
    }
    for (const mod of graph.modules) {
        // Module-level side-effect gate: a module marked `false` does NOT auto-root its impure
        // statements — they drop if unreferenced; `'no-treeshake'` roots EVERY statement (forces
        // full inclusion).
        if (mod.sideEffects === false) continue;
        const forceAll = mod.sideEffects === 'no-treeshake';
        for (let i = 0; i < infos[mod.idx].length; i++) {
            if (forceAll || !infos[mod.idx][i].pure) includeStatement(mod.idx, i);
        }
    }
    const markBind = (bind: ImportBind): void => {
        if (bind.kind === 'found' || bind.kind === 'cjs-member') markRef(bind.ref);
        else if (bind.kind === 'namespace') markRef(packRef(bind.module, NS_MARKER));
    };
    const markExportMap = (map: Map<string, ImportBind> | undefined): void => {
        if (map === undefined) return;
        for (const bind of map.values()) markBind(bind);
    };
    /** Expand a live NS_MARKER: mark the target's export surface — narrowed to just the members its
     *  consumers read when the target is narrowable, otherwise the whole surface. */
    const nsExpanded = new Set<number>();
    const expandNs = (modIdx: number): void => {
        const map = linked.exportMaps.get(modIdx);
        if (map === undefined) return;
        const narrow = nsUsage.get(modIdx);
        if (narrow === undefined) {
            for (const bind of map.values()) markBind(bind);
            return;
        }
        // A narrowed surface is liveness-DEPENDENT, so this is not a one-shot: a member whose only
        // reader is dead now may have a live reader later, once something else roots that unit.
        // Remember the target and re-run below until nothing moves.
        nsExpanded.add(modIdx);
        for (const name of narrow) {
            if (!nsMemberLive(modIdx, name)) continue;
            const bind = map.get(name);
            if (bind !== undefined) markBind(bind);
        }
    };
    // Root from every entry's export surface (multi-entry).
    for (const { module } of graph.entries) markExportMap(linked.exportMaps.get(module));
    // Dynamic-import liveness: a dynamically-imported module is an inclusion root — its whole
    // export surface may be reached at runtime. Seed each dynamic target's export map.
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            // Any literal `import()` of the target — whether its record is a pure dynamic edge or a
            // statically-dominant one that also carries an `import()` (`hasDynamicLiteral`).
            if (rec.kind !== 'dynamic' && !rec.hasDynamicLiteral) continue;
            if (rec.external || rec.resolved < 0 || deadDynamic.has(rec.resolved)) continue;
            // Narrowed to the members its consumers read (expandNs consults nsUsage); whole surface
            // when the target escaped / is re-exported / is also a static entry.
            expandNs(rec.resolved);
        }
    }
    for (const modIdx of linked.namespaceOf.keys()) markRef(packRef(modIdx, NS_MARKER));

    const drain = (): void => {
        while (worklist.length > 0) {
            const ref = worklist.pop() as number;
            if (refSym(ref) === NS_MARKER) {
                expandNs(refMod(ref));
                continue;
            }
            const decl = declToStatement.get(ref);
            if (decl !== undefined) includeStatement(decl[0], decl[1]);
            // Every OTHER declaration of the same symbol too — see `extraDecls`.
            const extra = extraDecls.get(ref);
            if (extra !== undefined) for (const [m, i] of extra) includeStatement(m, i);
            // A live binding drags in the statements that augment it. Their own refs are marked in
            // turn by `includeStatement`, so `Object3D.DEFAULT_UP = new Vector3(0,1,0)` keeps
            // `Vector3` alive.
            const aug = augmentsOf.get(ref);
            if (aug !== undefined) for (const [m, i] of aug) includeStatement(m, i);
        }
    };
    drain();

    // `sideEffects: false` says the MODULE MAY BE OMITTED when nothing needs it. It does NOT license
    // deleting the effects of a module that IS included — and reading it that way silently deleted
    // `registry.set(…)`, `arr.push(…)`, `deep.inner.m.add(…)` and even `console.log(…)`, leaving a
    // program that computes the wrong answer. Only `X.a = …` survived, because `augmentedByAssignment`
    // happens to root that one shape.
    //
    // rolldown's behaviour, mapped by probe rather than assumed (ROADMAP §2z47): a module reached
    // ONLY for its effects is dropped whole (so the flag does work), but once ANY binding of it is
    // needed, its top-level effects are kept — including effects unrelated to the binding that pulled
    // it in. A module whose only export gets constant-folded away is simply not included, which is
    // what made this look like a granularity rule and is not one.
    //
    // So: rooted AFTER the fixpoint, and only for a module something already reached. Rooting these
    // can make more modules reachable, hence the loop.
    for (;;) {
        let added = false;
        for (const mod of graph.modules) {
            if (mod.sideEffects !== false) continue;
            const list = infos[mod.idx];
            if (!list.some((info) => live[mod.idx].has(info.statement.id))) continue;
            for (let i = 0; i < list.length; i++) {
                const st = list[i].statement;
                if (list[i].pure || live[mod.idx].has(st.id)) continue;
                // BARE effects only. A DECLARATION's fate stays governed by its binding, which is
                // precisely what the flag licenses: rolldown drops `var b = mk('BBB')` when `b` is
                // dead even though the initialiser is an impure call, while keeping a free-standing
                // `console.log(…)` in the same module (both measured). Rooting declarations too kept
                // every dead declarator alive and broke six existing tests — the granularity the
                // `treeshake-declarators` suite exists to pin.
                if (
                    st.type === N.VariableDeclaration ||
                    st.type === N.FunctionDeclaration ||
                    st.type === N.ClassDeclaration ||
                    st.type === N.ExportNamedDeclaration ||
                    st.type === N.ExportDefaultDeclaration
                )
                    continue;
                includeStatement(mod.idx, i);
                added = true;
            }
        }
        // A unit that just went live may be the only reader of a namespace member nothing had marked.
        // Monotone in both directions — liveness only grows, and so does each narrowed surface — so
        // this terminates for the same reason the rooting above does.
        for (const modIdx of nsExpanded) expandNs(modIdx);
        if (worklist.length > 0) added = true;
        if (!added) break;
        drain();
    }

    // The narrowed surfaces are what the EMITTER builds the namespace object from
    // (`generate/modules.ts`) and what a dynamic-entry chunk exports (`generate/esm.ts`). Marking and
    // emission have to agree: leaving the union here would stamp a property whose binding was just
    // shaken, which is a dangling reference, not a wasted byte.
    //
    // PRUNED IN PLACE, never deleted: an ABSENT entry means "no narrowing, emit the whole surface"
    // to both of those readers and to `expandNs`, so dropping a surface that narrowed to nothing
    // would widen it back to everything.
    for (const [target, names] of nsUsage) {
        for (const name of names) if (!nsMemberLive(target, name)) names.delete(name);
    }

    const dropped: [number, Node][] = [];
    for (const mod of graph.modules) {
        for (const info of infos[mod.idx]) {
            if (live[mod.idx].has(info.statement.id)) continue;
            const t = info.statement.type;
            if (
                t === N.ImportDeclaration ||
                t === N.ExportAllDeclaration ||
                t === N.EmptyStatement ||
                t === N.TSInterfaceDeclaration ||
                t === N.TSTypeAliasDeclaration
            )
                continue;
            dropped.push([mod.idx, info.statement]);
        }
    }
    if (cache !== undefined) {
        cache.moduleIds = moduleIds;
        cache.infos = infos;
        cache.decls = declArrays;
    }
    return { live, dropped, nsUsage, deadDynamic, liveRefs, elidableNs };
}
