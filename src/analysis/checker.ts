import { N, type Node } from '../ast/index.ts';
import { hasUniqueParams, isStrictScope, type Semantic, SYM } from './semantic.ts';

/** One early error, in the parser's diagnostic shape so both sinks read alike. */
export type CheckError = { pos: number; msg: string };

/**
 * Context the rules read, structurally satisfied by `analyze`'s own `AnalyseState`.
 *
 * Declared here rather than importing `AnalyseState` (which `semantic.ts` does not export) so the
 * dependency runs one way: `semantic.ts` imports the rules, and this module knows nothing about the
 * walker beyond the six fields it reads.
 */
export type CheckCtx = {
    sem: Semantic;
    scope: number;
    brk: boolean;
    cont: boolean;
    labels: ReadonlyMap<string, boolean>;
    privates: ReadonlySet<string>;
};

/**
 * Every rule that needs only the node and the current context, called once per node from the top of
 * `analyze`'s `visit`. This is the fused equivalent of oxc's `checker::check(kind, self)` inside
 * `SemanticBuilder::leave_node` (`builder.rs:840`).
 *
 * The rules that need ENTER/LEAVE bracketing — a loop making `break` legal, a class contributing
 * private names, a function boundary a jump may not cross — are NOT here. They live inline in the
 * `visit` arms that already open those scopes, because only there is there a "leave" to restore on.
 *
 * ORDER IS SOURCE ORDER, which the separate walk got wrong: it pushed children onto an explicit stack
 * and popped siblings back-to-front, so `"use strict"; delete x; var y = 010; delete z;` reported at
 * 44, 32, 21. oxc reports in source order and now so do we.
 */
export function checkEnter(ctx: CheckCtx, node: Node): void {
    const errors = ctx.sem.errors;
    switch (node.type) {
        case N.UnaryExpression:
            checkUnaryExpression(ctx.sem, node, ctx.scope, errors);
            return;
        case N.NumericLiteral:
            checkNumericLiteral(ctx.sem, node, ctx.scope, errors);
            return;
        case N.PrivateFieldExpression:
            checkPrivateName((node.data as { field: Node }).field, ctx.privates, ctx.privates !== NO_PRIVATES, errors);
            return;
        case N.BinaryExpression: {
            // `#x in o` — the ergonomic brand check. The private name is the LEFT operand here rather
            // than a member access, so it needs its own arm; everything else about the rule is the same.
            const b = node.data as { operator: string; left: Node };
            if (b.operator === 'in' && b.left.type === N.PrivateIdentifier)
                checkPrivateName(b.left, ctx.privates, ctx.privates !== NO_PRIVATES, errors);
            return;
        }
        case N.AssignmentExpression:
            checkAssignTarget(ctx.sem, (node.data as { left: Node }).left, ctx.scope, errors);
            return;
        case N.UpdateExpression:
            checkAssignTarget(ctx.sem, (node.data as { argument: Node }).argument, ctx.scope, errors);
            return;
        case N.BreakStatement:
        case N.ContinueStatement: {
            checkJump(node, ctx.brk, ctx.cont, ctx.labels, errors);
            // A LabelIdentifier is not a reference and is never collected, so `collect`'s hook cannot
            // reach it; both the jump's label and the labelled statement's own are checked here.
            const label = (node.data as { label: Node | null }).label;
            if (label !== null) checkReservedWord(ctx.sem, label, ctx.scope, errors);
            return;
        }
        case N.LabeledStatement:
            checkReservedWord(ctx.sem, (node.data as { label: Node }).label, ctx.scope, errors);
            return;
        case N.FunctionDeclaration:
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
            checkUseStrictDirective(node, errors);
            return;
        case N.ObjectProperty:
        case N.MethodDefinition:
        case N.PropertyDefinition: {
            // `visit` descends into a key only when it is COMPUTED, because a plain key is not a
            // reference. But `"use strict"; ({ 010: 1 })` is a legacy-octal error the separate walk
            // caught by visiting every node, so the key is checked here rather than descended into.
            const d = node.data as { computed: boolean; key?: Node };
            if (!d.computed && d.key !== undefined && d.key.type === N.NumericLiteral)
                checkNumericLiteral(ctx.sem, d.key, ctx.scope, errors);
            return;
        }
        default:
            return;
    }
}

export const NO_LABELS: ReadonlyMap<string, boolean> = new Map();

const ITERATION = new Set<number>([N.WhileStatement, N.DoWhileStatement, N.ForStatement, N.ForInStatement, N.ForOfStatement]);

/** The label of `a: b: while (1) {}` names an iteration statement, through any number of labels. */
export function labelsIteration(body: Node): boolean {
    let b = body;
    while (b.type === N.LabeledStatement) b = (b.data as { body: Node }).body;
    return ITERATION.has(b.type);
}

export const NO_PRIVATES: ReadonlySet<string> = new Set();

