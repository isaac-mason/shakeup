import { N, type Node, TYPE_NAME } from '../ast.ts';
import { BINARY_PREC, LOGICAL_PREC, Prec } from './precedence.ts';
import { dropTrailingSemi, mark, type Printer, parens, semi, softNewline, softSpace, space, write } from './printer.ts';

// Loose view of a node's payload — the printer reads fields positionally per arm.
type D = Record<string, Node | (Node | null)[] | string | number | boolean | null>;
const data = (n: Node): D => n.data as unknown as D;

/** A `PrivateIdentifier`'s text is stored without the leading `#`; restore it. */
const privName = (n: Node): string => (n.name[0] === '#' ? n.name : `#${n.name}`);

/** Precedence of an expression node — what a parent must require to avoid wrapping it. */
function precOf(n: Node): Prec {
    switch (n.type) {
        case N.SequenceExpression:
            return Prec.Comma;
        case N.AssignmentExpression:
        case N.ArrowFunctionExpression:
        case N.YieldExpression:
            return Prec.Assign;
        case N.ConditionalExpression:
            return Prec.Conditional;
        case N.LogicalExpression:
            return LOGICAL_PREC[data(n).operator as string];
        case N.BinaryExpression:
            return BINARY_PREC[data(n).operator as string];
        case N.UnaryExpression:
        case N.AwaitExpression:
            return Prec.Unary;
        case N.UpdateExpression:
            return (data(n).prefix as boolean) ? Prec.Unary : Prec.Postfix;
        case N.NewExpression:
            return (data(n).arguments as Node[]).length > 0 ? Prec.Call : Prec.New;
        case N.CallExpression:
        case N.ImportExpression:
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
        case N.TaggedTemplateExpression:
        case N.ChainExpression:
            return Prec.Call;
        default:
            return Prec.Primary;
    }
}

/** Print an expression, wrapping in parens iff its precedence is below `minPrec`. */
export function printExpr(p: Printer, n: Node, minPrec: Prec): void {
    parens(p, precOf(n) < minPrec, () => emitExpr(p, n));
}

/** `??` cannot be mixed with `||`/`&&` without parentheses (a syntax error otherwise). */
const isNullishMix = (a: string, b: string): boolean =>
    (a === '??' && (b === '||' || b === '&&')) || ((a === '||' || a === '&&') && b === '??');

function printBinaryOperand(p: Printer, child: Node, minPrec: Prec): void {
    printExpr(p, child, minPrec);
}

/** The leading '+'/'-' char the printed form of `n` starts with (via its left spine), or ''.
 *  Used to force a mandatory space so `a - -b` / `a + ++b` can't merge into `a--b` / `a+++b`
 *  under minify. A parenthesised operand starts with '(' so this over-reporting is harmless
 *  (a spurious space, never a wrong token). */
function leadingSign(n: Node): string {
    switch (n.type) {
        case N.UnaryExpression: {
            const op = data(n).operator as string;
            return op === '+' || op === '-' ? op : '';
        }
        case N.UpdateExpression:
            return (data(n).prefix as boolean) ? (data(n).operator as string)[0] : leadingSign(data(n).argument as Node);
        case N.BinaryExpression:
        case N.LogicalExpression:
        case N.AssignmentExpression:
            return leadingSign(data(n).left as Node);
        case N.ConditionalExpression:
            return leadingSign(data(n).test as Node);
        case N.SequenceExpression:
            return leadingSign((data(n).expressions as Node[])[0]);
        case N.CallExpression:
            return leadingSign(data(n).callee as Node);
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
            return leadingSign(data(n).object as Node);
        case N.TaggedTemplateExpression:
            return leadingSign(data(n).tag as Node);
        case N.ChainExpression:
        case N.TSNonNullExpression:
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
        case N.TSInstantiationExpression:
            return leadingSign(data(n).expression as Node);
        default:
            return '';
    }
}

/** Does a `new` callee contain a call on its member spine? Such a callee must be
 *  parenthesised (see {@link emitExpr} NewExpression). */
function newCalleeHasCall(n: Node): boolean {
    switch (n.type) {
        case N.CallExpression:
            return true;
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
            return newCalleeHasCall(data(n).object as Node);
        case N.ChainExpression:
        case N.TSNonNullExpression:
        case N.TSInstantiationExpression:
            return newCalleeHasCall(data(n).expression as Node);
        default:
            return false;
    }
}

function emitBinary(p: Printer, n: Node): void {
    const d = data(n);
    const op = d.operator as string;
    const prec = BINARY_PREC[op];
    const wordOp = op === 'in' || op === 'instanceof';
    if (op === '**') {
        // right-assoc; a unary/lower left operand must be parenthesised (`(-2)**2`).
        printBinaryOperand(p, d.left as Node, Prec.Unary + 1);
    } else {
        printBinaryOperand(p, d.left as Node, prec);
    }
    if (wordOp) space(p);
    else softSpace(p);
    write(p, op);
    // `+`/`-` before a right operand that also leads with that sign needs a real space,
    // else `-` `-b` collapses to the `--` token (`a--b`) — a different program.
    const mergeRisk = (op === '+' || op === '-') && leadingSign(d.right as Node) === op;
    if (wordOp || mergeRisk) space(p);
    else softSpace(p);
    printBinaryOperand(p, d.right as Node, op === '**' ? prec : ((prec + 1) as Prec));
}

