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
        cur = ctx.opNode as Node;
        ctx.op = OP_NONE;
    } else if (ctx.op !== OP_NONE) throw new Error('remove()/replaceWithMultiple() not allowed in a single-child slot');
    descend(cur, ctx);
    ctx.op = OP_NONE;
    fireExit(cur, ctx);
    if (ctx.op === OP_REPLACE) {
        cur = ctx.opNode as Node;
        ctx.op = OP_NONE;
    } else if (ctx.op !== OP_NONE) throw new Error('remove()/replaceWithMultiple() not allowed in a single-child slot');
    return cur;
}

/** Visit a list slot in place, applying replace/remove/replaceWithMultiple per element. Elements
 *  produced by replaceWithMultiple are not re-visited (they came from the hook). */
function visitList(list: (Node | null)[], ctx: Ctx): void {
    if (list.length === 0) return; // nothing to visit (also skips the shared frozen EMPTY_LIST)
    const out: (Node | null)[] = [];
    let changed = false; // only rebuild the array if an element was replaced/removed/spliced
    for (const el of list) {
        if (el === null) {
            out.push(null);
            continue;
        }
        ctx.op = OP_NONE;
        fireEnter(el, ctx);
        if (ctx.op === OP_REMOVE) {
            ctx.op = OP_NONE;
            changed = true;
            continue;
        }
        if (ctx.op === OP_MULTI) {
            for (const m of ctx.opNodes as Node[]) out.push(m);
            ctx.op = OP_NONE;
            changed = true;
            continue;
        }
        let cur = el;
        if (ctx.op === OP_REPLACE) {
            cur = ctx.opNode as Node;
            ctx.op = OP_NONE;
            changed = true;
        }
        descend(cur, ctx);
        ctx.op = OP_NONE;
        fireExit(cur, ctx);
        if (ctx.op === OP_REMOVE) {
            ctx.op = OP_NONE;
            changed = true;
            continue;
        }
        if (ctx.op === OP_MULTI) {
            for (const m of ctx.opNodes as Node[]) out.push(m);
            ctx.op = OP_NONE;
            changed = true;
            continue;
        }
        if (ctx.op === OP_REPLACE) {
            cur = ctx.opNode as Node;
            ctx.op = OP_NONE;
            changed = true;
        }
        out.push(cur);
    }
    if (!changed) return; // list untouched — leave it (may be a shared/frozen array)
    list.length = 0;
    for (const x of out) list.push(x);
}

/** Run the ordered `visitors` over `program` in one fused mutable traversal (oxc `traverse_mut`).
 *  Returns whether any visitor mutated the tree (replace/remove/multi) — a compress driver loops on
 *  this to reach a fixed point. */
export function traverse(program: Node, semantic: Semantic, visitors: Visitor[]): boolean {
    const ctx = new Ctx(semantic, visitors);
    ctx.op = OP_NONE;
    fireEnter(program, ctx);
    ctx.op = OP_NONE;
    descend(program, ctx);
    ctx.op = OP_NONE;
    fireExit(program, ctx);
    return ctx.changed;
}
