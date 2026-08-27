// Transform-stage substrate (oxc `Traverse`/`TraverseCtx` model, adapted to shakeup).
//
// Two pieces:
//  1. `buildWalkers()` — codegens one specialized recursor per node type via `new Function`, once
//     at load. Because dispatch is by `node.type`, each walker's `node.data` is a single shape, so
//     `node.data.left` is a MONOMORPHIC named read (oxc's generated `.left`), not the megamorphic
//     `data[dynamicKey]` a single generic walk is forced into (~15% faster; spike: xwalk.ts). `eval`
//     is already mandated by the module-runner (`module-runner.ts` `new AsyncFunction`), so no CSP
//     concern and no fallback.
//  2. A mutable enter/exit traversal: passes are `Visitor`s with `enter`/`exit` hook tables indexed
//     by `node.type`; each node fires every visitor's hook in order (fused), and hooks mutate via
//     `ctx.replaceWith` / `replaceWithMultiple` / `remove`. Whole-AST (expressions included).
import { emitRefFacts, REF } from '../analysis/ref-facts.ts';
import { refFor, retireSymbol as retireSymbolIn, SCOPE, type Semantic } from '../analysis/semantic.ts';
import { CHILD_FIELDS, N, type Node, TYPE_COUNT, walk } from '../ast.ts';

type Hook = (node: Node, ctx: TransformCtx) => void;

/** A transform pass. `enter`/`exit` are hook tables indexed by `node.type` (null = no hooks of that
 *  phase) — explicit `null` (not optional) so every `Visitor` shares one hidden class. */
export type Visitor = {
    name: string;
    enter: (Hook | null)[] | null;
    exit: (Hook | null)[] | null;
};

/** Build an enter/exit hook table (length `TYPE_COUNT`) from a `{ [nodeType]: hook }` map. */
export function hookTable(map: Record<number, Hook>): (Hook | null)[] {
    const t = new Array<Hook | null>(TYPE_COUNT).fill(null);
    for (const k of Object.keys(map)) t[Number(k)] = map[Number(k)];
    return t;
}

// --- codegen'd per-type walkers ------------------------------------------------------------------
type Field = { name: string; list: boolean };
const FIELDS: Field[][] = new Array(TYPE_COUNT);
for (let i = 0; i < TYPE_COUNT; i++) FIELDS[i] = [];
for (const [typeName, fields] of Object.entries(CHILD_FIELDS)) {
    FIELDS[(N as Record<string, number>)[typeName]] = fields as Field[];
}

type SingleFn = (node: Node, ctx: Ctx) => Node;
type ListFn = (list: (Node | null)[], ctx: Ctx) => void;
// `new Function` bodies run in global scope, so the visit helpers are passed in as `S`/`L`.
type Walker = (node: Node, ctx: Ctx, S: SingleFn, L: ListFn) => void;
function buildWalkers(): Walker[] {
    const walkers = new Array<Walker>(TYPE_COUNT);
    for (let t = 0; t < TYPE_COUNT; t++) {
        let body = '';
        for (const f of FIELDS[t]) {
            const key = JSON.stringify(f.name);
            // The store is CONDITIONAL. Measured over a crashcat bundle: 731,315 `visitSingle` calls,
            // 2,534 of which actually replaced the node — 0.346%, so 99.65% of unconditional
            // write-backs stored the value already in the slot. A pointer store into an object field
            // costs a GC write barrier; a reference compare does not.
            //
            // oxc pays none of this — `walk_expression(&mut expr)` mutates through a reference, so
            // there is no write-back at all. JS cannot take a reference to a property slot, so eliding
            // the store when nothing changed is the closest aligned form.
            //
            // Benched at the MEASURED replacement rate (`benches/micro/writeback.bench.ts`): 8-12%
            // faster than the unconditional store across three runs, against a byte-identical control.
            body += f.list
                ? `{const a=node.data[${key}]; if(a!=null)L(a,ctx);}\n`
                : `{const c=node.data[${key}]; if(c!=null){const r=S(c,ctx); if(r!==c)node.data[${key}]=r;}}\n`;
        }
        // eslint-disable-next-line no-new-func -- schema-driven codegen; eval is mandated by the runtime.
        walkers[t] = new Function('node', 'ctx', 'S', 'L', body) as Walker;
    }
    return walkers;
}
const WALKERS = buildWalkers();