function emitLogical(p: Printer, n: Node): void {
    const d = data(n);
    const op = d.operator as string;
    const prec = LOGICAL_PREC[op];
    const operand = (child: Node, minPrec: Prec): void => {
        const force = child.type === N.LogicalExpression && isNullishMix(op, data(child).operator as string);
        parens(p, force || precOf(child) < minPrec, () => emitExpr(p, child));
    };
    operand(d.left as Node, prec);
    softSpace(p);
    write(p, op);
    softSpace(p);
    operand(d.right as Node, (prec + 1) as Prec);
}

function emitArgs(p: Printer, args: Node[]): void {
    write(p, '(');
    for (let i = 0; i < args.length; i++) {
        if (i > 0) {
            write(p, ',');
            softSpace(p);
        }
        printExpr(p, args[i], Prec.Assign);
    }
    write(p, ')');
}

function emitParams(p: Printer, params: Node[]): void {
    write(p, '(');
    for (let i = 0; i < params.length; i++) {
        if (i > 0) {
            write(p, ',');
            softSpace(p);
        }
        emitExpr(p, params[i]);
    }
    write(p, ')');
}

/** `function` bodies and object/class method values share the params+body tail. */
function emitFunctionTail(p: Printer, d: D): void {
    emitParams(p, d.params as Node[]);
    softSpace(p);
    printStmt(p, d.body as Node);
}

function emitFunction(p: Printer, n: Node): void {
    const d = data(n);
    if (d.async as boolean) {
        write(p, 'async');
        space(p);
    }
    write(p, 'function');
    if (d.generator as boolean) write(p, '*');
    const id = d.id as Node | null;
    if (id) {
        space(p);
        write(p, p.nameOf(id));
    } else {
        softSpace(p);
    }
    emitFunctionTail(p, d);
}

/** A single `(x)` param with no default/rest/destructuring can shed its parens under minify. */
function isBareArrowParam(param: Node): boolean {
    if (param.type !== N.FormalParameter) return false;
    const pd = data(param);
    return (pd.pattern as Node).type === N.BindingIdentifier && (pd.init as Node | null) === null;
}

function emitArrow(p: Printer, n: Node): void {
    const d = data(n);
    if (d.async as boolean) {
        write(p, 'async');
        space(p);
    }
    const params = d.params as Node[];
    if (p.opts.minify && params.length === 1 && isBareArrowParam(params[0])) {
        emitExpr(p, data(params[0]).pattern as Node); // `x =>` instead of `(x) =>`
    } else {
        emitParams(p, params);
    }
    softSpace(p);
    write(p, '=>');
    softSpace(p);
    const body = d.body as Node;
    if (!(d.expression as boolean)) {
        printStmt(p, body);
    } else if (body.type === N.ObjectExpression) {
        parens(p, true, () => emitExpr(p, body));
    } else {
        printExpr(p, body, Prec.Assign);
    }
}

function emitObjectMember(p: Printer, n: Node): void {
    // ObjectProperty (also used inside ObjectPattern) and SpreadElement/RestElement.
    if (n.type === N.SpreadElement || n.type === N.RestElement) {
        write(p, '...');
        printExpr(p, data(n).argument as Node, Prec.Assign);
        return;
    }
    const d = data(n);
    const kind = d.kind as string;
    const computed = d.computed as boolean;
    const value = d.value as Node;
    if (kind === 'get' || kind === 'set') {
        write(p, kind);
        space(p);
        emitPropertyKey(p, d.key as Node, computed);
        emitFunctionTail(p, data(value));
        return;
    }
    emitPropertyKey(p, d.key as Node, computed);
    if (d.shorthand as boolean) {
        // Shorthand omits the value — but if the value binding was RENAMED (bundle deconflict /
        // minify), the shorthand must expand to `key: <renamed>` or the reference dangles.
        if (value.type === N.AssignmentPattern) {
            // `{ w = 1 }` in a pattern: left is the binding (maybe renamed), right is the default.
            const left = data(value).left as Node;
            const rn = p.nameOf(left);
            if (rn !== left.name) {
                write(p, ':');
                softSpace(p);
                write(p, rn);
            }
            softSpace(p);
            write(p, '=');
            softSpace(p);
            printExpr(p, data(value).right as Node, Prec.Assign);
            return;
        }
        const rn = p.nameOf(value);
        if (rn !== value.name) {
            write(p, ':');
            softSpace(p);
            write(p, rn);
        }
        return;
    }
    write(p, ':');
    softSpace(p);
    printExpr(p, value, Prec.Assign);
}

