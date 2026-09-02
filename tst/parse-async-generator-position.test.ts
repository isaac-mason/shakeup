// A statement-only position — an `if` body, a loop body, a label — takes a Statement, and a
// declaration is not one. `9f3d533` closed that for `const` / `class` / `using`; this closes it for
// the two function forms that have no Annex B allowance.
//
// The split is the whole rule:
//   · `if (x) function f(){}`        VALID   — Annex B, and oxc leaves the strict-mode case to
//                                              `oxc_semantic`'s `check_function_declaration`
//   · `if (x) async function f(){}`  ERROR   — "Async functions can only be declared at the top
//                                              level or inside a block"
//   · `if (x) function* g(){}`       ERROR   — "Generators can only be declared at the top level or
//                                              inside a block"
// `async` wins the ordering when both apply, matching oxc: `if (x) async function* g(){}` reports the
// async message, not the generator one.
//
// The flag is threaded as an explicit `single` parameter on `parseFunction`, mirroring how oxc passes
// `stmt_ctx` — all six call sites pass it literally, because the generator-ness is only known after
// `function` has been consumed and the `*` peeked, which is inside `parseFunction`, not at the
// statement site.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;
const msg = (src: string) => errs(src)[0]?.msg;

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(errs(src), src).not.toEqual([]);
};

describe('an async function declaration needs a block', () => {
    it.each([
        'if (x) async function f(){}',
        'if (x) {} else async function f(){}',
        'do async function f(){} while(0);',
        'while(0) async function f(){}',
        'for(;;) async function f(){}',
        'label: async function f(){}',
        'if (x) async function* g(){}',
    ])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(msg('if (x) async function f(){}')).toBe(
            'Async functions can only be declared at the top level or inside a block',
        );
    });

    it('and wins the ordering over the generator rule, as in oxc', () => {
        expect(msg('if (x) async function* g(){}')).toBe(
            'Async functions can only be declared at the top level or inside a block',
        );
    });
});

describe('a generator declaration needs a block', () => {
    it.each([
        'if (x) function* g(){}',
        'do function* g(){} while(0);',
        'while(0) function* g(){}',
        'for(;;) function* g(){}',
        'label: function* g(){}',
    ])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(msg('if (x) function* g(){}')).toBe('Generators can only be declared at the top level or inside a block');
    });
});

describe('what stays legal', () => {
    // A PLAIN function declaration in the same positions is Annex B and must keep working — that is
    // the distinction this whole rule turns on, so it is pinned rather than assumed.
    it.each([
        'if (x) function f(){}',
        'label: function f(){}',
        'if (x) { async function f(){} }',
        'if (x) { function* g(){} }',
        'async function f(){}',
        'function* g(){}',
        'const h = async function(){};',
        'const k = function*(){};',
        'if (x) (async function(){});',
        'if (x) (function*(){});',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    it('the export forms are untouched — they are top level by construction', () => {
        for (const src of [
            'export async function f(){}',
            'export function* g(){}',
            'export default async function f(){}',
            'export default function* g(){}',
        ]) {
            expect(parse(src, { ts: false, jsx: false, kind: 'module' }).errors, src).toEqual([]);
        }
    });
});
