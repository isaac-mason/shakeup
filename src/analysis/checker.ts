import { N, type Node, walkChildren } from '../ast/index.ts';
import { isStrictScope, type Semantic } from './semantic.ts';

/** One early error, in the parser's diagnostic shape so both sinks read alike. */
export type CheckError = { pos: number; msg: string };

/**
 * Early errors that need the SEMANTIC MODEL — the rules a parser cannot decide because they depend on
 * accumulated strict mode, on scopes, or on symbols. oxc keeps these in a separate crate for exactly
 * that reason (`oxc_semantic/src/checker/`, 41 rules); its parser has no strict bit at all.
 *
 * **A separate PASS, where oxc fuses this into the semantic build.** oxc calls `check(kind, ctx)` from
 * `SemanticBuilder::leave_node` and pays nothing for it, and its own doc comment says why: both are
 * `#[inline(always)]`, so each `visit_*` site passes a statically known `AstKind` and the compiler
 * constant-folds the match, deleting every non-matching arm. There is no equivalent in JS — the match
 * would be a live switch on every node of every `analyze` call, and `analyze` has 25 call sites, most
 * of them mid-pass rebuilds that never want checking. Running separately costs ZERO when it is off and
 * one extra walk when it is on, which happens once per source module.
 *
 * Iterative, not recursive: the same reason `walk` is (a 300-deep program used to exhaust the stack).
 * Scope is carried down rather than looked up, because only scope-OWNING nodes record a `scopeId`.
 */
export function checkSyntax(sem: Semantic, program: Node): CheckError[] {
    const errors: CheckError[] = [];
    const stack: Node[] = [program];
    const scopes: number[] = [ownScopeOf(program)];
    while (stack.length > 0) {
        const node = stack.pop() as Node;
        const inherited = scopes.pop() as number;
        const own = ownScopeOf(node);
        const scope = own === 0 ? inherited : own;
        checkNode(sem, node, scope, errors);
        walkChildren(node, (child) => {
            stack.push(child);
            scopes.push(scope);
        });
    }
    return errors;
}

/** The scope a node OWNS, or 0 for one that owns none.
 *
 *  The field is declared on several node types that do not always get a scope — a function body's
 *  `BlockStatement` is the common case, since the function scope already covers it — and it defaults
 *  to `0`, which is the table's NULL SENTINEL rather than a real scope. Treating that 0 as a scope
 *  silently reparents every node under it to the sentinel, whose flags are empty: strictness looked
 *  off inside every function body. */
const ownScopeOf = (node: Node): number => (node.data as { scopeId?: number } | null)?.scopeId ?? 0;

function checkNode(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
    switch (node.type) {
        case N.UnaryExpression:
            checkUnaryExpression(sem, node, scope, errors);
            return;
        case N.NumericLiteral:
            checkNumericLiteral(sem, node, scope, errors);
            return;
        default:
            return;
    }
}

/** oxc's `check_unary_expression` (`checker/javascript.rs:1278`). */
function checkUnaryExpression(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
    const d = node.data as { operator: string; argument: Node };
    if (d.operator !== 'delete') return;
    const arg = unwrap(d.argument);
    // `delete obj.#x` is an error in EVERY mode — the private field is not a configurable property.
    if (arg.type === N.PrivateFieldExpression) {
        errors.push({ pos: arg.start, msg: "The operand of a 'delete' operator cannot be a private identifier." });
        return;
    }
    // Deleting a bare binding is an error only in strict code, which is why this rule cannot live in
    // the parser: `delete x` is legal sloppy and an error under a `"use strict"` three scopes up.
    if (arg.type === N.IdentifierReference && isStrictScope(sem, scope)) {
        errors.push({ pos: arg.start, msg: 'Delete of an unqualified identifier in strict mode.' });
    }
}

/** Parentheses are not in the AST, but a `ChainExpression` wrapper is — `delete (a?.b)` still targets
 *  the member expression. oxc reaches the same place with `get_inner_expression`. */
function unwrap(node: Node): Node {
    let e = node;
    while (e.type === N.ChainExpression) e = (e.data as { expression: Node }).expression;
    return e;
}

/** oxc's `check_number_literal` (`checker/javascript.rs:392`). Both forms are legal sloppy and errors
 *  in strict code, and they carry DIFFERENT messages: `010` is a legacy octal, `08` is a decimal that
 *  merely starts with a zero. The raw text decides — `0o10`, `0x1f` and `0` are all fine. */
function checkNumericLiteral(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
    const raw = node.name;
    if (raw.length < 2 || raw.charCodeAt(0) !== 48) return;
    const second = raw.charCodeAt(1);
    if (second < 48 || second > 57) return; // `0o`, `0x`, `0b`, `0.5`, `0n`
    if (!isStrictScope(sem, scope)) return;
    let octal = true;
    for (let i = 1; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 55) {
            octal = false;
            break;
        }
    }
    errors.push({
        pos: node.start,
        msg: octal
            ? "'0'-prefixed octal literals and octal escape sequences are deprecated"
            : 'Decimals with leading zeros are not allowed in strict mode',
    });
}
