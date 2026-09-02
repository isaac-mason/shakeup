import { N, type Node, walkChildren } from '../ast/index.ts';
import { isStrictScope, type Semantic, SYM } from './semantic.ts';

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
    checkRedeclarations(sem, errors);
    const stack: Node[] = [program];
    // ONE context object per stack entry, not three parallel arrays. Almost no node changes any of
    // scope, jump target or visible private names, so the same object is pushed for every child and a
    // new one allocated only where something actually differs. That halves the pushes per node from
    // four to two, on a walk that runs over every node of every module.
    const ctxs: Ctx[] = [{ scope: ownScopeOf(program), jump: TOP_JUMP, privates: NO_PRIVATES }];
    while (stack.length > 0) {
        const node = stack.pop() as Node;
        const inherited = ctxs.pop() as Ctx;
        const own = ownScopeOf(node);
        const scope = own === 0 ? inherited.scope : own;
        checkNode(sem, node, scope, inherited.jump, inherited.privates, errors);
        const jump = descendJump(node, inherited.jump, errors);
        const priv = descendPrivates(node, inherited.privates, errors);
        const ctx =
            scope === inherited.scope && jump === inherited.jump && priv === inherited.privates
                ? inherited
                : { scope, jump, privates: priv };
        walkChildren(node, (child) => {
            stack.push(child);
            ctxs.push(ctx);
        });
    }
    return errors;
}

/**
 * What a `break` or `continue` may target at this point in the tree.
 *
 * oxc walks UP from the jump statement (`ctx.ancestry().ancestor_kinds()`); this carries the same
 * information DOWN, because the walk here is already top-down and a parent map would cost an entry per
 * node. Same answers, and the context object is only reallocated at the handful of nodes that change
 * it — a loop, a switch, a label, or a function boundary.
 *
 * `labels` maps a label name to whether it names an ITERATION statement, which is the distinction
 * between `break a` (any label) and `continue a` (loops only).
 */
type JumpCtx = { breakable: boolean; continuable: boolean; labels: ReadonlyMap<string, boolean> };

/** Everything carried down the walk, in one object so the stack holds one entry per node rather than
 *  one per context dimension. */
type Ctx = { scope: number; jump: JumpCtx; privates: ReadonlySet<string> };
const NO_LABELS: ReadonlyMap<string, boolean> = new Map();
const TOP_JUMP: JumpCtx = { breakable: false, continuable: false, labels: NO_LABELS };

const ITERATION = new Set<number>([N.WhileStatement, N.DoWhileStatement, N.ForStatement, N.ForInStatement, N.ForOfStatement]);

/** The label of `a: b: while (1) {}` names an iteration statement, through any number of labels. */
function labelsIteration(body: Node): boolean {
    let b = body;
    while (b.type === N.LabeledStatement) b = (b.data as { body: Node }).body;
    return ITERATION.has(b.type);
}

/** The context this node's CHILDREN see. */
function descendJump(node: Node, ctx: JumpCtx, errors: CheckError[]): JumpCtx {
    // A function body starts fresh: a jump may not cross the boundary, which is why
    // `while(1){ (function(){ break; }); }` is an error. A class static block is the same.
    if (
        node.type === N.FunctionDeclaration ||
        node.type === N.FunctionExpression ||
        node.type === N.ArrowFunctionExpression ||
        node.type === N.StaticBlock
    )
        return TOP_JUMP;
    if (ITERATION.has(node.type)) return { breakable: true, continuable: true, labels: ctx.labels };
    if (node.type === N.SwitchStatement) return { breakable: true, continuable: ctx.continuable, labels: ctx.labels };
    if (node.type === N.LabeledStatement) {
        const d = node.data as { label: Node; body: Node };
        const name = d.label.name;
        if (ctx.labels.has(name)) errors.push({ pos: d.label.start, msg: `Label \`${name}\` has already been declared` });
        const labels = new Map(ctx.labels);
        labels.set(name, labelsIteration(d.body));
        return { breakable: ctx.breakable, continuable: ctx.continuable, labels };
    }
    return ctx;
}

const NO_PRIVATES: ReadonlySet<string> = new Set();

/** Private names visible here — the UNION of every enclosing class, since a nested class may still
 *  reference an outer class's `#field`. Collected before descending, because a method may reference a
 *  private declared later in the same body.
 *
 *  A class is not a function boundary for this: `class C { #y; m(){ return o => o.#y; } }` is fine. */