const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function emitPropertyKey(p: Printer, key: Node, computed: boolean): void {
    if (computed) {
        write(p, '[');
        printExpr(p, key, Prec.Assign);
        write(p, ']');
        return;
    }
    // `{ "foo": 1 }` → `{ foo: 1 }` when the string key is a plain identifier (minify).
    if (p.opts.minify && key.type === N.StringLiteral) {
        const inner = key.name.slice(1, -1);
        if (IDENT_KEY.test(inner)) {
            write(p, inner);
            return;
        }
    }
    emitExpr(p, key);
}

function emitMemberObject(p: Printer, object: Node): void {
    // `1 .toString()` — a numeric-literal object needs disambiguation; parenthesise it.
    parens(p, object.type === N.NumericLiteral, () => printExpr(p, object, Prec.Call));
}

function emitTemplate(p: Printer, quasis: Node[], expressions: Node[]): void {
    write(p, '`');
    for (let i = 0; i < quasis.length; i++) {
        write(p, quasis[i].name);
        if (i < expressions.length) {
            write(p, '${');
            printExpr(p, expressions[i], Prec.Lowest);
            write(p, '}');
        }
    }
    write(p, '`');
}

function emitArray(p: Printer, elements: (Node | null)[]): void {
    write(p, '[');
    for (let i = 0; i < elements.length; i++) {
        if (i > 0) write(p, ',');
        const el = elements[i];
        if (el !== null) printExpr(p, el, Prec.Assign);
    }
    // A trailing hole needs an extra comma to survive re-parse (`[a,,]`).
    if (elements.length > 0 && elements[elements.length - 1] === null) write(p, ',');
    write(p, ']');
}

