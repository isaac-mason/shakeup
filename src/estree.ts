import type { AST_NODE_TYPES } from '@typescript-eslint/types';
import { CHILD_FIELDS, N, type Node, NODE_TYPE_NAMES, TYPE_COUNT, type TypeName } from './ast/index.ts';
import { decodeJSXEntities } from './jsx-text.ts';

type ESTreeTypeName = `${AST_NODE_TYPES}`;

/** ESTree type name per shakeup type; `null` marks types with no ESTree counterpart. */
export const ESTREE_NAME = {
    Program: 'Program',
    BindingIdentifier: 'Identifier',
    IdentifierReference: 'Identifier',
    IdentifierName: 'Identifier',
    LabelIdentifier: 'Identifier',
    PrivateIdentifier: 'PrivateIdentifier',
    NumericLiteral: 'Literal',
    StringLiteral: 'Literal',
    BooleanLiteral: 'Literal',
    NullLiteral: 'Literal',
    RegExpLiteral: 'Literal',
    BigIntLiteral: 'Literal',
    TemplateElement: 'TemplateElement',
    ThisExpression: 'ThisExpression',
    Super: 'Super',
    ImportMeta: 'MetaProperty',
    NewTarget: 'MetaProperty',
    TemplateLiteral: 'TemplateLiteral',
    TaggedTemplateExpression: 'TaggedTemplateExpression',
    ArrayExpression: 'ArrayExpression',
    ObjectExpression: 'ObjectExpression',
    ObjectProperty: 'Property',
    SpreadElement: 'SpreadElement',
    BinaryExpression: 'BinaryExpression',
    LogicalExpression: 'LogicalExpression',
    AssignmentExpression: 'AssignmentExpression',
    UnaryExpression: 'UnaryExpression',
    UpdateExpression: 'UpdateExpression',
    ConditionalExpression: 'ConditionalExpression',
    CallExpression: 'CallExpression',
    NewExpression: 'NewExpression',
    StaticMemberExpression: 'MemberExpression',
    ComputedMemberExpression: 'MemberExpression',
    PrivateFieldExpression: 'MemberExpression',
    ChainExpression: 'ChainExpression',
    SequenceExpression: 'SequenceExpression',
    ArrowFunctionExpression: 'ArrowFunctionExpression',
    FunctionExpression: 'FunctionExpression',
    ClassExpression: 'ClassExpression',
    YieldExpression: 'YieldExpression',
    AwaitExpression: 'AwaitExpression',
    ImportExpression: 'ImportExpression',
    ExpressionStatement: 'ExpressionStatement',
    VariableDeclaration: 'VariableDeclaration',
    VariableDeclarator: 'VariableDeclarator',
    BlockStatement: 'BlockStatement',
    IfStatement: 'IfStatement',
    ForStatement: 'ForStatement',
    ForInStatement: 'ForInStatement',
    ForOfStatement: 'ForOfStatement',
    WhileStatement: 'WhileStatement',
    DoWhileStatement: 'DoWhileStatement',
    SwitchStatement: 'SwitchStatement',
    SwitchCase: 'SwitchCase',
    TryStatement: 'TryStatement',
    CatchClause: 'CatchClause',
    ReturnStatement: 'ReturnStatement',
    ThrowStatement: 'ThrowStatement',
    BreakStatement: 'BreakStatement',
    ContinueStatement: 'ContinueStatement',
    LabeledStatement: 'LabeledStatement',
    EmptyStatement: 'EmptyStatement',
    DebuggerStatement: 'DebuggerStatement',
    FunctionDeclaration: 'FunctionDeclaration',
    ClassDeclaration: 'ClassDeclaration',
    MethodDefinition: 'MethodDefinition',
    PropertyDefinition: 'PropertyDefinition',
    StaticBlock: 'StaticBlock',
    ObjectPattern: 'ObjectPattern',
    ArrayPattern: 'ArrayPattern',
    AssignmentPattern: 'AssignmentPattern',
    RestElement: 'RestElement',
    FormalParameter: null,
    ImportDeclaration: 'ImportDeclaration',
    ImportAttribute: 'ImportAttribute',
    ImportSpecifier: 'ImportSpecifier',
    ImportDefaultSpecifier: 'ImportDefaultSpecifier',
    ImportNamespaceSpecifier: 'ImportNamespaceSpecifier',
    ExportNamedDeclaration: 'ExportNamedDeclaration',
    ExportSpecifier: 'ExportSpecifier',
    ExportDefaultDeclaration: 'ExportDefaultDeclaration',
    ExportAllDeclaration: 'ExportAllDeclaration',
    TSTypeAnnotation: 'TSTypeAnnotation',
    TSAnyKeyword: 'TSAnyKeyword',
    TSStringKeyword: 'TSStringKeyword',
    TSNumberKeyword: 'TSNumberKeyword',
    TSBooleanKeyword: 'TSBooleanKeyword',
    TSBigIntKeyword: 'TSBigIntKeyword',
    TSSymbolKeyword: 'TSSymbolKeyword',
    TSObjectKeyword: 'TSObjectKeyword',
    TSVoidKeyword: 'TSVoidKeyword',
    TSUndefinedKeyword: 'TSUndefinedKeyword',
    TSNullKeyword: 'TSNullKeyword',
    TSNeverKeyword: 'TSNeverKeyword',
    TSUnknownKeyword: 'TSUnknownKeyword',
    TSIntrinsicKeyword: 'TSIntrinsicKeyword',
    TSThisType: 'TSThisType',
    TSTypeReference: 'TSTypeReference',
    TSQualifiedName: 'TSQualifiedName',
    TSTypeParameterInstantiation: 'TSTypeParameterInstantiation',
    TSTypeParameterDeclaration: 'TSTypeParameterDeclaration',
    TSTypeParameter: 'TSTypeParameter',
    TSTupleType: 'TSTupleType',
    TSNamedTupleMember: 'TSNamedTupleMember',
    TSTypeLiteral: 'TSTypeLiteral',
    TSPropertySignature: 'TSPropertySignature',
    TSMethodSignature: 'TSMethodSignature',
    TSIndexSignature: 'TSIndexSignature',
    TSCallSignatureDeclaration: 'TSCallSignatureDeclaration',
    TSConstructSignatureDeclaration: 'TSConstructSignatureDeclaration',
    TSUnionType: 'TSUnionType',
    TSIntersectionType: 'TSIntersectionType',
    TSFunctionType: 'TSFunctionType',
    TSConstructorType: 'TSConstructorType',
    TSArrayType: 'TSArrayType',
    TSIndexedAccessType: 'TSIndexedAccessType',
    TSTypeOperator: 'TSTypeOperator',
    TSTypeQuery: 'TSTypeQuery',
    TSConditionalType: 'TSConditionalType',
    TSInferType: 'TSInferType',
    TSMappedType: 'TSMappedType',
    TSLiteralType: 'TSLiteralType',
    TSTemplateLiteralType: 'TSTemplateLiteralType',
    TSImportType: 'TSImportType',
    TSInterfaceDeclaration: 'TSInterfaceDeclaration',
    TSClassImplements: 'TSClassImplements',
    TSInterfaceHeritage: 'TSInterfaceHeritage',
    TSTypeAliasDeclaration: 'TSTypeAliasDeclaration',
    TSEnumDeclaration: 'TSEnumDeclaration',
    TSEnumMember: 'TSEnumMember',
    TSAsExpression: 'TSAsExpression',
    TSSatisfiesExpression: 'TSSatisfiesExpression',
    TSNonNullExpression: 'TSNonNullExpression',
    TSInstantiationExpression: 'TSInstantiationExpression',
    TSImportEqualsDeclaration: 'TSImportEqualsDeclaration',
    TSExternalModuleReference: 'TSExternalModuleReference',
    TSModuleDeclaration: 'TSModuleDeclaration',
    JSXElement: 'JSXElement',
    JSXOpeningElement: 'JSXOpeningElement',
    JSXClosingElement: 'JSXClosingElement',
    JSXFragment: 'JSXFragment',
    JSXOpeningFragment: 'JSXOpeningFragment',
    JSXClosingFragment: 'JSXClosingFragment',
    JSXNamespacedName: 'JSXNamespacedName',
    JSXMemberExpression: 'JSXMemberExpression',
    JSXExpressionContainer: 'JSXExpressionContainer',
    JSXEmptyExpression: 'JSXEmptyExpression',
    JSXAttribute: 'JSXAttribute',
    JSXSpreadAttribute: 'JSXSpreadAttribute',
    JSXSpreadChild: 'JSXSpreadChild',
    JSXIdentifier: 'JSXIdentifier',
    JSXText: 'JSXText',
} satisfies Record<TypeName, ESTreeTypeName | null>;