/** Private names visible here — the UNION of every enclosing class, since a nested class may still
 *  reference an outer class's `#field`. Collected before descending, because a method may reference a
 *  private declared later in the same body.
 *
 *  A class is not a function boundary for this: `class C { #y; m(){ return o => o.#y; } }` is fine. */
export function classPrivateNames(elements: Node[], inherited: ReadonlySet<string>, errors: CheckError[]): ReadonlySet<string> {
    const own = new Set(inherited);
    // Private names share ONE namespace per class — unlike public members, where `m(){}` and
    // `static m(){}` coexist. The single exemption is a getter/setter PAIR, and only when both have
    // the same static-ness: `get #x(){} static get #x(){}` still collides. oxc reports it with the
    // ordinary redeclaration message.
    const seen = new Map<string, { kind: string; isStatic: boolean }>();
    for (const el of elements) {
        const d = el.data as { key?: Node; static?: boolean; kind?: string };
        if (d.key === undefined || d.key.type !== N.PrivateIdentifier) continue;
        own.add(d.key.name);
        const kind = d.kind === 'get' || d.kind === 'set' ? d.kind : 'other';
        const isStatic = d.static === true;
        const prev = seen.get(d.key.name);
        const pairs =
            prev !== undefined && prev.kind !== 'other' && kind !== 'other' && prev.kind !== kind && prev.isStatic === isStatic;
        if (prev !== undefined && !pairs)
            errors.push({ pos: d.key.start, msg: `Identifier \`#${d.key.name}\` has already been declared` });
        // A completed pair occupies the slot as `other`, so a third element on the same name collides.
        seen.set(d.key.name, { kind: pairs ? 'other' : kind, isStatic });
    }
    return own;
}

/** oxc's `check_private_identifier_outside_class` (`:352`) and `check_private_identifier` (`:361`).
 *  Two distinct messages: no enclosing class at all, versus a class that never declares the name. */
export function checkPrivateName(field: Node, privates: ReadonlySet<string>, inClass: boolean, errors: CheckError[]): void {
    if (privates.has(field.name)) return;
    errors.push({
        pos: field.start,
        msg: inClass
            ? `Private field '#${field.name}' must be declared in an enclosing class`
            : `Private identifier '#${field.name}' is not allowed outside class bodies`,
    });
}

/** oxc's `check_break_statement` / `check_continue_statement` (`checker/javascript.rs:782,825`). */
export function checkJump(
    node: Node,
    brk: boolean,
    cont: boolean,
    labels: ReadonlyMap<string, boolean>,
    errors: CheckError[],
): void {
    const isBreak = node.type === N.BreakStatement;
    const label = (node.data as { label: Node | null }).label;
    if (label === null) {
        // A bare `break` needs a loop OR a switch; a bare `continue` needs a loop.
        if (isBreak ? !brk : !cont)
            errors.push({
                pos: node.start,
                msg: isBreak ? 'Illegal break statement' : 'Illegal continue statement: no surrounding iteration statement',
            });
        return;
    }
    const iter = labels.get(label.name);
    if (iter === undefined) {
        errors.push({ pos: label.start, msg: 'Use of undefined label' });
        return;
    }
    // `break` reaches any label; `continue` only one that names a loop.
    if (!isBreak && !iter)
        errors.push({
            pos: label.start,
            msg: 'A `continue` statement can only jump to a label of an enclosing `for`, `while` or `do while` statement.',
        });
}

/** These three read `SYM` at CALL time, not at module-init time, and must stay that way: `semantic.ts`
 *  imports this module, so a module-level `const LEXICAL = SYM.LET | ...` would evaluate a binding
 *  from a half-initialised `semantic.ts` and throw on TDZ. Arrow BODIES run after both modules are up.
 *
 *  Bindings that are LEXICAL: redeclaring one, or redeclaring anything as one, is an error.
 *  `var`, `function`, a parameter and a catch binding may all collide with each other freely — the
 *  matrix was taken from oxc rather than from the spec, and every pair agrees. */
const isLexical = (f: number): boolean => (f & (SYM.LET | SYM.CONST | SYM.CLASS | SYM.IMPORT)) !== 0;
/** TS declaration MERGING, which is not redeclaration: an enum or namespace may legally be declared
 *  many times and combined.
 *
 *  `SYM.TYPE` is deliberately NOT here. A class carries `CLASS | TYPE`, because a class is both a
 *  value and a type — including `TYPE` in this mask silently exempted every class collision, which is
 *  half the rule. A binding that is ONLY a type (an interface, a type alias) is handled separately
 *  below: it merges, but it never collides with a value binding in the first place. */
const isMergeable = (f: number): boolean => (f & (SYM.ENUM | SYM.NAMESPACE)) !== 0;
/** A pure TYPE binding — an interface or type alias, which may be declared repeatedly. */
const isTypeOnly = (flags: number): boolean => flags === SYM.TYPE;