/** Emit an expression node's own text (no outer precedence wrapping — see `printExpr`). */
function emitExpr(p: Printer, n: Node): void {
    mark(p, n);
    // Bundle rewrites (dynamic import() retarget, asset URLs) are pre-resolved to text.
    if (p.overrides !== null) {
        const r = p.overrides.get(n);
        if (r !== undefined) {
            write(p, r);
            return;
        }
    }
    const d = data(n);
    switch (n.type) {
        case N.IdentifierReference:
        case N.BindingIdentifier:
            write(p, p.nameOf(n));
            return;
        case N.IdentifierName:
        case N.LabelIdentifier:
        case N.JSXIdentifier:
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.RegExpLiteral:
        case N.BigIntLiteral:
            write(p, n.name);
            return;
        case N.PrivateIdentifier:
            write(p, privName(n));
            return;
        case N.NullLiteral:
            write(p, 'null');
            return;
        case N.ThisExpression:
            write(p, 'this');
            return;
        case N.Super:
            write(p, 'super');
            return;
        case N.ImportMeta:
            write(p, 'import.meta');
            return;
        case N.NewTarget:
            write(p, 'new.target');
            return;
        case N.TemplateLiteral:
            emitTemplate(p, d.quasis as Node[], d.expressions as Node[]);
            return;
        case N.TaggedTemplateExpression:
            printExpr(p, d.tag as Node, Prec.Call);
            emitExpr(p, d.quasi as Node);
            return;
        case N.ArrayExpression:
        case N.ArrayPattern:
            emitArray(p, d.elements as (Node | null)[]);
            return;
        case N.ObjectExpression:
        case N.ObjectPattern: {
            const props = d.properties as Node[];
            if (props.length === 0) {
                write(p, '{}');
                return;
            }
            write(p, '{');
            softSpace(p);
            for (let i = 0; i < props.length; i++) {
                if (i > 0) {
                    write(p, ',');
                    softSpace(p);
                }
                emitObjectMember(p, props[i]);
            }
            softSpace(p);
            write(p, '}');
            return;
        }
        case N.SpreadElement:
        case N.RestElement:
            write(p, '...');
            printExpr(p, d.argument as Node, Prec.Assign);
            return;
        case N.BinaryExpression:
            emitBinary(p, n);
            return;
        case N.LogicalExpression:
            emitLogical(p, n);
            return;
        case N.AssignmentExpression: {
            printExpr(p, d.left as Node, Prec.Assign);
            softSpace(p);
            write(p, d.operator as string);
            softSpace(p);
            printExpr(p, d.right as Node, Prec.Assign);
            return;
        }
        case N.AssignmentPattern:
            emitExpr(p, d.left as Node);
            softSpace(p);
            write(p, '=');
            softSpace(p);
            printExpr(p, d.right as Node, Prec.Assign);
            return;
        case N.UnaryExpression: {
            const op = d.operator as string;
            const wordOp = op === 'typeof' || op === 'void' || op === 'delete';
            write(p, op);
            const arg = d.argument as Node;
            if (wordOp || arg.type === N.UnaryExpression || arg.type === N.UpdateExpression) space(p);
            printExpr(p, arg, Prec.Unary);
            return;
        }
        case N.UpdateExpression: {
            const op = d.operator as string;
            const arg = d.argument as Node;
            if (d.prefix as boolean) {
                write(p, op);
                printExpr(p, arg, Prec.Unary);
            } else {
                printExpr(p, arg, Prec.Postfix);
                write(p, op);
            }
            return;
        }
        case N.ConditionalExpression:
            printExpr(p, d.test as Node, (Prec.Conditional + 1) as Prec);
            softSpace(p);
            write(p, '?');
            softSpace(p);
            printExpr(p, d.consequent as Node, Prec.Assign);
            softSpace(p);
            write(p, ':');
            softSpace(p);
            printExpr(p, d.alternate as Node, Prec.Assign);
            return;
        case N.CallExpression:
            printExpr(p, d.callee as Node, Prec.Call);
            if (d.optional as boolean) write(p, '?.');
            emitArgs(p, d.arguments as Node[]);
            return;
        case N.NewExpression: {
            write(p, 'new');
            space(p);
            // A call on the callee's member spine must be parenthesised, else `new (foo())()`
            // degrades to `new foo()()` = `(new foo())()` — the `()` binds as the new's args.
            const callee = d.callee as Node;
            if (newCalleeHasCall(callee)) {
                write(p, '(');
                emitExpr(p, callee);
                write(p, ')');
            } else {
                printExpr(p, callee, Prec.New);
            }
            emitArgs(p, d.arguments as Node[]);
            return;
        }
        case N.ImportExpression: {
            write(p, 'import(');
            printExpr(p, d.source as Node, Prec.Assign);
            const options = d.options as Node | null;
            if (options) {
                write(p, ',');
                softSpace(p);
                printExpr(p, options, Prec.Assign);
            }
            write(p, ')');
            return;
        }
        case N.StaticMemberExpression:
            emitMemberObject(p, d.object as Node);
            write(p, (d.optional as boolean) ? '?.' : '.');
            write(p, (d.property as Node).name);
            return;
        case N.ComputedMemberExpression:
            emitMemberObject(p, d.object as Node);
            if (d.optional as boolean) write(p, '?.');
            write(p, '[');
            printExpr(p, d.expression as Node, Prec.Lowest);
            write(p, ']');
            return;
        case N.PrivateFieldExpression:
            emitMemberObject(p, d.object as Node);
            write(p, (d.optional as boolean) ? '?.' : '.');
            write(p, privName(d.field as Node));
            return;
        case N.ChainExpression:
            emitExpr(p, d.expression as Node);
            return;
        case N.SequenceExpression: {
            const exprs = d.expressions as Node[];
            for (let i = 0; i < exprs.length; i++) {
                if (i > 0) {
                    write(p, ',');
                    softSpace(p);
                }
                printExpr(p, exprs[i], Prec.Assign);
            }
            return;
        }
        case N.FunctionExpression:
            emitFunction(p, n);
            return;
        case N.ArrowFunctionExpression:
            emitArrow(p, n);
            return;
        case N.YieldExpression: {
            write(p, 'yield');
            if (d.delegate as boolean) write(p, '*');
            const arg = d.argument as Node | null;
            if (arg) {
                space(p);
                printExpr(p, arg, Prec.Assign);
            }
            return;
        }
        case N.AwaitExpression:
            write(p, 'await');
            space(p);
            printExpr(p, d.argument as Node, Prec.Unary);
            return;
        case N.FormalParameter: {
            emitExpr(p, d.pattern as Node);
            const init = d.init as Node | null;
            if (init) {
                softSpace(p);
                write(p, '=');
                softSpace(p);
                printExpr(p, init, Prec.Assign);
            }
            return;
        }
        case N.ClassExpression:
            emitClass(p, n);
            return;
        default:
            throw new Error(`printer: unsupported expression node ${TYPE_NAME[n.type] ?? n.type}`);
    }
}

// ---------------------------------------------------------------------------
// Classes (declaration + expression share one body emitter)
// ---------------------------------------------------------------------------

function emitClassMember(p: Printer, n: Node): void {
    const d = data(n);
    if (n.type === N.StaticBlock) {
        write(p, 'static');
        softSpace(p);
        printBlock(p, n);
        return;
    }
    if (d.static as boolean) {
        write(p, 'static');
        space(p);
    }
    if (n.type === N.PropertyDefinition) {
        emitPropertyKey(p, d.key as Node, d.computed as boolean);
        const value = d.value as Node | null;
        if (value) {
            softSpace(p);
            write(p, '=');
            softSpace(p);
            printExpr(p, value, Prec.Assign);
        }
        semi(p);
        return;
    }
    // MethodDefinition — modifiers come off the value FunctionExpression.
    const value = d.value as Node;
    const vd = data(value);
    const kind = d.kind as string;
    if (vd.async as boolean) {
        write(p, 'async');
        space(p);
    }
    if (kind === 'get' || kind === 'set') {
        write(p, kind);
        space(p);
    }
    if (vd.generator as boolean) write(p, '*');
    emitPropertyKey(p, d.key as Node, d.computed as boolean);
    emitFunctionTail(p, vd);
}

