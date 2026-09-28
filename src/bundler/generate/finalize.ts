// The module finalizer: a module's statements as they stand in its chunk, built as a new AST.
//
// rolldown's `module_finalizers` rewrites the module AST in place before codegen. shakeup builds a copy
// instead, because the module AST is cached across builds. The copy is what the printer prints and what
// the chunk's dead-code pass runs over: imports dropped (or replaced by what evaluates their target),
// exports unwrapped, shaken statements and declarators left out, every binding under its final name, and
// the linker's rewrites and inlined constants in place.

import type { ConstantValue } from '../../analysis/constant-value.ts';
import { cloneNode, N, type Node, node, UNSPANNED, walk } from '../../ast/index.ts';
import { parse } from '../../parser/index.ts';
import { preservedClassName } from '../../print/print-js.ts';

export type FinalizeRules = {
    /** The final name of an identifier that names a symbol. */
    nameOf: (identifier: Node) => string;
    /** Top-level statement and declarator ids kept by treeshake. null keeps everything. */
    live: Set<number> | null;
    /** Code that evaluates a lazily initialised target, in place of the import or re-export statement
     *  that depends on it. */
    initCalls: Map<Node, string>;
    /** The linker's rewrites of single nodes: dynamic `import()` targets, `require` calls, namespace
     *  member reads, enum members, asset URLs, top-level `this`. */
    overrides: Map<Node, string>;
    /** Reads replaced by their constant value (`inlineConst`). */
    constants: Map<Node, ConstantValue> | null;
    /** The binding an anonymous `export default` is declared as. */
    defaultName: () => string;
    /** Keep a renamed class's `.name` (`output.keepNames`). */
    keepNames: boolean;
    /** Added to every source position, placing the module in a combined source. */
    offset: number;
};

type Finalizer = {
    rules: FinalizeRules;
    /** Inside a class body whose original name is kept, this symbol reads by that name: the outer
     *  binding is still uninitialised while a static initialiser runs. 0 when none. */
    originalNameSym: number;
    substitute: (source: Node) => Node | null;
};

const isModuleStatement = (statement: Node): boolean =>
    statement.type === N.ImportDeclaration ||
    statement.type === N.ExportNamedDeclaration ||
    statement.type === N.ExportDefaultDeclaration ||
    statement.type === N.ExportAllDeclaration;

const isLive = (rules: FinalizeRules, statement: Node): boolean => rules.live === null || rules.live.has(statement.id);