// --- the mutable enter/exit traversal ------------------------------------------------------------
const OP_NONE = 0;
const OP_REPLACE = 1;
const OP_MULTI = 2;
const OP_REMOVE = 3;

/** Per-visitor-set dispatch tables: for each node type, the hooks that ACTUALLY exist, in pass order.
 *
 *  `fireEnter`/`fireExit` used to ask every visitor about every node. Measured over a crashcat
 *  bundle: 1,541,801 `fireEnter` calls issued 11,701,596 visitor probes to make 608,648 hook calls —
 *  **94.8% of the probing hit nothing**, 7.6 probes per node to land 0.39 calls. Indexing by node
 *  type first turns that into one array load plus exactly the hooks that exist.
 *
 *  This is NOT the fused dispatch table that regressed the traversal 11.6% -> 16.2% earlier. That
 *  one collapsed 18 separate call sites into a single megamorphic call; here the call site is
 *  unchanged — `h(node, ctx)` was already one shared, already-megamorphic site inside the loop — and
 *  only the iterations that call nothing are removed. Measured 2.565x on hook selection over a real
 *  AST with the real 19-pass compress visitor set (`benches/micro/fire-hooks.paired.ts`).
 *
 *  Cached on the visitor ARRAY, which every driver holds for the life of the process (the compress
 *  loop reuses one `loop` array across every module and round), so the tables are built once. */
type HookTables = { enter: (Hook[] | null | undefined)[]; exit: (Hook[] | null | undefined)[] };
const HOOK_TABLES = new WeakMap<Visitor[], HookTables>();

function hookTablesFor(visitors: Visitor[]): HookTables {
    let t = HOOK_TABLES.get(visitors);
    if (t === undefined) {
        // `undefined` = not yet computed for that type, `null` = computed, no hooks. Filling LAZILY
        // matters because several drivers hand `traverse` a freshly-built array every call
        // (`loopPassesFor(mode)`, `[tsStrip]`), which misses this cache; an eager build would then
        // walk all 151 types x every visitor per module. Lazily, a miss costs only the types the
        // module actually contains, and the common arrays are memoised at their call sites anyway.
        t = { enter: new Array(TYPE_COUNT), exit: new Array(TYPE_COUNT) };
        HOOK_TABLES.set(visitors, t);
    }
    return t;
}

/** Hooks of one phase for one node type, computed on first sight and cached. Pass ORDER is
 *  load-bearing (the compress passes are deliberately ordered), so hooks append in visitor order. */
function hooksOf(visitors: Visitor[], table: (Hook[] | null | undefined)[], type: number, phase: 'enter' | 'exit'): Hook[] | null {
    let hooks: Hook[] | null = null;
    for (let i = 0; i < visitors.length; i++) {
        const tbl = visitors[i][phase];
        if (tbl === null) continue;
        const h = tbl[type];
        if (h !== null && h !== undefined) (hooks ??= []).push(h);
    }
    table[type] = hooks;
    return hooks;
}

