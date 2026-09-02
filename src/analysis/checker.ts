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
        case N.BindingIdentifier:
            checkReservedWord(sem, node, scope, errors);
            checkBindingIdentifier(sem, node, scope, errors);
            return;
        case N.IdentifierReference:
        case N.LabelIdentifier:
            checkReservedWord(sem, node, scope, errors);
            return;
        case N.AssignmentExpression:
            checkAssignTarget(sem, (node.data as { left: Node }).left, scope, errors);
            return;
        case N.UpdateExpression:
            checkAssignTarget(sem, (node.data as { argument: Node }).argument, scope, errors);
            return;
        case N.FunctionDeclaration:
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
            checkUseStrictDirective(node, errors);
            return;
        default:
            return;
    }
}

/** Reserved only in strict code — `oxc`'s `check_identifier` (`checker/javascript.rs:152`). Outside
 *  strict mode every one of these is an ordinary identifier, which is why the rule cannot be a
 *  keyword table in the lexer. `await` and `yield` in a MODULE or a generator are the parser's job and
 *  are already handled there; this is the strict-mode half. */
const STRICT_RESERVED = new Set([
    'implements',
    'interface',
    'let',
    'package',
    'private',
    'protected',
    'public',
    'static',
    'yield',
]);

function checkReservedWord(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
    if (!STRICT_RESERVED.has(node.name) || !isStrictScope(sem, scope)) return;
    errors.push({ pos: node.start, msg: `The keyword '${node.name}' is reserved` });
}

/** `oxc`'s `check_binding_identifier` (`:204`). Binding `eval` or `arguments` carries the SAME message
 *  as assigning to one — oxc reuses `unexpected_identifier_assign` for both. */
function checkBindingIdentifier(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
    if (node.name !== 'eval' && node.name !== 'arguments') return;
    if (!isStrictScope(sem, scope)) return;
    errors.push({ pos: node.start, msg: `Cannot assign to '${node.name}' in strict mode` });
}

/** The assignment half — `oxc`'s `check_identifier_reference` (`:275`). Handled from the ASSIGNMENT
 *  node rather than the identifier, so no ancestor stack is needed to know the identifier is a target. */
function checkAssignTarget(sem: Semantic, target: Node, scope: number, errors: CheckError[]): void {
    if (target.type !== N.IdentifierReference) return;
    if (target.name !== 'eval' && target.name !== 'arguments') return;
    if (!isStrictScope(sem, scope)) return;
    errors.push({ pos: target.start, msg: `Cannot assign to '${target.name}' in strict mode` });
}

/** `oxc`'s `check_directive` (`:494`). A `"use strict"` directive is illegal in a function whose
 *  parameter list is not SIMPLE — any default, rest or destructuring pattern — because the parameters
 *  would have to be evaluated under a strictness the directive only establishes afterwards. */
function checkUseStrictDirective(node: Node, errors: CheckError[]): void {
    const d = node.data as { params: Node[]; body: Node | null };
    if (d.body === null || d.body.type !== N.BlockStatement) return;
    if (d.params.every(isSimpleParam)) return;
    for (const st of (d.body.data as { body: Node[] }).body) {
        if (st.type !== N.ExpressionStatement) return;
        const e = (st.data as { expression: Node }).expression;
        if (e.type !== N.StringLiteral) return;
        if (e.name === '"use strict"' || e.name === "'use strict'") {
            errors.push({ pos: st.start, msg: "Illegal 'use strict' directive in function with non-simple parameter list" });
            return;
        }
    }
}

/** A SIMPLE parameter is a bare binding identifier and nothing else. A default (`a = 1`) keeps a
 *  `BindingIdentifier` pattern but carries an `init`, so the pattern type alone is not enough; a rest
 *  element is a different node entirely. */
const isSimpleParam = (p: Node): boolean => {
    if (p.type !== N.FormalParameter) return false;
    const d = p.data as { pattern: Node; init: Node | null };
    return d.pattern.type === N.BindingIdentifier && d.init === null;
};

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