function emitClass(p: Printer, n: Node): void {
    const d = data(n);
    write(p, 'class');
    const id = d.id as Node | null;
    if (id) {
        space(p);
        write(p, p.nameOf(id));
    }
    const superClass = d.superClass as Node | null;
    if (superClass) {
        space(p);
        write(p, 'extends');
        space(p);
        printExpr(p, superClass, Prec.Call);
    }
    softSpace(p);
    write(p, '{');
    const members = d.body as Node[]; // tsStrip already removed TS-only members
    if (members.length === 0) {
        write(p, '}');
        return;
    }
    p.indent++;
    for (const m of members) {
        softNewline(p);
        emitClassMember(p, m);
    }
    p.indent--;
    softNewline(p);
    write(p, '}');
}

// ---------------------------------------------------------------------------
// TS enum lowering — the runtime IIFE, ported from emit.ts `lowerEnum`
// (`src/emit.ts:179`). Member initializers print through `printExpr`; a bare
// reference to an earlier member shadows the outer scope, so it is rewritten to
// `EnumName.member` via a scoped `nameOf` override.
// ---------------------------------------------------------------------------

function emitEnum(p: Printer, n: Node): void {
    const d = data(n);
    const name = p.nameOf(d.id as Node);
    write(p, 'var');
    space(p);
    write(p, name);
    semi(p);
    softSpace(p);
    write(p, '(function(');
    write(p, name);
    write(p, ')');
    softSpace(p);
    write(p, '{');
    p.indent++;

    const prior = new Set<string>();
    const savedNameOf = p.nameOf;
    const shadow = (id: Node): string =>
        id.type === N.IdentifierReference && prior.has(id.name) ? `${name}.${id.name}` : savedNameOf(id);
    let autoNext = 0;
    let autoOk = true;

    for (const m of d.members as Node[]) {
        if (m.type !== N.TSEnumMember) continue;
        const md = data(m);
        const memId = md.id as Node;
        const key = memId.type === N.StringLiteral ? memId.name.slice(1, -1) : memId.name;
        const keyLit = JSON.stringify(key);
        const init = md.initializer as Node | null;
        softNewline(p);

        if (init === null) {
            if (!autoOk) {
                autoNext = 0;
                autoOk = true;
            }
            write(p, `${name}[${name}[${keyLit}]=${autoNext}]=${keyLit};`);
            autoNext++;
            prior.add(key);
            continue;
        }

        p.nameOf = shadow;
        if (init.type === N.StringLiteral) {
            write(p, `${name}[${keyLit}]=`);
            printExpr(p, init, Prec.Assign);
            write(p, ';');
            autoOk = false;
        } else {
            write(p, `${name}[${name}[${keyLit}]=`);
            printExpr(p, init, Prec.Assign);
            write(p, `]=${keyLit};`);
            if (init.type === N.NumericLiteral) {
                const v = Number(init.name);
                if (Number.isFinite(v)) {
                    autoNext = v + 1;
                    autoOk = true;
                } else autoOk = false;
            } else autoOk = false;
        }
        p.nameOf = savedNameOf;
        prior.add(key);
    }

    p.indent--;
    softNewline(p);
    write(p, '})(');
    write(p, name);
    write(p, '||(');
    write(p, name);
    write(p, '={}));');
}

// Statements (minimal set to host expressions; PR2 adds import/export, TS, JSX)

function exprStmtNeedsParens(n: Node): boolean {
    switch (n.type) {
        case N.ObjectExpression:
        case N.FunctionExpression:
        case N.ClassExpression:
            return true;
        case N.BinaryExpression:
        case N.LogicalExpression:
        case N.AssignmentExpression:
            return exprStmtNeedsParens(data(n).left as Node);
        case N.SequenceExpression:
            return exprStmtNeedsParens((data(n).expressions as Node[])[0]);
        case N.ConditionalExpression:
            return exprStmtNeedsParens(data(n).test as Node);
        case N.CallExpression:
            return exprStmtNeedsParens(data(n).callee as Node);
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
            return exprStmtNeedsParens(data(n).object as Node);
        case N.TaggedTemplateExpression:
            return exprStmtNeedsParens(data(n).tag as Node);
        case N.UpdateExpression:
            return !(data(n).prefix as boolean) && exprStmtNeedsParens(data(n).argument as Node);
        default:
            return false;
    }
}

function printVarDecl(p: Printer, n: Node, withSemi: boolean): void {
    const d = data(n);
    write(p, d.kind as string);
    space(p);
    const decls = d.declarations as Node[];
    for (let i = 0; i < decls.length; i++) {
        if (i > 0) {
            write(p, ',');
            softSpace(p);
        }
        const dd = data(decls[i]);
        emitExpr(p, dd.id as Node);
        const init = dd.init as Node | null;
        if (init) {
            softSpace(p);
            write(p, '=');
            softSpace(p);
            printExpr(p, init, Prec.Assign);
        }
    }
    if (withSemi) semi(p);
}

