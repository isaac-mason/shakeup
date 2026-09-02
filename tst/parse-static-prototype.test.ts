// A static class element may not be named `prototype` — it would shadow the one the class already
// has. This is the exact mirror of the `constructor` rules next to it in `parseClassElement`, and it
// shares all three gates for the same reasons:
//
//   · a COMPUTED key is not statically known — `static ["prototype"]` is legal
//   · a PRIVATE name is a different namespace — `static #prototype` is legal
//   · a NON-static `prototype` is an ordinary member — `class C { prototype; }` is legal
//
// It applies to every element form, because they all share one key-parsing site: field, method,
// getter, setter, generator, async. A TS `declare` class is exempt, matching oxc's
// `!self.ctx.has_ambient()` guard (`js/class.rs:727,829`).
//
// ONE DELIBERATE DIVERGENCE FROM oxc: `class C { static accessor prototype; }`.
// oxc parses that as an `AccessorProperty` and applies the check only at its property-definition and
// method-definition sites, so it ACCEPTS it. The spec's early error is on ClassElementName, which
// covers auto-accessors too, so shakeup rejects. ESBUILD implements `accessor` and rejects this as
// `Invalid field name "prototype"` — the most complete of the four implementations agrees with us.
// node cannot arbitrate — node 24 does not implement
// `accessor` at all — and test262 has no fixture, so no gate moves either way. Recorded here because
// it is a choice, not an oversight: the same oracle hierarchy that made us follow test262 over node
// for `new import('m').prop` puts the language above oxc when they disagree.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(errs(src), src).not.toEqual([]);
};

describe('a static element may not be named prototype', () => {
    it.each([
        'class C { static prototype; }',
        'class C { static prototype = 1; }',
        'class C { static "prototype"; }',
        'class C { static prototype() {} }',
        'class C { static get prototype() {} }',
        'class C { static set prototype(v) {} }',
        'class C { static *prototype() {} }',
        'class C { static async prototype() {} }',
        'class C { static async *prototype() {} }',
        'var C = class { static prototype; };',
    ])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(errs('class C { static prototype; }')[0].msg).toBe("Classes may not have a static property named 'prototype'");
    });
});

describe('what stays legal', () => {
    it.each([
        'class C { prototype; }',
        'class C { prototype() {} }',
        'class C { get prototype() {} }',
        'class C { static ["prototype"]; }',
        'class C { static ["proto" + "type"]() {} }',
        'class C { static #prototype; }',
        'class C { static #prototype() {} }',
        'class C { static prototypeX; }',
        'class C { static protoype; }',
        'class C { static constructor() {} }',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    it('a TS ambient declaration is exempt, as in oxc', () => {
        expect(parse('declare class C { static prototype: number; }', { ts: true, jsx: false }).errors).toEqual([]);
        expect(parse('declare namespace N { class C { static prototype: number; } }', { ts: true, jsx: false }).errors).toEqual(
            [],
        );
    });
});
