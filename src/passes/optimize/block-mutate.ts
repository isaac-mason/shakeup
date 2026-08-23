// block-mutate — turn a callee body into a STATEMENT that computes the same result, so a
// multi-statement body (including one containing `return`s) can be spliced in place of a call.
//
// Port of compilecat `passes/block_mutate.rs`, itself a port of Closure's `FunctionToBlockMutator`.
// This is the piece that makes general BLOCK inlining possible; DIRECT inlining handles only a body
// that is a single `return <expr>`. Porting the inliner WITHOUT this is a latent miscompile, which is
// why it lands first.
//
//   function f(a) { if (a) return 1; g(); return 2; }   at a call `x = f(y)`
//     →  L: { const a = y; if (a) { _r = 1; break L; } g(); _r = 2; }
//
// THE SHAPES:
//   • Every `return X` reachable without crossing into a NESTED function becomes
//     `{ result = X; break LABEL; }` — always a BLOCK, so it is valid both in a statement list and in
//     a bare clause slot (`if (c) return x`) without any array splicing.
//   • A TRAILING `return X` (the body's last statement) instead falls through as `result = X;` — no
//     break, and if it was the only return, no label either.
//   • A body that can fall off the end assigns `result = void 0` so the caller reads `undefined`, not
//     a stale value.
//   • `needsResult === false` (a call in statement position, whose value is discarded) drops the
//     assignment and keeps the returned expression only when it has side effects.
//
// PARAMS: each param passed in gets a `const p = arg;` prologue binding — `let` when the body REBINDS
// it (`p = …`, `p++`, a destructuring target). A member write (`p.x = …`, `p[0] = …`) mutates the
// pointed-at object rather than the binding, so it does NOT force `let`. Which params are passed here
// is the caller's decision: it substitutes simple non-reassigned arguments directly into the body and
// sends only the rest (reassigned params, and side-effecting args that must be evaluated exactly once).
// α-renaming, when an argument references a param's name, is likewise the caller's job.
import { N, type Node, node, walk } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { VAR_KIND } from '../../parser/create.ts';

/** Synthetic span for generated nodes (shakeup's convention for compiler-generated code). */
const S = 0;

const ref = (name: string): Node => node(N.IdentifierReference, S, S, name, null);
const bindingId = (name: string): Node => node(N.BindingIdentifier, S, S, name, null);
const labelId = (name: string): Node => node(N.LabelIdentifier, S, S, name, null);

/** The returned expression of a `return`, or `null` for a bare `return;`. */
const argOf = (ret: Node): Node | null => (ret.data as { argument: Node | null }).argument;

/** `void 0` — the `undefined` value in expression position. */
const voidZero = (): Node =>
    create.UnaryExpression(S, S, create.OP.VOID, node(N.NumericLiteral, S, S, '0', null));

/** `<name> = <value>;` */
const assignStmt = (name: string, value: Node): Node =>
    create.ExpressionStatement(S, S, 0, create.AssignmentExpression(S, S, '=', ref(name), value));

/** Whether `target` REBINDS `name`. A member/element write mutates the object the binding points at,
 *  not the binding itself, so it does not count (compilecat keeps such params `const`). */
function targetsName(target: Node, name: string): boolean {
    if (target.type === N.StaticMemberExpression || target.type === N.ComputedMemberExpression) return false;
    let hit = false;
    walk(target, (n) => {
        if (hit) return false;
        if ((n.type === N.IdentifierReference || n.type === N.BindingIdentifier) && n.name === name) hit = true;
        return undefined;
    });
    return hit;
}

/** Whether `name` is rebound anywhere in `stmts` — INCLUDING inside nested functions, since a closure
 *  can reassign a captured parameter. */
function isReassigned(stmts: readonly Node[], name: string): boolean {
    let found = false;
    for (const s of stmts) {
        walk(s, (n) => {
            if (found) return false;
            if (n.type === N.AssignmentExpression) {
                if (targetsName((n.data as { left: Node }).left, name)) found = true;
            } else if (n.type === N.UpdateExpression) {
                if (targetsName((n.data as { argument: Node }).argument, name)) found = true;
            }
            return undefined;
        });
        if (found) return true;
    }
    return false;
}

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** Count `return`s reachable without crossing into a nested function. */
function countShallowReturns(stmts: readonly Node[]): number {
    let count = 0;
    for (const s of stmts) {
        walk(s, (n) => {
            if (n !== s && isFn(n)) return false; // a nested function's returns are its own
            if (n.type === N.ReturnStatement) count++;
            return undefined;
        });
    }
    return count;
}

export interface BlockMutateInput {
    /** Callee body statements — CLONED by the caller; mutated in place here. */
    bodyStmts: Node[];
    /** Param names to bind in the prologue; `args[i]` pairs with `params[i]`. */
    params: readonly string[];
    /** Cloned argument expressions (a missing one binds `void 0`). */
    args: readonly Node[];
    label: string;
    resultName: string;
    /** False for a call in statement position: returns become a bare `break LABEL`. */
    needsResult: boolean;
}