function printBlock(p: Printer, n: Node): void {
    write(p, '{');
    const body = data(n).body as Node[];
    if (body.length === 0) {
        write(p, '}');
        return;
    }
    p.indent++;
    for (const s of body) {
        softNewline(p);
        printStmt(p, s);
    }
    dropTrailingSemi(p); // last statement's `;` is redundant before `}`
    p.indent--;
    softNewline(p);
    write(p, '}');
}

/** Print a statement in body position. A block only needs a soft separator (`)`/keyword
 *  then `{`); a non-block clause following a bare keyword (`else`/`do`/`try`/`finally`)
 *  needs a mandatory space so `else c()` doesn't collapse to `elsec()`. */
function printClause(p: Printer, n: Node, afterKeyword = false): void {
    if (n.type === N.BlockStatement || !afterKeyword) softSpace(p);
    else space(p);
    printStmt(p, n);
}

/** `left` or `left as right`, dropping the `as` when the names coincide. The rename-aware
 *  side is the LOCAL binding; the external name (source export / export alias) is verbatim. */
function emitAsClause(p: Printer, leftName: string, rightName: string): void {
    write(p, leftName);
    if (leftName !== rightName) {
        space(p);
        write(p, 'as');
        space(p);
        write(p, rightName);
    }
}

function emitNamedGroup(p: Printer, specs: Node[], bindingKind: 'import' | 'export'): void {
    write(p, '{');
    softSpace(p);
    for (let i = 0; i < specs.length; i++) {
        if (i > 0) {
            write(p, ',');
            softSpace(p);
        }
        const sd = data(specs[i]);
        if (bindingKind === 'import') {
            // `import { imported as local }` — external `imported` verbatim, local renamed.
            emitAsClause(p, (sd.imported as Node).name, p.nameOf(sd.local as Node));
        } else {
            // `export { local as exported }` — local renamed, external `exported` verbatim.
            emitAsClause(p, p.nameOf(sd.local as Node), (sd.exported as Node).name);
        }
    }
    softSpace(p);
    write(p, '}');
}

function emitImportDeclaration(p: Printer, n: Node): void {
    const d = data(n);
    // In a bundle, every import is hoisted to chunk-level wiring — drop the statement.
    if (p.linkModule) return;
    // `import type { … }` — the whole import is erased in strip mode.
    if (d.importKind === 'type') return;
    const specs = d.specifiers as Node[];
    if (specs.length === 0) {
        // Side-effect import: `import 'x';`
        write(p, 'import');
        softSpace(p);
        write(p, (d.source as Node).name);
        semi(p);
        return;
    }
    const def = specs.find((s) => s.type === N.ImportDefaultSpecifier);
    const ns = specs.find((s) => s.type === N.ImportNamespaceSpecifier);
    // `import { a, type b }` — drop the type-only specifiers.
    const named = specs.filter((s) => s.type === N.ImportSpecifier && data(s).importKind !== 'type');
    // Everything that survived stripping was type-only → erase the statement.
    if (!def && !ns && named.length === 0) return;
    write(p, 'import');
    space(p);
    let wrote = false;
    if (def) {
        write(p, p.nameOf(data(def).local as Node));
        wrote = true;
    }
    if (ns) {
        if (wrote) {
            write(p, ',');
            softSpace(p);
        }
        write(p, '*');
        space(p);
        write(p, 'as');
        space(p);
        write(p, p.nameOf(data(ns).local as Node));
        wrote = true;
    }
    if (named.length > 0) {
        if (wrote) {
            write(p, ',');
            softSpace(p);
        }
        emitNamedGroup(p, named, 'import');
    }
    space(p);
    write(p, 'from');
    softSpace(p);
    write(p, (d.source as Node).name);
    semi(p);
}

/** `interface`/`type`/`declare`d declarations carry no runtime code. */
const isTypeOnlyDeclaration = (decl: Node): boolean =>
    decl.type === N.TSInterfaceDeclaration || decl.type === N.TSTypeAliasDeclaration || (data(decl).declare as boolean) === true;

function emitExportNamed(p: Printer, n: Node): void {
    const d = data(n);
    // `export type { … }` / `export type X = …` — erased in strip mode.
    if (d.exportKind === 'type') return;
    const decl = d.declaration as Node | null;
    if (decl) {
        if (isTypeOnlyDeclaration(decl)) return;
        // Link mode: keep the declaration, drop the `export` keyword (the binding is
        // re-exported by the chunk's own export line).
        if (!p.linkModule) {
            write(p, 'export');
            space(p);
        }
        printStmt(p, decl);
        return;
    }
    // Bare re-export (`export { a, b }`) — resolved at chunk level in link mode.
    if (p.linkModule) return;
    // `export { a, type b }` — drop the type-only specifiers; erase if none remain.
    const specs = (d.specifiers as Node[]).filter((s) => data(s).exportKind !== 'type');
    const source = d.source as Node | null;
    if (specs.length === 0 && !source) return;
    write(p, 'export');
    softSpace(p);
    emitNamedGroup(p, specs, 'export');
    if (source) {
        space(p);
        write(p, 'from');
        softSpace(p);
        write(p, source.name);
    }
    semi(p);
}