function descendPrivates(node: Node, inherited: ReadonlySet<string>, errors: CheckError[]): ReadonlySet<string> {
    if (node.type !== N.ClassDeclaration && node.type !== N.ClassExpression) return inherited;
    const elements = (node.data as { body: Node[] }).body;
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
function checkPrivateName(field: Node, privates: ReadonlySet<string>, inClass: boolean, errors: CheckError[]): void {
    if (privates.has(field.name)) return;
    errors.push({
        pos: field.start,
        msg: inClass
            ? `Private field '#${field.name}' must be declared in an enclosing class`
            : `Private identifier '#${field.name}' is not allowed outside class bodies`,
    });
}

/** oxc's `check_break_statement` / `check_continue_statement` (`checker/javascript.rs:782,825`). */
function checkJump(node: Node, ctx: JumpCtx, errors: CheckError[]): void {
    const isBreak = node.type === N.BreakStatement;
    const label = (node.data as { label: Node | null }).label;
    if (label === null) {
        // A bare `break` needs a loop OR a switch; a bare `continue` needs a loop.
        if (isBreak ? !ctx.breakable : !ctx.continuable)
            errors.push({
                pos: node.start,
                msg: isBreak ? 'Illegal break statement' : 'Illegal continue statement: no surrounding iteration statement',
            });
        return;
    }
    const iter = ctx.labels.get(label.name);
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

/** Bindings that are LEXICAL: redeclaring one, or redeclaring anything as one, is an error.
 *  `var`, `function`, a parameter and a catch binding may all collide with each other freely — the
 *  matrix was taken from oxc rather than from the spec, and every pair agrees. */
const LEXICAL = SYM.LET | SYM.CONST | SYM.CLASS | SYM.IMPORT;
/** TS declaration MERGING, which is not redeclaration: an enum or namespace may legally be declared
 *  many times and combined.
 *
 *  `SYM.TYPE` is deliberately NOT here. A class carries `CLASS | TYPE`, because a class is both a
 *  value and a type — including `TYPE` in this mask silently exempted every class collision, which is
 *  half the rule. A binding that is ONLY a type (an interface, a type alias) is handled separately
 *  below: it merges, but it never collides with a value binding in the first place. */
const MERGEABLE = SYM.ENUM | SYM.NAMESPACE;
/** A pure TYPE binding — an interface or type alias, which may be declared repeatedly. */
const isTypeOnly = (flags: number): boolean => flags === SYM.TYPE;

/** oxc raises this from `SemanticBuilder` as bindings are made (`builder.rs`) as well as from its
 *  checker; we do the same split — `declare()` records the collision, this decides. */
function checkRedeclarations(sem: Semantic, errors: CheckError[]): void {
    for (const r of sem.redeclarations) {
        const both = r.prevFlags | r.flags;
        if ((both & MERGEABLE) !== 0 || isTypeOnly(r.prevFlags) || isTypeOnly(r.flags)) continue;
        const lexical = (both & LEXICAL) !== 0;
        // Duplicate PARAMETERS are the one pair that depends on strict mode — legal sloppy, an error
        // under a directive only reached after the parameters have been bound, which is why this
        // judgement waits until now rather than happening in `declare()`.
        const dupParam = (r.prevFlags & SYM.PARAM) !== 0 && (r.flags & SYM.PARAM) !== 0 && isStrictScope(sem, r.scope);
        if (!lexical && !dupParam) continue;
        errors.push({ pos: r.pos, msg: `Identifier \`${r.name}\` has already been declared` });
    }
}

/** The scope a node OWNS, or 0 for one that owns none.
 *
 *  The field is declared on several node types that do not always get a scope — a function body's
 *  `BlockStatement` is the common case, since the function scope already covers it — and it defaults
 *  to `0`, which is the table's NULL SENTINEL rather than a real scope. Treating that 0 as a scope
 *  silently reparents every node under it to the sentinel, whose flags are empty: strictness looked
 *  off inside every function body. */
const ownScopeOf = (node: Node): number => (node.data as { scopeId?: number } | null)?.scopeId ?? 0;

function checkNode(
    sem: Semantic,
    node: Node,
    scope: number,
    jump: JumpCtx,
    privates: ReadonlySet<string>,
    errors: CheckError[],
): void {
    switch (node.type) {
        case N.PrivateFieldExpression:
            checkPrivateName((node.data as { field: Node }).field, privates, privates !== NO_PRIVATES, errors);
            return;
        case N.BinaryExpression: {
            // `#x in o` — the ergonomic brand check. The private name is the LEFT operand here rather
            // than a member access, so it needs its own arm; everything else about the rule is the same.
            const b = node.data as { operator: string; left: Node };
            if (b.operator === 'in' && b.left.type === N.PrivateIdentifier)
                checkPrivateName(b.left, privates, privates !== NO_PRIVATES, errors);
            return;
        }
        case N.BreakStatement:
        case N.ContinueStatement:
            checkJump(node, jump, errors);
            return;
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