class Ctx {
    semantic: Semantic;
    visitors: Visitor[];
    /**
     * Names already taken, for {@link generateUid}. Built LAZILY.
     *
     * This used to be `new Set(semantic.names.keys())` in the constructor — a copy of every name in the
     * program, allocated on EVERY `traverse` call, so once per compress round. It exists only for
     * `generateUid`, and no compress-loop pass mints a binding at all (`generateUid`, `createScope` and
     * `declareSymbol` have zero uses under `src/passes/compress/`), so the whole set was allocated and
     * thrown away every round. Allocation profiling put `Set`/`set` construction among the top sites.
     */
    private used: Set<string> | null = null;
    op = OP_NONE;
    /** Number of mutation-API calls made. Only read by the hook-conflict check; incrementing it is a
     *  field bump on a path that runs a few thousand times per bundle. */
    mutCount = 0;
    opNode: Node | null = null;
    opNodes: Node[] | null = null;
    /** The scope enclosing the node currently being visited (oxc `TraverseCtx.current_scope_id`).
     *  Tracked across the child-descent (see {@link descend}) so lowering passes can parent a
     *  synthesized scope (`createScope`) to the correct lexical scope. */
    currentScope = 0;
    /** Per-node-type hook lists for this visitor set — see {@link hookTablesFor}. */
    enterByType: (Hook[] | null | undefined)[];
    exitByType: (Hook[] | null | undefined)[];
    constructor(semantic: Semantic, visitors: Visitor[]) {
        this.semantic = semantic;
        this.visitors = visitors;
        const t = hookTablesFor(visitors);
        this.enterByType = t.enter;
        this.exitByType = t.exit;
    }
    /**
     * CHANGE SCOPES — which functions changed, and when (Closure's `ChangeTracker`).
     *
     * `stamp[scopeId]` holds the round number of the last change in that function OR ANYWHERE INSIDE
     * IT, so a driver can skip a function whose stamp is older than the last round it visited. Null
     * when the driver is not tracking (every traversal outside the compress fixed point).
     *
     * An INTEGER stamp, not a `Set`: benched at `benches/micro/change-report.bench.ts`, a `Set.add`
     * on every mutation costs 6-7x where an indexed store costs nothing, and the value being the
     * round number means last round's marks self-invalidate with no clearing pass.
     */
    stamp: number[] | null = null;
    /** The round the stamps are being written for. */
    round = 0;
    /** The innermost enclosing FUNCTION scope — Closure's `isChangeScopeRoot` unit. Measured coarser
     *  than `currentScope` and cheaper for it: on the crashcat chunk, round 2 has 456 dirty scopes
     *  but only 320 dirty functions, because block scopes collapse and mutations cluster. */
    currentFn = 0;
    /**
     * Set by any mutation (replace/remove/multi) — lets a driver run to a fixed point.
     *
     * An ACCESSOR so the stamp is written on EVERY path. The obvious alternative — hooking the
     * mutation methods (`replaceWith`, `remove`, ...) — was measured WRONG: a dozen-plus passes
     * assign `ctx.changed = true` directly after mutating a list in place (`inline.ts`,
     * `boolean-context.ts`, `drop-unused.ts`, ...), and instrumenting only the methods reported zero
     * dirty scopes in rounds where the loop was demonstrably still working. One hook, no way to
     * forget. Benched as free (`change-report.bench.ts`).
     */
    _changed = false;
    get changed(): boolean {
        return this._changed;
    }
    set changed(v: boolean) {
        if (v && this.stamp !== null) this.markChanged();
        this._changed = v;
    }
    /**
     * Stamp the enclosing function AND its ancestors.
     *
     * Ancestors matter because the stamp means "changed at or below here": to reach a dirty NESTED
     * function the walk must not skip the functions containing it. Early-exits as soon as an ancestor
     * already carries this round, so the common case is one or two writes.
     */
    private markChanged(): void {
        const stamp = this.stamp as number[];
        const round = this.round;
        const scopes = this.semantic.scopes;
        let s = this.currentFn;
        for (;;) {
            if (stamp[s] === round) return; // this function and everything above it is already marked
            stamp[s] = round;
            if (s === 0) return;
            // Walk to the next enclosing FUNCTION, not merely the next scope.
            let p = scopes[s].parent;
            while (p !== 0 && scopes[p].flags !== SCOPE.FUNCTION) p = scopes[p].parent;
            s = p;
        }
    }
    /**
     * Per-round reference deltas, or null when the driver is not maintaining counts incrementally.
     *
     * oxc's `PassChanges`: every subtree the traversal DROPS has its references subtracted and every
     * subtree it INSERTS has them added, so the fixed-point loop never re-derives counts from the tree.
     * We accumulate signed counts rather than oxc's `ReferenceId` bitset because a `ReferenceId` would
     * have to live on `Node`, and node shape is fixed for monomorphism — see
     * `llm/notes/incremental-refs-design.md`.
     *
     * `shorthand`/`exported` are STICKY sets and are only ever added to: dropping the last shorthand
     * read of a symbol leaves a stale entry, which merely blocks a substitution. That is the safe
     * direction; removing one could unblock a substitution that is not actually safe.
     */
    refDelta: Map<number, RefDelta> | null = null;
    /** Subtract every reference under `dropped` from the pending deltas. */
    dropRefs(dropped: Node): void {
        if (this.refDelta !== null) accumulate(this.refDelta, dropped, -1);
    }
    /**
     * A subtree is leaving the tree FOR GOOD: subtract its references AND retire the bindings it
     * declared. Use this instead of `dropRefs` wherever the removal is final.
     *
     * WHY IT IS A SEPARATE VERB. `dropRefs`/`addRefs` are TRANSACTIONAL — `inline` drops a use, tries a
     * substitution, and adds it straight back if refused; `replaceWith` drops the old subtree whose
     * bindings usually REAPPEAR inside the replacement. Folding eviction into `dropRefs` broke 33 tests
     * for exactly that reason. "Subtract these counts" and "this is gone" are different events and need
     * different names.
     *
     * Eviction is `scope = 0` — "owned by no lexical scope", deliberately still a VALID index because
     * an out-of-range sentinel crashed chunk-graph. Every consumer filters on the owning scope, so an
     * evicted symbol goes invisible without anyone needing a null check.
     */
    retire(dropped: Node): void {
        this.dropRefs(dropped);
        walk(dropped, (n) => {
            if (n.type === N.BindingIdentifier) {
                const sym = (n as { sym: number }).sym;
                const rec = sym > 0 ? this.semantic.symbols[sym] : undefined;
                if (rec !== undefined) rec.scope = 0;
            }
            return undefined;
        });
    }
    /** Add every reference under `added` to the pending deltas. */
    addRefs(added: Node): void {
        if (this.refDelta !== null) accumulate(this.refDelta, added, 1);
    }
    /** Replace the current node in its slot. */
    replaceWith(node: Node): void {
        this.mutCount++;
        this.op = OP_REPLACE;
        this.opNode = node;
        this.changed = true;
    }
    /** Replace the current statement with several (list slots only). */
    replaceWithMultiple(nodes: Node[]): void {
        this.mutCount++;
        this.op = OP_MULTI;
        this.opNodes = nodes;
        this.changed = true;
    }
    /** Remove the current statement (list slots only). */
    remove(): void {
        this.mutCount++;
        this.op = OP_REMOVE;
        this.changed = true;
    }
    /**
     * Splice a statement list the pass is holding directly, instead of `list.splice(...)`.
     *
     * `replaceWith` / `replaceWithMultiple` / `remove` act on the slot currently being visited, so a
     * pass that restructures a list it is holding (lifting a block's statements, folding a declaration
     * into the next statement, dropping a consumed trailing return) has always reached past them and
     * called `Array.prototype.splice` itself. That leaves the discarded subtrees invisible to the
     * traversal — fine while a full `analyze()` runs after every round and re-derives everything from
     * the tree, and NOT fine the moment reference facts are maintained incrementally, because an
     * unrecorded drop under-counts, and under-counting is the direction that deletes live bindings.
     *
     * Today this only marks `changed` and splices: behaviour is identical, and the point is that there
     * is now ONE place to record from. See `llm/notes/incremental-refs-design.md` phase B.
     */
    /**
     * Replace `list[index]` in place, recording the swap.
     *
     * The counterpart to {@link spliceStatements} for a pass that rewrites a statement rather than
     * removing one. Recording BOTH sides is what makes a MOVE safe without oxc's `take_in` dummy: when
     * the replacement reuses subtrees from the old statement, those references are subtracted by the
     * drop and added straight back by the insert, netting zero, while anything genuinely dropped or
     * genuinely introduced moves by exactly one.
     */
    replaceStatement(list: Node[], index: number, next: Node): void {
        const prev = list[index];
        if (prev !== undefined && prev !== null) this.dropRefs(prev);
        this.addRefs(next);
        list[index] = next;
        this.changed = true;
    }
    /**
     * Retire ONE symbol by id, when the pass has no subtree to hand over.
     *
     * `tsStrip` needs this: an erased type-only import specifier, or a `declare` form whose references
     * are being reclassified as unresolved globals, is identified by SYMBOL rather than by a node that
     * is leaving. Same eviction, same convention — `scope = 0`, "owned by no lexical scope", still a
     * VALID index because an out-of-range sentinel crashed chunk-graph.
     */
    retireSymbol(sym: number): void {
        retireSymbolIn(this.semantic, sym);
    }
    /**
     * Two symbols become one: `from`'s facts fold into `to`, and `from` is retired.
     *
     * A MERGE is not a removal — nothing leaves the tree, the nodes are simply rebound — so neither
     * `retire` nor `dropRefs` fits. `coalesceVariableNames` rewrites `node.sym` in place, which means
     * the traversal's automatic bookkeeping never fires; without this the survivor's counts came out
     * UNDER-stated by exactly the merged symbol's share and the merged symbol stayed live.
     */
    mergeSymbol(from: number, to: number): void {
        if (from === to || from <= 0 || to <= 0) return;
        const sem = this.semantic;
        const fRefs = sem.refs[from];
        if (fRefs !== undefined) {
            const tRefs = refFor(sem, to);
            tRefs.reads += fRefs.reads;
            tRefs.writes += fRefs.writes;
            sem.refs[from] = undefined; // absent again, not a zeroed record
        }
        const fUses = sem.uses[from];
        if (fUses !== undefined && fUses !== 0) {
            sem.uses[to] = (sem.uses[to] ?? 0) + fUses;
            sem.uses[from] = 0;
        }
        if (sem.shorthand.has(from)) {
            sem.shorthand.add(to);
            sem.shorthand.delete(from);
        }
        if (sem.exported.has(from)) {
            sem.exported.add(to);
            sem.exported.delete(from);
        }
        // The merged declaration is gone (or became a plain assignment), so its recorded init no
        // longer describes a declarator.
        sem.symbolInit.delete(from);
        this.retireSymbol(from);
    }
    spliceStatements(list: Node[], start: number, deleteCount: number, ...insert: Node[]): void {
        if (deleteCount === 0 && insert.length === 0) return;
        if (this.refDelta !== null) {
            for (let i = 0; i < deleteCount; i++) {
                const dropped = list[start + i];
                if (dropped !== null && dropped !== undefined) this.dropRefs(dropped);
            }
            for (const ins of insert) this.addRefs(ins);
        }
        list.splice(start, deleteCount, ...insert);
        this.changed = true;
    }
    /** Mint a unique binding name `_base`/`_base2`/… (Babel/oxc), reserving it against the module's
     *  name set so later deconfliction never re-issues it. */
    generateUid(base: string): string {
        const b = base.replace(/^_+/, '').replace(/[0-9]+$/, '') || 'ref';
        let name = `_${b}`;
        const used = (this.used ??= new Set(this.semantic.names.keys()));
        for (let i = 2; used.has(name); i++) name = `_${b}${i}`;
        used.add(name);
        this.semantic.names.set(name, this.semantic.names.size + 1);
        return name;
    }
}