/** A whole statement erased in strip mode: type declarations, `declare` ambients, and
 *  type-only imports/exports (mirrors emit.ts `isErasableStatement`, `src/emit.ts:629`). */
function isErasedStmt(n: Node): boolean {
    const d = data(n);
    switch (n.type) {
        case N.TSInterfaceDeclaration:
        case N.TSTypeAliasDeclaration:
            return true;
        case N.FunctionDeclaration:
            // `declare function`, or a body-less TS overload signature (the implementation carries the body).
            return (d.declare as boolean) === true || d.body === null;
        case N.ClassDeclaration:
        case N.VariableDeclaration:
        case N.TSModuleDeclaration:
        case N.TSEnumDeclaration:
            return (d.declare as boolean) === true;
        case N.ImportDeclaration:
            return d.importKind === 'type';
        case N.ExportNamedDeclaration:
            return d.exportKind === 'type';
        default:
            return false;
    }
}

/** In link mode a statement can vanish entirely (dropped import, bare re-export) — detecting
 *  that up front lets the top-level loop skip its separator so no blank line is left behind. */
function emitsNothing(p: Printer, n: Node): boolean {
    if (isErasedStmt(n)) return true;
    if (!p.linkModule) return false;
    if (n.type === N.ImportDeclaration || n.type === N.ExportAllDeclaration) return true;
    if (n.type === N.ExportNamedDeclaration) return (data(n).declaration as Node | null) === null;
    return false;
}