/** ESTree type name per numeric type id. */
export const ESTREE_TYPE: string[] = new Array(TYPE_COUNT).fill('');
for (const t of NODE_TYPE_NAMES) ESTREE_TYPE[N[t]] = ESTREE_NAME[t] ?? '';

// ---------------------------------------------------------------------------------------------
// AST -> ESTree
//
// ONE DIRECTION, deliberately — the same choice oxc makes, shipping `serialize/` and an `ESTree`
// trait with no deserializer. A shakeup node carries `id`, `sym` and `scopeId`, and ESTree has
// nowhere to put them. Converting OUT loses nothing that matters: every ESTree field is derived from
// the node. Converting BACK would silently drop the maintained semantic state and force an
// `analyze()` rebuild — which `llm/notes/perf-findings.md` flags as the largest remaining cost in
// the pipeline. If you need a modified AST, do what Rollup does: return modified source, re-parse.
//
// The generic path is driven by `CHILD_FIELDS`, so a node type added to `DEFS` converts with no edit
// here. Only the shapes where ESTree genuinely disagrees are hand-written, and each says why.

/** A plain ESTree node. Deliberately loose — the point is to hand it to tooling that speaks ESTree. */
export type ESTreeNode = { type: string; start: number; end: number; [k: string]: unknown };