export type TransformCtx = Ctx;

/** Signed per-symbol reference movement for one round. */
export type RefDelta = { reads: number; writes: number; uses: number };

/** Fold a round's {@link RefDelta} into a Semantic's `refs`/`uses`.
 *
 *  The counterpart to `dropRefs`/`addRefs`: those RECORD movement while a traversal mutates, this
 *  APPLIES it once the traversal is done. Shared by the compress fixed point and the TS/JSX
 *  lowering traversals so both maintain reference counts the same way instead of each re-deriving
 *  them with a full `analyze()`. */
export function applyRefDelta(semantic: Semantic, delta: Map<number, RefDelta>): void {
    for (const [sym, d] of delta) {
        if (d.reads !== 0 || d.writes !== 0) {
            const c = refFor(semantic, sym);
            c.reads += d.reads;
            c.writes += d.writes;
        }
        if (d.uses !== 0) semantic.uses[sym] = (semantic.uses[sym] ?? 0) + d.uses;
    }
}

function accumulate(into: Map<number, RefDelta>, root: Node, sign: number): void {
    emitRefFacts(root, (sym, flags) => {
        let d = into.get(sym);
        if (d === undefined) {
            d = { reads: 0, writes: 0, uses: 0 };
            into.set(sym, d);
        }
        if ((flags & REF.READ) !== 0) d.reads += sign;
        if ((flags & REF.WRITE) !== 0) d.writes += sign;
        d.uses += sign;
    });
}

