// The three early errors a declarator with no initializer trips — oxc's `check_missing_initializer`
// (`js/declaration.rs:166-181`), which groups them because they share a trigger and an exemption.
//
// We accepted ALL of them. Found by walking oxc's `using`-declaration lookaheads (the N3 sweep):
// `using x;` diverged, and pulling that thread showed `const x;` and every destructuring form were
// missing too. node rejects all of them, so these were false-ACCEPTS of plain syntax errors.
// test262 48,789 -> 48,811.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string, ts = true) => parse(src, { ts, jsx: false }).errors;

describe('a declarator with no initializer', () => {
    it.each([
        ['const x;', 'const'],
        ['const a = 1, b;', 'const, second declarator'],
        ['const {a};', 'destructuring'],
        ['const [a];', 'destructuring'],
        ['let {a};', 'destructuring, let'],
        ['let [a];', 'destructuring, let'],
        ['var {a};', 'destructuring, var — the kind does not matter'],
        ['using x;', 'using'],
        ['await using x;', 'await using'],
        ['for (const x;;) {}', 'C-style for head'],
        ['for (const {a};;) {}', 'C-style for head, destructuring'],
        ['for (using x;;) {}', 'C-style for head, using'],
    ])('is rejected: %s (%s)', (src) => {
        expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
        expect(errs(src), src).not.toEqual([]);
    });

    // The exemptions are the interesting half: each is a place an initializer is legal to omit, and
    // getting any of them wrong turns a correct program into a build failure.
    it.each([
        ['let x;', 'a plain let needs no initializer'],
        ['var x;', 'nor a var'],
        ['let a, b;', 'nor several'],
        ['for (const x of xs) {}', 'for-of supplies the value'],
        ['for (const {a} of xs) {}', 'including when destructuring'],
        ['for (const [a] of xs) {}', ''],
        ['for (const k in o) {}', 'as does for-in'],
        ['declare const x;', 'ambient declarations may NOT have one'],
        ['declare var {a};', ''],
        ['declare global { const G: number; }', 'ambient reaches this by a separate path'],
        ['declare namespace F { const x: number; }', ''],
    ])('is accepted: %s %s', (src) => {
        expect(errs(src), src).toEqual([]);
    });
});