/** Carried on shakeup nodes with no ESTree meaning: `scopeId` is maintained semantic state, `pure`
 *  is shakeup's `/*@__PURE__*​/` marker. (`id`/`sym` live on the node, not in `data`.) */
const DROPPED = new Set(['scopeId', 'pure']);

/** field name -> isList, per numeric node type. */
const CHILD_OF: (Map<string, boolean> | undefined)[] = new Array(TYPE_COUNT);
for (const t of NODE_TYPE_NAMES) CHILD_OF[N[t]] = new Map(CHILD_FIELDS[t].map((f) => [f.name, f.list]));

const ident = (name: string, start: number, end: number): ESTreeNode => ({ type: 'Identifier', start, end, name });

/** ESTree fields shakeup does not model, each with the only value it can take here.
 *
 *  `decorators` — the parser rejects decorators outright (`ParseErrorCode.DecoratorsUnsupported`),
 *  so the list is always empty.
 *
 *  `generator` on an arrow — arrows cannot be generators, so ESTree's field is always `false`.
 *
 *  `method` on a Property is the ONE field here that can be wrong. shakeup does not distinguish
 *  `{ m(){} }` from `{ m: function(){} }` — both parse to an ObjectProperty with kind `init` and a
 *  FunctionExpression value — so a genuine shorthand method converts with `method: false`. That gap
 *  is not cosmetic: the printer round-trips the shorthand form INTO the longhand one, which changes
 *  semantics (a method is not constructible and carries a [[HomeObject]] for `super`). Fixing it
 *  means storing the flag on `ObjectProperty`; until then this field is a known lie. */