/** Verification-only: catch two visitors mutating the SAME node in one phase.
 *
 *  `replaceWith`/`remove`/`replaceWithMultiple` only record an intent on `ctx.op`; the traversal
 *  consumes it AFTER every hook for the node has run. So if two visitors both act on one node, the
 *  second overwrites the first and the first's rewrite is silently lost. oxc cannot hit this because
 *  its sub-transforms mutate in place (`*stmt = new_stmt`), so the next one sees the updated node.
 *
 *  Fusing the TS lowering and strip passes into one traversal relies on their predicates being exact
 *  complements on the three node types they share (`TSEnumDeclaration` / `TSModuleDeclaration` /
 *  `ExportNamedDeclaration`: value form vs `declare` form). That is a property of the PREDICATES, not
 *  of the structure, so it is asserted rather than assumed — and the same hazard exists, unchecked,
 *  across the 19 fused compress passes.
 *
 *  `LOWER_SEMANTIC_MODE=verify pnpm test` turns it on. */
const HOOK_CONFLICT_CHECK = process.env.LOWER_SEMANTIC_MODE === 'verify' || process.env.TRAVERSE_VERIFY === '1';

function conflict(node: Node, phase: string, ctx: Ctx, first: number, second: number): never {
    const name = Object.keys(N).find((k) => N[k as keyof typeof N] === node.type) ?? String(node.type);
    // Hook index maps to the visitor that contributed it, in the same order `hooksOf` appended them.
    const owners = ctx.visitors.filter((v) => (phase === 'enter' ? v.enter : v.exit)?.[node.type] != null).map((v) => v.name);
    throw new Error(
        `two visitors mutated the same ${name} @${node.start} in one ${phase} phase — ` +
            `'${owners[first] ?? first}' then '${owners[second] ?? second}'. The second silently ` +
            `discards the first's rewrite, because ctx.op is consumed only after ALL hooks have run.`,
    );
}

