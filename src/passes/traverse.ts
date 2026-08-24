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
import type { Semantic } from '../analysis/semantic.ts';
import { CHILD_FIELDS, N, type Node, TYPE_COUNT } from '../ast.ts';

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
            body += f.list
                ? `{const a=node.data[${key}]; if(a!=null)L(a,ctx);}\n`
                : `{const c=node.data[${key}]; if(c!=null)node.data[${key}]=S(c,ctx);}\n`;
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

class Ctx {
    semantic: Semantic;
    visitors: Visitor[];
    private used: Set<string>;
    op = OP_NONE;
    opNode: Node | null = null;
    opNodes: Node[] | null = null;
    /** The scope enclosing the node currently being visited (oxc `TraverseCtx.current_scope_id`).
     *  Tracked across the child-descent (see {@link descend}) so lowering passes can parent a
     *  synthesized scope (`createScope`) to the correct lexical scope. */
    currentScope = 0;
    constructor(semantic: Semantic, visitors: Visitor[]) {
        this.semantic = semantic;
        this.visitors = visitors;
        this.used = new Set(semantic.names.keys());
    }
    /** Set by any mutation (replace/remove/multi) — lets a driver run to a fixed point. */
    changed = false;
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
    /** Add every reference under `added` to the pending deltas. */
    addRefs(added: Node): void {
        if (this.refDelta !== null) accumulate(this.refDelta, added, 1);
    }
    /** Replace the current node in its slot. */
    replaceWith(node: Node): void {
        this.op = OP_REPLACE;
        this.opNode = node;
        this.changed = true;
    }
    /** Replace the current statement with several (list slots only). */
    replaceWithMultiple(nodes: Node[]): void {
        this.op = OP_MULTI;
        this.opNodes = nodes;
        this.changed = true;
    }
    /** Remove the current statement (list slots only). */
    remove(): void {
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
        for (let i = 2; this.used.has(name); i++) name = `_${b}${i}`;
        this.used.add(name);
        this.semantic.names.set(name, this.semantic.names.size + 1);
        return name;
    }
}

export type TransformCtx = Ctx;

/** Signed per-symbol reference movement for one round. */
export type RefDelta = { reads: number; writes: number; uses: number };

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

function fireEnter(node: Node, ctx: Ctx): void {
    const vs = ctx.visitors;
    for (let i = 0; i < vs.length; i++) {
        const e = vs[i].enter;
        if (e !== null) {
            const h = e[node.type];
            if (h !== null && h !== undefined) h(node, ctx);
        }
    }
}
function fireExit(node: Node, ctx: Ctx): void {
    const vs = ctx.visitors;
    for (let i = 0; i < vs.length; i++) {
        const x = vs[i].exit;
        if (x !== null) {
            const h = x[node.type];
            if (h !== null && h !== undefined) h(node, ctx);
        }
    }
}

/** Walk `node`'s children, tracking `ctx.currentScope` across the descent: if `node` owns a scope
 *  (`nodeScope`), children see it as their enclosing scope; restored on the way out. */
function descend(node: Node, ctx: Ctx): void {
    const s = ctx.semantic.nodeScope.get(node);
    if (s === undefined) {
        WALKERS[node.type](node, ctx, visitSingle, visitList);
        return;
    }
    const prev = ctx.currentScope;
    ctx.currentScope = s;
    WALKERS[node.type](node, ctx, visitSingle, visitList);
    ctx.currentScope = prev;
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
            ctx.dropRefs(el);
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
): boolean {
    const ctx = new Ctx(semantic, visitors);
    ctx.refDelta = refDelta;
    ctx.op = OP_NONE;
    fireEnter(program, ctx);
    ctx.op = OP_NONE;
    descend(program, ctx);
    ctx.op = OP_NONE;
    fireExit(program, ctx);
    return ctx.changed;
}