/** oxc raises this from `SemanticBuilder` as bindings are made (`builder.rs`) as well as from its
 *  checker; we do the same split — `declare()` records the collision, this decides. */
export function checkRedeclarations(sem: Semantic, errors: CheckError[]): void {
    for (const r of sem.redeclarations) {
        const both = r.prevFlags | r.flags;
        if (isMergeable(both) || isTypeOnly(r.prevFlags) || isTypeOnly(r.flags)) continue;
        // A named function EXPRESSION's own name is bound in its own scope per the spec, so the body
        // may shadow it — `(function n(){ let n = 1; })` is valid, as are the `const` and `class`
        // forms. We bind it in the function scope, so the collision has to be excused here.
        if (((r.prevFlags | r.flags) & SYM.FN_EXPR_NAME) !== 0) continue;
        const lexical = isLexical(both);
        // Duplicate PARAMETERS are the one pair that depends on strict mode — legal sloppy, an error
        // under a directive only reached after the parameters have been bound, which is why this
        // judgement waits until now rather than happening in `declare()`.
        // Duplicate PARAMETERS. Legal sloppy for a plain `function f(a, a) {}` — and, verified against
        // oxc rather than assumed, also legal for `function* g(a, a)` and `async function h(a, a)`,
        // which use FormalParameters rather than UniqueFormalParameters. They are an error under a
        // directive only reached after the parameters were bound, and independently of mode wherever
        // the grammar demands UniqueFormalParameters: arrows, methods and accessors, plus any function
        // whose parameter list is not simple. `analyze` records that last set on the scope.
        const dupParam =
            (r.prevFlags & SYM.PARAM) !== 0 &&
            (r.flags & SYM.PARAM) !== 0 &&
            (isStrictScope(sem, r.scope) || hasUniqueParams(sem, r.scope));
        if (!lexical && !dupParam) continue;
        errors.push({ pos: r.pos, msg: `Identifier \`${r.name}\` has already been declared` });
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

/**
 * The two rules that fire on a BINDING identifier, called from `declare()` — the semantic builder's
 * own binding hook, which sees every one of them with `state.scope` already correct.
 *
 * This is where the naive fusion goes wrong. `analyze`'s `visit` never receives a `BindingIdentifier`
 * at all: measured on `three.core.js`, all 7,331 of them are reached through `declare`/`declarePattern`
 * and 1,731 `IdentifierReference` through `collect`, so hanging the rules off `visit` would silently
 * stop checking them — and coverage lost that way shows up as test262 PASS going UP.
 *
 * The type is checked because `declare` is also reached for names the old walk never ran these rules
 * on; firing unconditionally would invent errors rather than preserve behaviour.
 */
export function checkBindingIdent(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
    if (node.type !== N.BindingIdentifier) return;
    checkReservedWord(sem, node, scope, errors);
    checkBindingIdentifier(sem, node, scope, errors);
}

/** The reference half, called from `collect()`. `LabelIdentifier` is NOT reached this way — it has its
 *  own hook on the labelled statement, because a label is not a reference and is never collected. */
export function checkReferenceIdent(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
    if (node.type !== N.IdentifierReference) return;
    checkReservedWord(sem, node, scope, errors);
}

export function checkReservedWord(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
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
export function checkAssignTarget(sem: Semantic, target: Node, scope: number, errors: CheckError[]): void {
    if (target.type !== N.IdentifierReference) return;
    if (target.name !== 'eval' && target.name !== 'arguments') return;
    if (!isStrictScope(sem, scope)) return;
    errors.push({ pos: target.start, msg: `Cannot assign to '${target.name}' in strict mode` });
}

/** `oxc`'s `check_directive` (`:494`). A `"use strict"` directive is illegal in a function whose
 *  parameter list is not SIMPLE — any default, rest or destructuring pattern — because the parameters
 *  would have to be evaluated under a strictness the directive only establishes afterwards. */
export function checkUseStrictDirective(node: Node, errors: CheckError[]): void {
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
/** A parameter list is SIMPLE when every entry is a bare binding identifier. Exported because two
 *  separate rules turn on it: the `"use strict"` directive rule below, and — via `analyze` — duplicate
 *  parameters, which a non-simple list forbids even in sloppy code. */
export const paramsAreSimple = (list: Node[]): boolean => list.every(isSimpleParam);

const isSimpleParam = (p: Node): boolean => {
    if (p.type !== N.FormalParameter) return false;
    const d = p.data as { pattern: Node; init: Node | null };
    return d.pattern.type === N.BindingIdentifier && d.init === null;
};

/** oxc's `check_unary_expression` (`checker/javascript.rs:1278`). */
export function checkUnaryExpression(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
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
export function checkNumericLiteral(sem: Semantic, node: Node, scope: number, errors: CheckError[]): void {
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