export function printStmt(p: Printer, n: Node): void {
    if (isErasedStmt(n)) return;
    mark(p, n);
    const d = data(n);
    switch (n.type) {
        case N.Program: {
            const body = d.body as Node[];
            let emitted = false;
            for (const s of body) {
                if (p.live !== null && !p.live.has(s.id)) continue; // tree-shaken (top-level only)
                if (emitsNothing(p, s)) continue;
                if (emitted) softNewline(p);
                printStmt(p, s);
                emitted = true;
            }
            dropTrailingSemi(p); // module ends — trailing `;` is redundant
            return;
        }
        case N.ExpressionStatement: {
            const expr = d.expression as Node;
            parens(p, exprStmtNeedsParens(expr), () => printExpr(p, expr, Prec.Lowest));
            semi(p);
            return;
        }
        case N.VariableDeclaration:
            printVarDecl(p, n, true);
            return;
        case N.BlockStatement:
            printBlock(p, n);
            return;
        case N.EmptyStatement:
            semi(p);
            return;
        case N.DebuggerStatement:
            write(p, 'debugger');
            semi(p);
            return;
        case N.ReturnStatement: {
            write(p, 'return');
            const arg = d.argument as Node | null;
            if (arg) {
                space(p);
                printExpr(p, arg, Prec.Lowest);
            }
            semi(p);
            return;
        }
        case N.ThrowStatement:
            write(p, 'throw');
            space(p);
            printExpr(p, d.argument as Node, Prec.Lowest);
            semi(p);
            return;
        case N.BreakStatement:
        case N.ContinueStatement: {
            write(p, n.type === N.BreakStatement ? 'break' : 'continue');
            const label = d.label as Node | null;
            if (label) {
                space(p);
                write(p, label.name);
            }
            semi(p);
            return;
        }
        case N.LabeledStatement:
            write(p, (d.label as Node).name);
            write(p, ':');
            softSpace(p);
            printStmt(p, d.body as Node);
            return;
        case N.IfStatement: {
            write(p, 'if');
            softSpace(p);
            write(p, '(');
            printExpr(p, d.test as Node, Prec.Lowest);
            write(p, ')');
            printClause(p, d.consequent as Node);
            const alt = d.alternate as Node | null;
            if (alt) {
                softNewline(p);
                write(p, 'else');
                printClause(p, alt, true);
            }
            return;
        }
        case N.WhileStatement:
            write(p, 'while');
            softSpace(p);
            write(p, '(');
            printExpr(p, d.test as Node, Prec.Lowest);
            write(p, ')');
            printClause(p, d.body as Node);
            return;
        case N.DoWhileStatement:
            write(p, 'do');
            printClause(p, d.body as Node, true);
            softSpace(p);
            write(p, 'while');
            softSpace(p);
            write(p, '(');
            printExpr(p, d.test as Node, Prec.Lowest);
            write(p, ')');
            semi(p);
            return;
        case N.ForStatement: {
            write(p, 'for');
            softSpace(p);
            write(p, '(');
            const init = d.init as Node | null;
            if (init) {
                if (init.type === N.VariableDeclaration) printVarDecl(p, init, false);
                else printExpr(p, init, Prec.Lowest);
            }
            write(p, ';');
            const test = d.test as Node | null;
            if (test) {
                softSpace(p);
                printExpr(p, test, Prec.Lowest);
            }
            write(p, ';');
            const update = d.update as Node | null;
            if (update) {
                softSpace(p);
                printExpr(p, update, Prec.Lowest);
            }
            write(p, ')');
            printClause(p, d.body as Node);
            return;
        }
        case N.ForInStatement:
        case N.ForOfStatement: {
            write(p, 'for');
            if (n.type === N.ForOfStatement && (d.await as boolean)) {
                space(p);
                write(p, 'await');
            }
            softSpace(p);
            write(p, '(');
            const left = d.left as Node;
            if (left.type === N.VariableDeclaration) printVarDecl(p, left, false);
            else printExpr(p, left, Prec.Lowest);
            space(p);
            write(p, n.type === N.ForInStatement ? 'in' : 'of');
            space(p);
            printExpr(p, d.right as Node, Prec.Assign);
            write(p, ')');
            printClause(p, d.body as Node);
            return;
        }
        case N.FunctionDeclaration:
            emitFunction(p, n);
            return;
        case N.ClassDeclaration:
            emitClass(p, n);
            return;
        case N.ImportDeclaration:
            emitImportDeclaration(p, n);
            return;
        case N.ExportNamedDeclaration:
            emitExportNamed(p, n);
            return;
        case N.ExportDefaultDeclaration: {
            const decl = d.declaration as Node;
            const isDeclKind = decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration;
            if (p.linkModule) {
                // Named `export default function f(){}` keeps its binding; anonymous forms
                // become `const <defaultName> = <value>;` (mirrors moduleEdits, bundle.ts:334).
                if (isDeclKind && (data(decl).id as Node | null) !== null) {
                    printStmt(p, decl);
                } else {
                    write(p, 'const');
                    space(p);
                    write(p, p.defaultName ? p.defaultName() : '_default');
                    softSpace(p);
                    write(p, '=');
                    softSpace(p);
                    if (decl.type === N.FunctionDeclaration) emitFunction(p, decl);
                    else if (decl.type === N.ClassDeclaration) emitClass(p, decl);
                    else printExpr(p, decl, Prec.Assign);
                    semi(p);
                }
                return;
            }
            write(p, 'export');
            space(p);
            write(p, 'default');
            if (isDeclKind) {
                space(p);
                printStmt(p, decl);
            } else {
                space(p);
                printExpr(p, decl, Prec.Assign);
                semi(p);
            }
            return;
        }
        case N.ExportAllDeclaration: {
            // Bundled star re-exports are resolved at chunk level.
            if (p.linkModule) return;
            write(p, 'export');
            softSpace(p);
            write(p, '*');
            const exported = d.exported as Node | null;
            if (exported) {
                space(p);
                write(p, 'as');
                space(p);
                write(p, exported.name);
            }
            space(p);
            write(p, 'from');
            softSpace(p);
            write(p, (d.source as Node).name);
            semi(p);
            return;
        }
        case N.TSEnumDeclaration:
            emitEnum(p, n);
            return;
        case N.TryStatement: {
            write(p, 'try');
            printClause(p, d.block as Node, true);
            const handler = d.handler as Node | null;
            if (handler) {
                const hd = data(handler);
                softSpace(p);
                write(p, 'catch');
                const param = hd.param as Node | null;
                if (param) {
                    softSpace(p);
                    write(p, '(');
                    emitExpr(p, param);
                    write(p, ')');
                }
                printClause(p, hd.body as Node, true);
            }
            const finalizer = d.finalizer as Node | null;
            if (finalizer) {
                softSpace(p);
                write(p, 'finally');
                printClause(p, finalizer, true);
            }
            return;
        }
        case N.SwitchStatement: {
            write(p, 'switch');
            softSpace(p);
            write(p, '(');
            printExpr(p, d.discriminant as Node, Prec.Lowest);
            write(p, ')');
            softSpace(p);
            write(p, '{');
            p.indent++;
            for (const c of d.cases as Node[]) {
                const cd = data(c);
                softNewline(p);
                const test = cd.test as Node | null;
                if (test) {
                    write(p, 'case');
                    space(p);
                    printExpr(p, test, Prec.Lowest);
                } else {
                    write(p, 'default');
                }
                write(p, ':');
                p.indent++;
                for (const s of cd.consequent as Node[]) {
                    softNewline(p);
                    printStmt(p, s);
                }
                p.indent--;
            }
            dropTrailingSemi(p); // last case body's `;` is redundant before `}`
            p.indent--;
            softNewline(p);
            write(p, '}');
            return;
        }
        default:
            throw new Error(`printer: unsupported statement node ${TYPE_NAME[n.type] ?? n.type}`);
    }
}

/** Entry point: print a whole module Program. */
export function printModule(p: Printer, program: Node): void {
    printStmt(p, program);
}