const CONSTANT_FIELDS: Record<number, Record<string, unknown>> = {
    [N.MethodDefinition]: { decorators: [] },
    [N.PropertyDefinition]: { decorators: [] },
    [N.ArrowFunctionExpression]: { generator: false, id: null },
    [N.ObjectProperty]: { method: false },
};

/** Decode a raw string-literal source text to its value. */
function unquote(raw: string): string {
    const body = raw.slice(1, -1);
    if (!body.includes('\\')) return body;
    // Re-quote single-quoted source as double so `JSON.parse` can do the escape decoding.
    const json = raw[0] === "'" ? `"${body.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"` : raw;
    try {
        return JSON.parse(json) as string;
    } catch {
        return body; // an escape JSON cannot express (`\x41`, `\0`) — raw is still exact
    }
}

/** The ESTree `value` (and any sibling fields) for one of the six literal types. */
function literalFields(n: Node): Record<string, unknown> {
    switch (n.type) {
        case N.NumericLiteral:
            return { value: Number(n.name.replace(/_/g, '')) };
        case N.BooleanLiteral:
            return { value: n.name === 'true' };
        case N.NullLiteral:
            return { value: null };
        case N.BigIntLiteral: {
            const digits = n.name.slice(0, -1).replace(/_/g, '');
            return { value: BigInt(digits), bigint: digits };
        }
        case N.RegExpLiteral: {
            const slash = n.name.lastIndexOf('/');
            const pattern = n.name.slice(1, slash);
            const flags = n.name.slice(slash + 1);
            let value: RegExp | null = null;
            // ESTree's own convention: a regex the host cannot construct serialises as `value: null`.
            try {
                value = new RegExp(pattern, flags);
            } catch {
                value = null;
            }
            return { value, regex: { pattern, flags } };
        }
        default:
            return { value: unquote(n.name) };
    }
}

/** Convert a shakeup AST to ESTree.
 *
 *  `sourceType` is a parameter because shakeup does not store it on `Program` — the goal is decided
 *  by the caller's parse options, not by the tree. */