function fireEnter(node: Node, ctx: Ctx): void {
    const t = node.type;
    const hooks = ctx.enterByType[t] ?? hooksOf(ctx.visitors, ctx.enterByType, t, 'enter');
    if (hooks === null) return;
    if (HOOK_CONFLICT_CHECK) {
        let mutated = -1;
        for (let i = 0; i < hooks.length; i++) {
            const before = ctx.mutCount;
            hooks[i](node, ctx);
            if (ctx.mutCount !== before) {
                if (mutated >= 0) conflict(node, 'enter', ctx, mutated, i);
                mutated = i;
            }
        }
        return;
    }
    for (let i = 0; i < hooks.length; i++) hooks[i](node, ctx);
}
function fireExit(node: Node, ctx: Ctx): void {
    const t = node.type;
    const hooks = ctx.exitByType[t] ?? hooksOf(ctx.visitors, ctx.exitByType, t, 'exit');
    if (hooks === null) return;
    if (HOOK_CONFLICT_CHECK) {
        let mutated = -1;
        for (let i = 0; i < hooks.length; i++) {
            const before = ctx.mutCount;
            hooks[i](node, ctx);
            if (ctx.mutCount !== before) {
                if (mutated >= 0) conflict(node, 'exit', ctx, mutated, i);
                mutated = i;
            }
        }
        return;
    }
    for (let i = 0; i < hooks.length; i++) hooks[i](node, ctx);
}

