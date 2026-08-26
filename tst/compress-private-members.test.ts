import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// oxc `remove_unused_private_members`. A `#name` is reachable only from inside its own class body —
// there is no `obj["#x"]` escape hatch — so an unread one is provably dead. Every guard below is a
// case where it is NOT dead, or where removing it would change behaviour.
const build = async (body: string): Promise<string> => {
    const r = await bundle({
        entry: '/e.js',
        fs: createMemoryFs({ '/e.js': body }),
        external: [],
        output: { minify: true, optimize: true },
    } as never);
    return (r as { code: string }).code;
};
const run = (code: string): unknown => {
    const g: Record<string, unknown> = {};
    new Function('globalThis', code)(g);
    return g.sink;
};

describe('unused private class members are removed (oxc remove_unused_private_members)', () => {
    it('drops an unread private field', async () => {
        const code = await build('class C { #x = 1; m() { return 2; } }\nglobalThis.sink = new C().m();');
        expect(code).not.toContain('#x');
        expect(run(code)).toBe(2);
    });

    it('drops an unread private method', async () => {
        const code = await build('class C { #h() { return 9; } m() { return 2; } }\nglobalThis.sink = new C().m();');
        expect(code).not.toContain('#h');
        expect(run(code)).toBe(2);
    });

    it('KEEPS a private field that is read', async () => {
        const code = await build('class C { #x = 41; m() { return this.#x + 1; } }\nglobalThis.sink = new C().m();');
        expect(code).toContain('#x');
        expect(run(code)).toBe(42);
    });

    it('KEEPS a private field used only by a `#x in o` brand check', async () => {
        // The brand check is the one place a bare PrivateIdentifier appears outside a member
        // expression or a class key; missing it would delete the very thing being tested for.
        const code = await build('class C { #x = 1; static has(o) { return #x in o; } }\nglobalThis.sink = C.has(new C());');
        expect(code).toContain('#x');
        expect(run(code)).toBe(true);
    });

    it('KEEPS an outer private field read from a NESTED class', async () => {
        // Uses propagate outward on class exit, minus the names that class declares.
        const code = await build(
            'class Outer { #x = 7; m() { const I = class { n(o) { return o.#x; } }; return new I().n(this); } }\nglobalThis.sink = new Outer().m();',
        );
        expect(code).toContain('#x');
        expect(run(code)).toBe(7);
    });

    it('KEEPS an unread field whose initialiser has side effects', async () => {
        // Dropping the element would drop the call. oxc keeps the whole element rather than hoisting.
        const code = await build(
            'globalThis.hits = 0;\nfunction bump(){ globalThis.hits++; return 1; }\nclass C { #x = bump(); m() { return 2; } }\nglobalThis.sink = new C().m();',
        );
        const g: Record<string, unknown> = {};
        new Function('globalThis', code)(g);
        expect(g.hits).toBe(1);
        expect(g.sink).toBe(2);
    });

    it('KEEPS a public field of the same spelling', async () => {
        const code = await build('class C { x = 5; m() { return 2; } }\nglobalThis.sink = new C().x;');
        expect(run(code)).toBe(5);
    });

    it('BAILS when the module contains a direct eval', async () => {
        // `eval` can name a private member at runtime, so the whole module is left alone.
        const code = await build(
            'class C { #x = 3; m(s) { return eval(s); } }\nglobalThis.sink = new C().m("this.#x");',
        );
        expect(code).toContain('#x');
        expect(run(code)).toBe(3);
    });
});