export function astToEstree(n: Node, sourceType: 'module' | 'script' = 'module'): ESTreeNode {
    const to = (c: Node): ESTreeNode => astToEstree(c, sourceType);
    const { start, end } = n;
    const d = n.data as Record<string, unknown> | null;

    switch (n.type) {
        // Four shakeup identifier types collapse to one ESTree `Identifier`. The distinction
        // (binding / reference / non-binding name / label) is exactly what makes the reverse
        // direction context-sensitive rather than a lookup.
        case N.BindingIdentifier:
        case N.IdentifierReference:
        case N.IdentifierName:
        case N.LabelIdentifier:
            return ident(n.name, start, end);
        case N.JSXIdentifier:
            return { type: 'JSXIdentifier', start, end, name: n.name };
        // ESTree's `value` is the DECODED text (`&amp;` -> `&`); `raw` is the source slice. shakeup
        // stores only the slice, and already owns the decoder the JSX lowering uses.
        case N.JSXText:
            return { type: 'JSXText', start, end, value: decodeJSXEntities(n.name), raw: n.name };
        // The parser stores the name WITHOUT the `#`; ESTree agrees.
        case N.PrivateIdentifier:
            return { type: 'PrivateIdentifier', start, end, name: n.name };

        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.NullLiteral:
        case N.RegExpLiteral:
        case N.BigIntLiteral:
            return { type: 'Literal', start, end, ...literalFields(n), raw: n.name };

        // `import.meta` / `new.target` are one ESTree node with two synthesized identifier halves.
        // shakeup stores neither half, so the spans are the whole node's — there is no sub-span to
        // recover, and no consumer needs one.
        case N.ImportMeta:
            return { type: 'MetaProperty', start, end, meta: ident('import', start, start), property: ident('meta', end, end) };
        case N.NewTarget:
            return { type: 'MetaProperty', start, end, meta: ident('new', start, start), property: ident('target', end, end) };

        // shakeup splits member access three ways by KIND; ESTree has one node with a `computed`
        // flag, and names the property slot `property` in every case.
        case N.StaticMemberExpression:
            return { type: 'MemberExpression', start, end, object: to(d?.object as Node), property: to(d?.property as Node), computed: false, optional: d?.optional as boolean };
        case N.ComputedMemberExpression:
            return { type: 'MemberExpression', start, end, object: to(d?.object as Node), property: to(d?.expression as Node), computed: true, optional: d?.optional as boolean };
        case N.PrivateFieldExpression:
            return { type: 'MemberExpression', start, end, object: to(d?.object as Node), property: to(d?.field as Node), computed: false, optional: d?.optional as boolean };

        // No ESTree counterpart: a parameter is its pattern, or an AssignmentPattern when defaulted.
        // The TS-only fields (`typeAnnotation`, `optional`, `readonly`, `accessibility`) ride on the
        // pattern in @typescript-eslint's AST; carrying them here would need a shape ESTree lacks.
        case N.FormalParameter: {
            const pattern = to(d?.pattern as Node);
            const init = d?.init as Node | null;
            return init === null ? pattern : { type: 'AssignmentPattern', start, end, left: pattern, right: to(init) };
        }

        // ESTree interposes a `ClassBody` node that shakeup does not model — the members hang
        // directly off the class. Synthesized with the members' span.
        case N.ClassDeclaration:
        case N.ClassExpression: {
            const members = (d?.body as Node[]).map(to);
            const bodyStart = members.length > 0 ? (members[0].start as number) : end;
            const bodyEnd = members.length > 0 ? (members[members.length - 1].end as number) : end;
            return {
                type: ESTREE_TYPE[n.type],
                start,
                end,
                id: d?.id === null ? null : to(d?.id as Node),
                superClass: d?.superClass === null ? null : to(d?.superClass as Node),
                body: { type: 'ClassBody', start: bodyStart, end: bodyEnd, body: members },
                decorators: [],
            };
        }

        // ESTree splits each quasi into raw/cooked and marks the last one `tail`. Neither is stored:
        // shakeup keeps the raw slice and the position in the list, so both are derived here.
        case N.TemplateLiteral: {
            const quasis = d?.quasis as Node[];
            return {
                type: 'TemplateLiteral',
                start,
                end,
                quasis: quasis.map((q, i) => templateElement(q, i === quasis.length - 1)),
                expressions: (d?.expressions as Node[]).map(to),
            };
        }

        case N.Program:
            return { type: 'Program', start, end, sourceType, body: (d?.body as Node[]).map(to) };

        // ESTree stores `selfClosing` on the opening element; shakeup does not store it at all,
        // because it is implied — an element with no closing element closed itself. Derived here
        // rather than added to the AST, which is the right split: the fact is already in the tree.
        case N.JSXElement: {
            const opening = to(d?.openingElement as Node);
            opening.selfClosing = d?.closingElement === null;
            return {
                type: 'JSXElement',
                start,
                end,
                openingElement: opening,
                children: (d?.children as Node[]).map(to),
                closingElement: d?.closingElement === null ? null : to(d?.closingElement as Node),
            };
        }

        // Target positions, where the cover grammar has to be resolved ESTree's way — see asPattern.
        // Only `=` can carry a pattern; `+=` and friends require a simple target.
        case N.AssignmentExpression: {
            const left = to(d?.left as Node);
            return {
                type: 'AssignmentExpression',
                start,
                end,
                operator: d?.operator as string,
                left: d?.operator === '=' ? asPattern(left) : left,
                right: to(d?.right as Node),
            };
        }
        case N.ForInStatement:
        case N.ForOfStatement: {
            const left = to(d?.left as Node);
            const out: ESTreeNode = {
                type: ESTREE_TYPE[n.type],
                start,
                end,
                left: left.type === 'VariableDeclaration' ? left : asPattern(left),
                right: to(d?.right as Node),
                body: to(d?.body as Node),
            };
            if (n.type === N.ForOfStatement) out.await = d?.await as boolean;
            return out;
        }

        default:
            break;
    }

    // Generic path: rename the type, recurse into child fields, copy the rest.
    const out: ESTreeNode = { type: ESTREE_TYPE[n.type], start, end, ...CONSTANT_FIELDS[n.type] };
    if (d === null) return out;
    const children = CHILD_OF[n.type];
    for (const key of Object.keys(d)) {
        if (DROPPED.has(key)) continue;
        const v = d[key];
        const list = children?.get(key);
        if (list === undefined) {
            out[key] = v; // a scalar the schema declares (operator, kind, computed, …)
        } else if (list) {
            out[key] = (v as (Node | null)[]).map((c) => (c === null ? null : to(c)));
        } else {
            out[key] = v === null ? null : to(v as Node);
        }
    }
    return out;
}