/** Give `root` the position `start..end` and leave everything inside it unmapped. */
function placeAt(root: Node, start: number, end: number): Node {
    walk(root, (inner) => {
        (inner as { start: number; end: number }).start = UNSPANNED;
        (inner as { start: number; end: number }).end = UNSPANNED;
    });
    (root as { start: number; end: number }).start = start;
    (root as { start: number; end: number }).end = end;
    return root;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Words the parser reads as something other than an identifier reference. */
const RESERVED = new Set([
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'new',
    'null',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
]);

const isPlainName = (text: string): boolean => IDENTIFIER.test(text) && !RESERVED.has(text);

/** `name` or `name.member.member`, built directly: most of the linker's text is one of these. */
function nameChainFromText(text: string, start: number, end: number): Node | null {
    const names = text.split('.');
    if (!names.every(isPlainName)) return null;
    let expression = node(
        N.IdentifierReference,
        names.length === 1 ? start : UNSPANNED,
        names.length === 1 ? end : UNSPANNED,
        names[0],
        null,
    );
    for (let index = 1; index < names.length; index++) {
        const last = index === names.length - 1;
        const property = node(N.IdentifierName, UNSPANNED, UNSPANNED, names[index], null);
        expression = node(N.StaticMemberExpression, last ? start : UNSPANNED, last ? end : UNSPANNED, '', {
            object: expression,
            property,
            optional: false,
        });
    }
    return expression;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** The linker's text for an expression, parsed, standing at `at`'s position as the text did. */
function expressionFromText(finalizer: Finalizer, text: string, at: Node): Node {
    const start = at.start + finalizer.rules.offset;
    const end = at.end + finalizer.rules.offset;
    // An enum member's value, the commonest text of all.
    if (DECIMAL.test(text)) return node(N.NumericLiteral, start, end, text, null);
    const chain = nameChainFromText(text, start, end);
    if (chain !== null) return chain;
    const program = parse(`(${text});`, { ts: false, jsx: false, kind: 'module', comments: false }).program;
    const statement = (program.data as { body: Node[] }).body[0];
    const expression = (statement.data as { expression: Node }).expression;
    return placeAt(expression, start, end);
}

/** The linker's text for statements, parsed, each standing at `at`'s position as the text did. */
function statementsFromText(finalizer: Finalizer, text: string, at: Node): Node[] {
    const program = parse(text, { ts: false, jsx: false, kind: 'module', comments: false }).program;
    const statements = (program.data as { body: Node[] }).body;
    for (const statement of statements) placeAt(statement, at.start + finalizer.rules.offset, at.end + finalizer.rules.offset);
    return statements;
}

/** A constant as the literal rolldown's finalizer swaps in; the printer prints it from its value. */
function constantExpression(value: ConstantValue, start: number, end: number): Node {
    switch (value.kind) {
        case 'number':
            return node(N.NumericLiteral, start, end, Object.is(value.value, -0) ? '-0' : String(value.value), null);
        case 'bigint':
            return node(N.BigIntLiteral, start, end, `${value.value}n`, null);
        case 'string':
            return node(N.StringLiteral, start, end, JSON.stringify(value.value), null);
        case 'boolean':
            return node(N.BooleanLiteral, start, end, value.value ? 'true' : 'false', null);
        case 'null':
            return node(N.NullLiteral, start, end, 'null', null);
        case 'undefined': {
            const zero = node(N.NumericLiteral, UNSPANNED, UNSPANNED, '0', null);
            return node(N.UnaryExpression, start, end, '', { operator: 'void', prefix: true, argument: zero });
        }
    }
}

const copy = (finalizer: Finalizer, source: Node): Node =>
    cloneNode(source, finalizer.substitute, finalizer.rules.offset) as Node;

const copyOrNull = (finalizer: Finalizer, source: Node | null): Node | null => (source === null ? null : copy(finalizer, source));

function renamedIdentifier(finalizer: Finalizer, source: Node): Node {
    const name = source.sym !== 0 && source.sym === finalizer.originalNameSym ? source.name : finalizer.rules.nameOf(source);
    // A CommonJS export the importer reads off the interop namespace: `import_x.name`.
    if (source.type === N.IdentifierReference && name.includes('.')) return expressionFromText(finalizer, name, source);
    const offset = finalizer.rules.offset;
    return node(source.type, source.start + offset, source.end + offset, name, null);
}

/** `{ x }` keeps its shorthand only while the value still reads `x`. */
function finalizeProperty(finalizer: Finalizer, property: Node): Node | null {
    const data = property.data as { key: Node; value: Node; shorthand: boolean };
    if (!data.shorthand) return null;
    const value = data.value;
    const binding = value.type === N.AssignmentPattern ? (value.data as { left: Node }).left : value;
    const constant = finalizer.rules.constants?.get(value) !== undefined;
    if (!constant && finalizer.rules.nameOf(binding) === binding.name) return null;
    const offset = finalizer.rules.offset;
    return node(N.ObjectProperty, property.start + offset, property.end + offset, property.name, {
        ...(property.data as object),
        key: copy(finalizer, data.key),
        value: copy(finalizer, value),
        shorthand: false,
    } as never);
}

/** A class as an expression named `name`, its body read under the original name when `ownSym` is set. */
function classExpression(finalizer: Finalizer, source: Node, name: string, ownSym: number): Node {
    const data = source.data as {
        decorators: Node[];
        typeParameters: Node | null;
        superClass: Node | null;
        superTypeArguments: Node | null;
        implements: Node[];
        body: Node[];
    };
    const previous = finalizer.originalNameSym;
    finalizer.originalNameSym = ownSym;
    const body = data.body.map((member) => copy(finalizer, member));
    finalizer.originalNameSym = previous;
    return node(N.ClassExpression, UNSPANNED, UNSPANNED, '', {
        decorators: data.decorators.map((decorator) => copy(finalizer, decorator)),
        id: node(N.BindingIdentifier, UNSPANNED, UNSPANNED, name, null),
        typeParameters: copyOrNull(finalizer, data.typeParameters),
        superClass: copyOrNull(finalizer, data.superClass),
        superTypeArguments: copyOrNull(finalizer, data.superTypeArguments),
        implements: data.implements.map((clause) => copy(finalizer, clause)),
        body,
        scopeId: 0,
    });
}

/** A renamed class declaration as `let <new> = class <original> {}`, which keeps `.name` (Rollup's
 *  `ClassDeclaration.render`). */
function finalizeClassDeclaration(finalizer: Finalizer, declaration: Node): Node | null {
    const id = (declaration.data as { id: Node | null }).id;
    const original = preservedClassName(finalizer.rules.keepNames, finalizer.rules.nameOf, id, declaration);
    if (original === null || id === null) return null;
    const offset = finalizer.rules.offset;
    const declarator = node(N.VariableDeclarator, UNSPANNED, UNSPANNED, '', {
        id: node(N.BindingIdentifier, UNSPANNED, UNSPANNED, finalizer.rules.nameOf(id), null),
        typeAnnotation: null,
        init: classExpression(finalizer, declaration, original, id.sym),
        definite: false,
    });
    return node(N.VariableDeclaration, declaration.start + offset, declaration.end + offset, '', {
        declarations: [declarator],
        kind: 'let',
        declare: false,
    });
}

/** `let foo$1 = class {}` names the class `foo`, which keeps `.name` (Rollup's `VariableDeclarator.render`). */
function finalizeDeclarator(finalizer: Finalizer, declarator: Node): Node | null {
    const data = declarator.data as { id: Node; typeAnnotation: Node | null; init: Node | null; definite: boolean };
    const init = data.init;
    if (init === null || init.type !== N.ClassExpression || (init.data as { id: Node | null }).id !== null) return null;
    if (data.id.type !== N.BindingIdentifier) return null;
    const original = preservedClassName(finalizer.rules.keepNames, finalizer.rules.nameOf, data.id, init);
    if (original === null) return null;
    const offset = finalizer.rules.offset;
    return node(N.VariableDeclarator, declarator.start + offset, declarator.end + offset, '', {
        id: copy(finalizer, data.id),
        typeAnnotation: copyOrNull(finalizer, data.typeAnnotation),
        init: classExpression(finalizer, init, original, 0),
        definite: data.definite,
    });
}

/** A block holding module statements, which only a module body wrapped in a closure does. */
function finalizeBlock(finalizer: Finalizer, block: Node): Node | null {
    const body = (block.data as { body: Node[] }).body;
    if (!body.some(isModuleStatement)) return null;
    const statements: Node[] = [];
    for (const statement of body) finalizeStatementInto(finalizer, statement, statements, false);
    const offset = finalizer.rules.offset;
    return node(N.BlockStatement, block.start + offset, block.end + offset, '', { body: statements, scopeId: 0 });
}

function substituteFor(finalizer: Finalizer): (source: Node) => Node | null {
    const rules = finalizer.rules;
    return (source) => {
        const text = rules.overrides.get(source);
        if (text !== undefined) return expressionFromText(finalizer, text, source);
        if (rules.constants !== null) {
            const value = rules.constants.get(source);
            if (value !== undefined) return constantExpression(value, source.start + rules.offset, source.end + rules.offset);
        }
        switch (source.type) {
            case N.IdentifierReference:
            case N.BindingIdentifier:
                return renamedIdentifier(finalizer, source);
            case N.ObjectProperty:
                return finalizeProperty(finalizer, source);
            case N.ClassDeclaration:
                return finalizeClassDeclaration(finalizer, source);
            case N.VariableDeclarator:
                return finalizeDeclarator(finalizer, source);
            case N.BlockStatement:
                return finalizeBlock(finalizer, source);
            default:
                return null;
        }
    };
}

/** `declaration` standing where `at` stood: an unwrapped export keeps the export statement's position,
 *  which is where its comments and its mapping are anchored. */
function standingAt(declaration: Node, at: Node, offset: number): Node {
    (declaration as { start: number }).start = at.start + offset;
    return declaration;
}

/** A top-level `var`/`let`/`const` with only the declarators treeshake kept. */
function liveDeclarators(finalizer: Finalizer, declaration: Node): Node {
    const live = finalizer.rules.live;
    const data = declaration.data as { declarations: Node[] };
    if (live === null || data.declarations.every((declarator) => live.has(declarator.id))) return copy(finalizer, declaration);
    const offset = finalizer.rules.offset;
    return node(N.VariableDeclaration, declaration.start + offset, declaration.end + offset, declaration.name, {
        ...(declaration.data as object),
        declarations: data.declarations
            .filter((declarator) => live.has(declarator.id))
            .map((declarator) => copy(finalizer, declarator)),
    } as never);
}

/** `export default <anonymous>` as `const <defaultName> = <value>`. */
function defaultExportDeclaration(finalizer: Finalizer, statement: Node, declaration: Node): Node {
    const offset = finalizer.rules.offset;
    let value: Node;
    if (declaration.type === N.FunctionDeclaration || declaration.type === N.ClassDeclaration) {
        const { declare: _declare, abstract: _abstract, ...rest } = declaration.data as Record<string, unknown>;
        const expressionType = declaration.type === N.FunctionDeclaration ? N.FunctionExpression : N.ClassExpression;
        const expression = node(expressionType, declaration.start, declaration.end, declaration.name, rest as never);
        value = copy(finalizer, expression);
        (value as { start: number; end: number }).start = UNSPANNED;
        (value as { start: number; end: number }).end = UNSPANNED;
    } else value = copy(finalizer, declaration);
    const declarator = node(N.VariableDeclarator, UNSPANNED, UNSPANNED, '', {
        id: node(N.BindingIdentifier, UNSPANNED, UNSPANNED, finalizer.rules.defaultName(), null),
        typeAnnotation: null,
        init: value,
        definite: false,
    });
    return node(N.VariableDeclaration, statement.start + offset, statement.end + offset, '', {
        declarations: [declarator],
        kind: 'const',
        declare: false,
    });
}

/** Append what `statement` becomes in the chunk. `top` marks the module's own top level, where treeshake
 *  decided declarators individually. */
function finalizeStatementInto(finalizer: Finalizer, statement: Node, out: Node[], top: boolean): void {
    const rules = finalizer.rules;
    const initCall = rules.initCalls.get(statement);
    switch (statement.type) {
        case N.ImportDeclaration:
        case N.ExportAllDeclaration:
            if (initCall !== undefined) out.push(...statementsFromText(finalizer, initCall, statement));
            return;
        case N.ExportNamedDeclaration: {
            if (initCall !== undefined) {
                out.push(...statementsFromText(finalizer, initCall, statement));
                return;
            }
            const declaration = (statement.data as { declaration: Node | null }).declaration;
            if (declaration === null) return;
            const finalized =
                top && declaration.type === N.VariableDeclaration
                    ? liveDeclarators(finalizer, declaration)
                    : copy(finalizer, declaration);
            out.push(standingAt(finalized, statement, rules.offset));
            return;
        }
        case N.ExportDefaultDeclaration: {
            const declaration = (statement.data as { declaration: Node }).declaration;
            const named =
                (declaration.type === N.FunctionDeclaration || declaration.type === N.ClassDeclaration) &&
                (declaration.data as { id: Node | null }).id !== null;
            out.push(
                named
                    ? standingAt(copy(finalizer, declaration), statement, rules.offset)
                    : defaultExportDeclaration(finalizer, statement, declaration),
            );
            return;
        }
        case N.VariableDeclaration:
            out.push(top ? liveDeclarators(finalizer, statement) : copy(finalizer, statement));
            return;
        default:
            out.push(copy(finalizer, statement));
    }
}

/**
 * The statements `body` becomes in the chunk, in order. A statement that evaluates a lazily initialised
 * module goes first, as a block: a static import evaluates its target before any of the importer's
 * body runs, whatever line it sits on.
 */
export function finalizeStatements(body: Node[], rules: FinalizeRules): Node[] {
    const finalizer: Finalizer = { rules, originalNameSym: 0, substitute: () => null };
    finalizer.substitute = substituteFor(finalizer);
    const out: Node[] = [];
    for (const statement of body) {
        const initCall = rules.initCalls.get(statement);
        if (initCall === undefined || !isLive(rules, statement)) continue;
        out.push(...statementsFromText(finalizer, initCall, statement));
    }
    for (const statement of body) {
        if (rules.initCalls.has(statement) || !isLive(rules, statement)) continue;
        finalizeStatementInto(finalizer, statement, out, true);
    }
    return out;
}
