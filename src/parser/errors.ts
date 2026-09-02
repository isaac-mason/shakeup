// Centralized parser diagnostics — meriyah's `errors.ts` model.
//
// One numbered code per distinct message. Call sites reference a CODE, not a
// string; the `%0` placeholders carry the runtime-variable parts (the expected
// token text, an offending character). This de-strings the parser: message
// wording lives here in one table, not scattered across `parser.ts`.
import { enumeration } from '../util/enumeration.ts';

export const ParseErrorCode = enumeration(
    // Parameterized (%0 = token text / character).
    'Expected', // every `expected 'X'` — punctuator or keyword — funnels here
    'ExpectedInJSX',
    'UnexpectedChar',
    // Fixed messages.
    'ExpectedIdentifier',
    'ExpectedName',
    'ExpectedNumber',
    'ExpectedType',
    'ExpectedModuleSpecifier',
    'ExpectedJSXName',
    'ExpectedJSXAttrValue',
    'ExpectedJSXSpread',
    'ExpectedRBraceInTemplate',
    'NewOptionalChain',
    'NewDynamicImport',
    'InvalidImportProperty',
    'ImportRequiresSpecifier',
    'ImportArguments',
    'DynamicImportSpread',
    'LexicalDeclSingleStatement',
    'ClassDeclSingleStatement',
    'AsyncFnSingleStatement',
    'GeneratorSingleStatement',
    'TaggedOptionalChain',
    'DecoratorsUnsupported',
    'ParserStalled',
    'UnexpectedCharInJSXAttrs',
    'UnexpectedInExpression',
    'UnexpectedInObjectLiteral',
    'UnexpectedInClassBody',
    'UnexpectedInTypeMember',
    'TopLevelReturn',
    'TopLevelNewTarget',
    'UnterminatedJSXElement',
    'UnterminatedRegex',
    'UnterminatedString',
    'UnterminatedTemplate',
    'UnterminatedComment',
    'WithStatement',
    // Early errors — the grammar accepts the shape and a later rule rejects it. Every message here
    // is oxc's, verbatim from `oxc_parser/src/diagnostics.rs`, so a divergence in `pnpm parserdiff`
    // is visible as a divergence in TEXT and not only in accept/reject.
    'InvalidAssignmentTarget',
    'AssignmentNotSimple',
    'DefaultValueOperator',
    'InvalidRestTarget',
    'SpreadLastElement',
    'YieldOutsideGenerator',
    'ConstructorGenerator',
    'ConstructorAsync',
    'ConstructorAccessor',
    'IdentifierInGenerator',
    'IdentifierInAsync',
    'MissingInitInConst',
    'MissingInitInDestructuring',
    'MissingInitInUsing',
    'DecoratorOptionalChain',
    'InvalidNumberEnd',
    'RestParameterLast',
    'RestElementLast',
    'RestTrailingComma',
    'InvalidBindingRestTarget',
    'PrivateNameConstructor',
    'StaticPrototype',
    'BadTemplateEscape',
    'InvalidUnicodeEscape',
    'InvalidEscape',
    'InvalidEscapedIdentChar',
    'EscapedKeyword',
    'ImportExportNotTopLevel',
);
export type ParseErrorCode = (typeof ParseErrorCode)[keyof typeof ParseErrorCode];

