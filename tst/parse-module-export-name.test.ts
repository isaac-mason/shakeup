// `export * as <name> from '…'` — ModuleExportName is an IdentifierName, so reserved words are
// legal. We used `parseIdent`, which rejects them.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

describe('export * as <reserved> from', () => {
    it.each(['default', 'class', 'function', 'new', 'ns'])('accepts `export * as %s`', (name) => {
        expect(errs(`export * as ${name} from "./x.js";`)).toEqual([]);
    });

    it('the string form still works', () => {
        expect(errs('export * as "ns name" from "./x.js";')).toEqual([]);
    });
});

describe('BigInt literals are property keys', () => {
    it.each(['({ 1n: 1 });', 'class C { 1n(){} }', 'let { 1n: a } = o;'])('accepts %s', (src) => {
        expect(() => new Function(src), 'node must agree').not.toThrow();
        expect(errs(src), src).toEqual([]);
    });
});

describe('`using` in a for head', () => {
    // `for (using of xs)` iterates into a variable NAMED `using`; `for (using of = null;;)` declares
    // one named `of`. Only what follows the `of` tells them apart — and the restriction does not
    // apply to `await using` at all.
    it.each([
        'for (using of = null;;) break;',
        'async function f(){ for (await using of of []) {} }',
        'for (using of xs) {}',
        'for (using x of xs) {}',
        'using x = f();',
    ])('accepts %s', (src) => {
        expect(parse(src, { ts: true, jsx: false }).errors, src).toEqual([]);
    });
});