/** Reinterpret an already-converted expression as the PATTERN ESTree expects in a destructuring
 *  assignment target.
 *
 *  This is the cover grammar. `[a] = x` and `const [a] = x` are the same syntax read two ways, and
 *  the parser deliberately does not re-type the assignment-side one: shakeup keeps it an
 *  `ArrayExpression`, and `lazy-split.ts` `toTarget` performs the same reinterpretation in the other
 *  direction when it needs to. Both are self-consistent, because the printer accepts either.
 *
 *  ESTree is not self-consistent about it — it promises `ArrayPattern`/`ObjectPattern` in target
 *  position — so the PROJECTION owes the conversion, not the parser. Doing it here rather than in
 *  the AST keeps a shakeup-internal decision from leaking into a shakeup-internal representation. */
function asPattern(n: ESTreeNode): ESTreeNode {
    switch (n.type) {
        case 'ArrayExpression':
            return {
                ...n,
                type: 'ArrayPattern',
                elements: (n.elements as (ESTreeNode | null)[]).map((e) => (e === null ? null : asPattern(e))),
            };
        case 'ObjectExpression':
            return {
                ...n,
                type: 'ObjectPattern',
                properties: (n.properties as ESTreeNode[]).map(asPattern),
            };
        // `[...rest] = x` — a spread in target position is a rest element.
        case 'SpreadElement':
            return { ...n, type: 'RestElement', argument: asPattern(n.argument as ESTreeNode) };
        // A property's VALUE is the target; its key is not.
        case 'Property':
            return { ...n, value: asPattern(n.value as ESTreeNode) };
        // `[a = 1] = x` — the default already parsed as an assignment; ESTree calls it a pattern.
        case 'AssignmentExpression':
            return { ...n, type: 'AssignmentPattern', left: asPattern(n.left as ESTreeNode), right: n.right };
        default:
            return n; // Identifier, MemberExpression, AssignmentPattern — already correct
    }
}

/** A `TemplateElement`, which needs its position in the quasi list to know if it is the tail. */
function templateElement(q: Node, tail: boolean): ESTreeNode {
    // `cooked` is the escape-decoded text. shakeup stores only the raw slice (the printer emits it
    // verbatim), so this decodes best-effort and falls back to raw — which is always exact.
    let cooked = q.name;
    if (cooked.includes('\\')) {
        try {
            cooked = JSON.parse(`"${q.name.replace(/(?<!\\)"/g, '\\"').replace(/\n/g, '\\n')}"`) as string;
        } catch {
            cooked = q.name;
        }
    }
    return { type: 'TemplateElement', start: q.start, end: q.end, value: { raw: q.name, cooked }, tail };
}