/** Walk `node`'s children, tracking `ctx.currentScope` across the descent: if `node` owns a scope
 *  (`nodeScope`), children see it as their enclosing scope; restored on the way out. */
function descend(node: Node, ctx: Ctx): void {
    // The scope a node owns is carried ON THE NODE (`data.scopeId`, oxc's model) rather than looked
    // up in a `Map<Node, number>`. That map was consulted for every node walked and found nothing
    // 98.14% of the time, since only ~12 of ~151 node types can own a scope; the field is simply
    // absent on the rest.
    // 0 means "owns no scope": the field is initialised to 0 at construction and `analyze` overwrites
    // it, and scope 0 is the table's root sentinel which is never owned by a node. A node type that
    // cannot own a scope has no field at all, which `?? 0` folds into the same case.
    const s = (node.data as { scopeId?: number } | null)?.scopeId ?? 0;
    if (s === 0) {
        WALKERS[node.type](node, ctx, visitSingle, visitList);
        return;
    }
    const prev = ctx.currentScope;
    ctx.currentScope = s;
    // A FUNCTION scope becomes the enclosing change scope; block/catch/for scopes leave it alone, so
    // a mutation inside a block marks the whole function. Read off the scope table rather than
    // matching node types — `descend` is already in the branch that owns a scope.
    const prevFn = ctx.currentFn;
    if (ctx.stamp !== null && ctx.semantic.scopes[s].flags === SCOPE.FUNCTION) ctx.currentFn = s;
    WALKERS[node.type](node, ctx, visitSingle, visitList);
    ctx.currentScope = prev;
    ctx.currentFn = prevFn;
}

/** Visit a single-child slot; returns the (possibly replaced) node to write back. */
function visitSingle(node: Node, ctx: Ctx): Node {
    ctx.op = OP_NONE;
    fireEnter(node, ctx);
    let cur = node;
    if (ctx.op === OP_REPLACE) {
        ctx.dropRefs(cur);
        cur = ctx.opNode as Node;
        ctx.addRefs(cur);
        ctx.op = OP_NONE;
    } else if (ctx.op !== OP_NONE) throw new Error('remove()/replaceWithMultiple() not allowed in a single-child slot');
    descend(cur, ctx);
    ctx.op = OP_NONE;
    fireExit(cur, ctx);
    if (ctx.op === OP_REPLACE) {
        // `cur` here is the CURRENT subtree — any child replaced during `descend` already recorded its
        // own swap, so dropping `cur` subtracts exactly what is live in it right now.
        ctx.dropRefs(cur);
        cur = ctx.opNode as Node;
        ctx.addRefs(cur);
        ctx.op = OP_NONE;
    } else if (ctx.op !== OP_NONE) throw new Error('remove()/replaceWithMultiple() not allowed in a single-child slot');
    return cur;
}

/** Visit a list slot in place, applying replace/remove/replaceWithMultiple per element. Elements
 *  produced by replaceWithMultiple are not re-visited (they came from the hook). */
