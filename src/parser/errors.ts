// Centralized parser diagnostics — meriyah's `errors.ts` model.
//
// One numbered code per distinct message. Call sites reference a CODE, not a
// string; the `%0` placeholders carry the runtime-variable parts (the expected
// token text, an offending character). This de-strings the parser: message
// wording lives here in one table, not scattered across `parser.ts`.
import { enumeration } from '../util/enumeration';

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
        '`with` statements cannot be bundled: the output is an ES module, which is always strict mode, and a `with` body cannot run in strict code',
};

/** Format a diagnostic message, substituting `%0`/`%1`… with `params`. */
export function formatError(code: ParseErrorCode, params: readonly string[]): string {
    const tpl = TEMPLATE[code];
    if (params.length === 0) return tpl;
    return tpl.replace(/%(\d)/g, (_m, d: string) => params[Number(d)] ?? '');
}