const TEMPLATE: Record<number, string> = {
    [ParseErrorCode.Expected]: 'expected %0',
    [ParseErrorCode.ExpectedInJSX]: 'expected %0 in JSX',
    [ParseErrorCode.UnexpectedChar]: "unexpected character '%0'",
    [ParseErrorCode.ExpectedIdentifier]: 'expected identifier',
    [ParseErrorCode.ExpectedName]: 'expected name',
    [ParseErrorCode.ExpectedNumber]: 'expected number',
    [ParseErrorCode.ExpectedType]: 'expected type',
    [ParseErrorCode.ExpectedModuleSpecifier]: 'expected module specifier',
    [ParseErrorCode.ExpectedJSXName]: 'expected JSX name',
    [ParseErrorCode.ExpectedJSXAttrValue]: 'expected JSX attribute value',
    [ParseErrorCode.ExpectedJSXSpread]: "expected '...' in JSX spread attribute",
    [ParseErrorCode.ExpectedRBraceInTemplate]: "expected '}' in template",
    [ParseErrorCode.NewOptionalChain]: 'optional chain is not allowed in a new expression',
    [ParseErrorCode.NewDynamicImport]: 'Cannot use new with dynamic import',
    [ParseErrorCode.InvalidImportProperty]:
        'The only valid property accesses on import are `import.meta`, `import.source()`, and `import.defer()`',
    [ParseErrorCode.ImportRequiresSpecifier]: 'import() requires a specifier.',
    [ParseErrorCode.ImportArguments]:
        'Dynamic imports can only accept a module specifier and an optional set of attributes as arguments',
    [ParseErrorCode.DynamicImportSpread]: 'Argument of dynamic import cannot be a spread element.',
    [ParseErrorCode.LexicalDeclSingleStatement]:
        'Lexical declaration cannot appear in a single-statement context',
    [ParseErrorCode.ClassDeclSingleStatement]: 'Invalid class declaration',
    [ParseErrorCode.AsyncFnSingleStatement]:
        'Async functions can only be declared at the top level or inside a block',
    [ParseErrorCode.GeneratorSingleStatement]: 'Generators can only be declared at the top level or inside a block',
    [ParseErrorCode.TaggedOptionalChain]: 'tagged template cannot be used with an optional chain',
    [ParseErrorCode.DecoratorsUnsupported]: 'decorators not supported',
    [ParseErrorCode.ParserStalled]: 'parser stalled',
    [ParseErrorCode.UnexpectedCharInJSXAttrs]: 'unexpected character in JSX attributes',
    [ParseErrorCode.UnexpectedInExpression]: 'unexpected %0 in expression',
    [ParseErrorCode.UnexpectedInObjectLiteral]: 'unexpected %0 in object literal',
    [ParseErrorCode.UnexpectedInClassBody]: 'unexpected %0 in class body',
    [ParseErrorCode.UnexpectedInTypeMember]: 'unexpected %0 in type member',
    [ParseErrorCode.TopLevelReturn]: 'return statement is only allowed inside a function body',
    [ParseErrorCode.TopLevelNewTarget]: "'new.target' is only allowed inside a function body",
    [ParseErrorCode.UnterminatedJSXElement]: 'unterminated JSX element',
    [ParseErrorCode.UnterminatedRegex]: 'unterminated regex',
    [ParseErrorCode.UnterminatedString]: 'unterminated string literal',
    [ParseErrorCode.UnterminatedTemplate]: 'unterminated template literal',
    [ParseErrorCode.UnterminatedComment]: 'unterminated block comment',
    // esbuild's diagnostic, adapted: "With statements cannot be used with the \"esm\" output format
    // due to strict mode". shakeup emits ESM only, so the format is not a variable — the reason is.
    [ParseErrorCode.WithStatement]:
        '`with` statements are not allowed in a module, which is always strict mode',
    [ParseErrorCode.InvalidAssignmentTarget]: 'cannot assign to this expression',
    [ParseErrorCode.AssignmentNotSimple]: 'invalid left-hand side in assignment',
    [ParseErrorCode.DefaultValueOperator]: "only '=' operator can be used for specifying default value",
    [ParseErrorCode.InvalidRestTarget]: 'invalid rest element target in destructuring assignment',
    [ParseErrorCode.SpreadLastElement]: 'spread must be last element',
    [ParseErrorCode.YieldOutsideGenerator]: "a 'yield' expression is only allowed in a generator body",
    [ParseErrorCode.ConstructorGenerator]: "constructor can't be a generator",
    [ParseErrorCode.ConstructorAsync]: "constructor can't be an async method",
    [ParseErrorCode.ConstructorAccessor]: "classes may not have a field named 'constructor'",
    [ParseErrorCode.IdentifierInGenerator]: 'cannot use `yield` as an identifier in a generator context',
    [ParseErrorCode.IdentifierInAsync]: 'cannot use `await` as an identifier in an async context',
    [ParseErrorCode.MissingInitInConst]: 'missing initializer in const declaration',
    [ParseErrorCode.MissingInitInDestructuring]: 'missing initializer in destructuring declaration',
    [ParseErrorCode.MissingInitInUsing]: 'using declarations must have an initializer',
    [ParseErrorCode.DecoratorOptionalChain]: 'a decorator cannot contain an optional chain',
    [ParseErrorCode.InvalidNumberEnd]: 'Invalid characters after number',
    [ParseErrorCode.RestParameterLast]: 'A rest parameter must be last in a parameter list',
    [ParseErrorCode.RestElementLast]: 'A rest element must be last in a destructuring pattern',
    [ParseErrorCode.RestTrailingComma]: 'A rest parameter or binding pattern may not have a trailing comma.',
    [ParseErrorCode.InvalidBindingRestTarget]: 'Invalid rest element target in destructuring pattern',
    [ParseErrorCode.PrivateNameConstructor]: "classes can't have an element named '#constructor'",
    [ParseErrorCode.StaticPrototype]: "Classes may not have a static property named 'prototype'",
    [ParseErrorCode.BadTemplateEscape]: 'Bad escape sequence in untagged template literal',
    [ParseErrorCode.InvalidUnicodeEscape]: 'invalid unicode escape sequence',
    [ParseErrorCode.InvalidEscape]: 'Invalid escape sequence',
    [ParseErrorCode.InvalidEscapedIdentChar]: "invalid character '%0' in an escaped identifier",
    [ParseErrorCode.EscapedKeyword]: 'keywords cannot contain escape characters',
    [ParseErrorCode.ImportExportNotTopLevel]: "'import' and 'export' may only appear at the top level",
};

/** Format a diagnostic message, substituting `%0`/`%1`… with `params`. */
export function formatError(code: ParseErrorCode, params: readonly string[]): string {
    const tpl = TEMPLATE[code];
    if (params.length === 0) return tpl;
    return tpl.replace(/%(\d)/g, (_m, d: string) => params[Number(d)] ?? '');
}