export interface BlockMutateOutput {
    /** A LabeledStatement when interior returns forced `break`s, else a plain BlockStatement. */
    block: Node;
    /** Whether `result` is written on at least one path — lets the caller skip an unused temp. */
    hasResultWrite: boolean;
}

/** Rewrite every shallow `return` into `{ result = X; break LABEL; }`, in place. */
function rewriteReturns(stmts: Node[], label: string, resultName: string, needsResult: boolean): boolean {
    let wrote = false;
    const returnBlock = (arg: Node | null): Node => {
        const inner: Node[] = [];
        if (needsResult) {
            inner.push(assignStmt(resultName, arg ?? voidZero()));
            wrote = true;
        } else if (arg !== null && !isInert(arg)) {
            inner.push(create.ExpressionStatement(S, S, 0, arg));
        }
        inner.push(create.BreakStatement(S, S, 0, labelId(label)));
        return create.BlockStatement(S, S, 0, inner);
    };
    /** Replace every `return` in `holder`'s subtree, wherever it sits — a statement-list slot or a
     *  bare clause slot (`if (c) return x`). Scanning the data fields generically covers every
     *  statement shape that can hold one (if/loops/try/switch/labeled) without enumerating them. */
    const rewriteIn = (holder: Node): void => {
        walk(holder, (n) => {
            if (n !== holder && isFn(n)) return false; // a nested function's returns are its own
            const d = n.data as Record<string, unknown> | null;
            if (d === null) return undefined;
            for (const key of Object.keys(d)) {
                const v = d[key];
                if (Array.isArray(v)) {
                    const list = v as (Node | null)[];
                    for (let i = 0; i < list.length; i++) {
                        const c = list[i];
                        if (c !== null && c.type === N.ReturnStatement) list[i] = returnBlock(argOf(c));
                    }
                } else if (v !== null && typeof v === 'object' && (v as Node).type === N.ReturnStatement) {
                    (d as Record<string, Node>)[key] = returnBlock(argOf(v as Node));
                }
            }
            return undefined;
        });
    };
    for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        if (s.type === N.ReturnStatement) {
            stmts[i] = returnBlock(argOf(s));
            continue;
        }
        rewriteIn(s);
    }
    return wrote;
}

/** An expression with no side effects, so dropping it in `needsResult === false` mode is safe. */
const isInert = (n: Node): boolean =>
    n.type === N.IdentifierReference ||
    n.type === N.NumericLiteral ||
    n.type === N.StringLiteral ||
    n.type === N.BooleanLiteral ||
    n.type === N.NullLiteral ||
    n.type === N.ThisExpression;

export function mutateForBlockInline(input: BlockMutateInput): BlockMutateOutput {
    const { bodyStmts, params, args, label, resultName, needsResult } = input;

    // ── Prologue: bind each passed param to its argument ──
    const prologue: Node[] = [];
    for (let i = 0; i < params.length; i++) {
        const name = params[i];
        const arg = args[i] ?? voidZero();
        const kind = isReassigned(bodyStmts, name) ? VAR_KIND.LET : VAR_KIND.CONST;
        const declarator = create.VariableDeclarator(S, S, 0, bindingId(name), null, arg);
        prologue.push(create.VariableDeclaration(S, S, kind, [declarator]));
    }

    let hasResultWrite = false;
    const last = bodyStmts[bodyStmts.length - 1];
    const hasReturnAtExit = last !== undefined && last.type === N.ReturnStatement;
    const interiorReturns = countShallowReturns(bodyStmts) - (hasReturnAtExit ? 1 : 0);

    // ── Trailing `return X;` → `result = X;` (falls through; no break) ──
    if (hasReturnAtExit) {
        const ret = bodyStmts.pop() as Node;
        const arg = argOf(ret);
        if (needsResult) {
            bodyStmts.push(assignStmt(resultName, arg ?? voidZero()));
            hasResultWrite = true;
        } else if (arg !== null && !isInert(arg)) {
            bodyStmts.push(create.ExpressionStatement(S, S, 0, arg));
        }
    } else if (needsResult) {
        // Falls off the end → the caller must read `undefined`, not a stale value.
        bodyStmts.push(assignStmt(resultName, voidZero()));
        hasResultWrite = true;
    }

    // ── Interior returns → `result = X; break LABEL;`, wrapped in a labeled block ──
    if (interiorReturns > 0) {
        if (rewriteReturns(bodyStmts, label, resultName, needsResult)) hasResultWrite = true;
        const block = create.BlockStatement(S, S, 0, [...prologue, ...bodyStmts]);
        return { block: create.LabeledStatement(S, S, 0, labelId(label), block), hasResultWrite };
    }
    return { block: create.BlockStatement(S, S, 0, [...prologue, ...bodyStmts]), hasResultWrite };
}