function visitList(list: (Node | null)[], ctx: Ctx): void {
    if (list.length === 0) return; // nothing to visit (also skips the shared frozen EMPTY_LIST)
    // COPY-ON-WRITE. The overwhelming majority of statement lists come through a round untouched, and
    // building a parallel array for every one of them — on every list, on every round — was pure
    // garbage: filled, compared, discarded. `out` is now allocated only when an element actually moves,
    // seeded with the prefix already passed over (which cannot contain a change, or it would have
    // allocated then). An unchanged list allocates nothing at all.
    // NO CLOSURES here. The first cut of this used `fork`/`push` helpers and measured WORSE than the
    // unconditional array it replaced (traverse machinery 11.6% -> 16.2% of a bundle profile): two
    // closure allocations per list per round cost more than the one array they were saving.
    let out: (Node | null)[] = list; // unused until `forked`; never null, so no narrowing games
    let forked = false;
    for (let idx = 0; idx < list.length; idx++) {
        const el = list[idx];
        if (el === null) {
            if (forked) out.push(null);
            continue;
        }
        ctx.op = OP_NONE;
        fireEnter(el, ctx);
        if (ctx.op === OP_REMOVE) {
            // RETIRE, not just drop: `remove()` is the one unambiguous "gone for good" event in the
            // traversal, so any pass that calls it now gets its bindings evicted for free. `OP_MULTI`
            // and `spliceStatements` both RE-INSERT (blockFlatten splices a block out and its contents
            // back in, bindings included), so they keep the transactional `dropRefs`.
            ctx.retire(el);
            if (!forked) {
                out = list.slice(0, idx);
                forked = true;
            }
            ctx.op = OP_NONE;
            continue;
        }
        if (ctx.op === OP_MULTI) {
            ctx.dropRefs(el);
            if (!forked) {
                out = list.slice(0, idx);
                forked = true;
            }
            for (const m of ctx.opNodes as Node[]) {
                ctx.addRefs(m);
                out.push(m);
            }
            ctx.op = OP_NONE;
            continue;
        }
        let cur = el;
        if (ctx.op === OP_REPLACE) {
            ctx.dropRefs(cur);
            cur = ctx.opNode as Node;
            ctx.addRefs(cur);
            if (!forked) {
                out = list.slice(0, idx);
                forked = true;
            }
            ctx.op = OP_NONE;
        }
        descend(cur, ctx);
        ctx.op = OP_NONE;
        fireExit(cur, ctx);
        if (ctx.op === OP_REMOVE) {
            ctx.dropRefs(cur);
            if (!forked) {
                out = list.slice(0, idx);
                forked = true;
            }
            ctx.op = OP_NONE;
            continue;
        }
        if (ctx.op === OP_MULTI) {
            ctx.dropRefs(cur);
            if (!forked) {
                out = list.slice(0, idx);
                forked = true;
            }
            for (const m of ctx.opNodes as Node[]) {
                ctx.addRefs(m);
                out.push(m);
            }
            ctx.op = OP_NONE;
            continue;
        }
        if (ctx.op === OP_REPLACE) {
            ctx.dropRefs(cur);
            cur = ctx.opNode as Node;
            ctx.addRefs(cur);
            if (!forked) {
                out = list.slice(0, idx);
                forked = true;
            }
            ctx.op = OP_NONE;
        }
        if (forked) out.push(cur);
    }
    if (!forked) return; // list untouched — leave it (may be a shared/frozen array)
    const built = out;
    list.length = 0;
    for (const x of built) list.push(x);
}

/** Run the ordered `visitors` over `program` in one fused mutable traversal (oxc `traverse_mut`).
 *  Returns whether any visitor mutated the tree (replace/remove/multi) — a compress driver loops on
 *  this to reach a fixed point. */
export function traverse(
    program: Node,
    semantic: Semantic,
    visitors: Visitor[],
    refDelta: Map<number, RefDelta> | null = null,
    /** Change-scope stamps to write, and the round to write. Only the compress fixed point passes
     *  these; every other traversal leaves them null and pays nothing. */
    stamps: { stamp: number[]; round: number } | null = null,
): boolean {
    const ctx = new Ctx(semantic, visitors);
    ctx.refDelta = refDelta;
    if (stamps !== null) {
        ctx.stamp = stamps.stamp;
        ctx.round = stamps.round;
    }
    ctx.op = OP_NONE;
    fireEnter(program, ctx);
    ctx.op = OP_NONE;
    descend(program, ctx);
    ctx.op = OP_NONE;
    fireExit(program, ctx);
    // Any mutation invalidates `analyze`'s recorded reference/declaration scopes: a rewrite can move a
    // reference into another scope or delete it outright. Counts survive (compress maintains them via
    // `applyRefDelta`), but scopes are not maintained, so consumers must re-derive them. Cleared here
    // rather than at each mutation site so no pass can forget.
    if (ctx.changed) semantic.refsCurrent = false;
    return ctx.changed;
}
