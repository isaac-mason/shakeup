import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// `moduleInlineCandidates` returns `collectCandidates(...).direct`, so only single-return-expression
// donors cross a module boundary. The out-param helper — the shape every vec3/mat4 function in a
// numeric library is written in — is a BLOCK candidate and is dropped, which makes the tier inert on
// exactly the code it exists for.

const build = async (files: Record<string, string>, output: Record<string, unknown> = { optimize: true }) => {
    const r = await bundle({ input: '/m.js', fs: createMemoryFs(files), external: [], output } as never);
    expect(r.errors).toEqual([]);
    return r.chunks[0].code;
};

/** The body of a named top-level function in the chunk, by brace matching. Assertions target THIS
 *  rather than the whole chunk: a donor's declaration can legitimately survive inlining — a
 *  re-exported namespace object has to expose the binding, so it cannot be tree-shaken — and
 *  matching the identifier anywhere would read that as "not inlined". */
const bodyOf = (code: string, name: string): string => {
    const at = code.indexOf(`function ${name}(`);
    if (at === -1) throw new Error(`no function ${name} in chunk`);
    let depth = 0;
    let i = code.indexOf('{', at);
    const start = i;
    for (;; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) break;
    }
    return code.slice(start, i + 1);
};

const run = (code: string, call: string) => {
    const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
    return new Function(`${js}\nreturn (${call});`)();
};

describe('cross-module BLOCK inlining', () => {
    const helper = `export function addTo(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; }\n`;

    it('inlines a void out-param donor across a module boundary', async () => {
        const code = await build({
            '/m.js': `import { addTo } from './h.js';\nexport function c(p, q, r) { addTo(p, q, r); return p; }`,
            '/h.js': `/* @inline */\n${helper}`,
        });
        expect(bodyOf(code, 'c')).not.toMatch(/addTo\s*\(/);
    });

    it('the inlined result still computes the same thing', async () => {
        const files = {
            '/m.js': `import { addTo } from './h.js';\nexport function c(p, q, r) { addTo(p, q, r); return p; }`,
            '/h.js': `/* @inline */\n${helper}`,
        };
        const on = await build(files, { optimize: true });
        const off = await build(files, { optimize: false });
        const call = 'c([0,0],[1,2],[10,20])';
        expect(run(on, call)).toEqual(run(off, call));
    });

    it('@flatten in the consumer inlines an unannotated imported helper', async () => {
        const code = await build({
            '/m.js': `import { addTo } from './h.js';\n/* @flatten */\nexport function c(p, q, r) { addTo(p, q, r); return p; }`,
            '/h.js': helper,
        });
        expect(bodyOf(code, 'c')).not.toMatch(/addTo\s*\(/);
    });

    // A module-local that cross-module constant folding CANNOT resolve away: splicing the body would
    // leave `counter` dangling in the consumer, so the donor has to be refused.
    it('refuses a donor whose free variable is a mutable module-local', async () => {
        const code = await build({
            '/m.js': `import { addTo } from './h.js';\nexport function c(p, q, r) { addTo(p, q, r); return p; }`,
            '/h.js': `let counter = 0;\nexport function bump() { counter++; }\n/* @inline */\nexport function addTo(out, a, b) { out[0] = a[0] + b[0] + counter; }`,
        });
        expect(bodyOf(code, 'c')).toMatch(/addTo\s*\(/);
    });

    // A donor whose free variable IS foldable is fine — the fold happens first, so nothing dangles.
    it('inlines a donor whose free variable folds to a constant', async () => {
        const files = {
            '/m.js': `import { addTo } from './h.js';\nexport function c(p, q, r) { addTo(p, q, r); return p; }`,
            '/h.js': `const SCALE = 2;\n/* @inline */\nexport function addTo(out, a, b) { out[0] = (a[0] + b[0]) * SCALE; }`,
        };
        const on = await build(files, { optimize: true });
        const off = await build(files, { optimize: false });
        const call = 'c([0,0],[1,2],[10,20])';
        expect(run(on, call)).toEqual(run(off, call));
    });

    // crashcat reaches every math helper through a namespace object — `import { mat4 } from 'math'`
    // where the package does `export * as mat4 from './mat4.ts'`, then `mat4.fromRotationTranslation(…)`.
    // The resolver only accepts a bare IdentifierReference callee, so none of these inline, which is
    // what keeps `updateAABB` at 5 lines in a shakeup build while compilecat folds it flat.
    describe('namespace member callees', () => {
        const nsFiles = (consumer: string) => ({ '/m.js': consumer, '/ns.js': `export * as v from './h.js';`, '/h.js': helper });

        it('inlines a BLOCK donor through a re-exported namespace', async () => {
            const code = await build(nsFiles(`import { v } from './ns.js';\n/* @flatten */\nexport function c(p, q, r) { v.addTo(p, q, r); return p; }`));
            expect(bodyOf(code, 'c')).not.toMatch(/addTo\s*\(/);
        });

        it('inlines a BLOCK donor through a direct namespace import', async () => {
            const code = await build({
                '/m.js': `import * as v from './h.js';\n/* @flatten */\nexport function c(p, q, r) { v.addTo(p, q, r); return p; }`,
                '/h.js': helper,
            });
            expect(bodyOf(code, 'c')).not.toMatch(/addTo\s*\(/);
        });

        it('inlines a DIRECT donor through a namespace', async () => {
            const code = await build({
                '/m.js': `import * as v from './h.js';\n/* @flatten */\nexport function c(x) { return v.twice(x); }`,
                '/h.js': `export function twice(x) { return x * 2; }`,
            });
            expect(bodyOf(code, 'c')).not.toMatch(/twice\s*\(/);
        });

        it('preserves behaviour through a namespace', async () => {
            const files = nsFiles(`import { v } from './ns.js';\n/* @flatten */\nexport function c(p, q, r) { v.addTo(p, q, r); return p; }`);
            const on = await build(files, { optimize: true });
            const off = await build(files, { optimize: false });
            const call = 'c([0,0],[1,2],[10,20])';
            expect(run(on, call)).toEqual(run(off, call));
        });

        it('still refuses an unhygienic donor reached through a namespace', async () => {
            const code = await build({
                '/m.js': `import * as v from './h.js';\n/* @flatten */\nexport function c(p, q, r) { v.addTo(p, q, r); return p; }`,
                '/h.js': `let counter = 0;\nexport function bump() { counter++; }\nexport function addTo(out, a, b) { out[0] = a[0] + b[0] + counter; }`,
            });
            expect(bodyOf(code, 'c')).toMatch(/addTo\s*\(/);
        });

        it('does not inline through a rebindable holder', async () => {
            const code = await build({
                '/m.js': `import * as v from './h.js';\nlet ns = v;\nexport function reset(o) { ns = o; }\n/* @flatten */\nexport function c(p, q, r) { ns.addTo(p, q, r); return p; }`,
                '/h.js': helper,
            });
            expect(bodyOf(code, 'c')).toMatch(/addTo\s*\(/);
        });
    });
});

// The shapes an out-param helper is ACTUALLY called in. The cross-module pass used to handle only a
// bare `f(args);` statement, so a helper imported from another module stayed a call whenever its
// result was used — which is most of the time, and which is what kept a caller's scratch buffer
// aliased behind a call that SROA could not see through.
describe('a cross-module block helper inlines in every statement shape', () => {
    const H = `export function fill(out, a, b) { out[0] = a + b; return out[0] > 0; }`;
    const shapes: [name: string, body: string, call: string][] = [
        ['bare call', 'fill(out, a, b); return out[0];', 'f([0], 2, 3)'],
        ['assignment', 'let hit = false; hit = fill(out, a, b); return [out[0], hit];', 'f([0], 2, 3)'],
        ['const declaration', 'const hit = fill(out, a, b); return [out[0], hit];', 'f([0], -5, 1)'],
        ['return', 'return fill(out, a, b);', 'f([0], 2, 3)'],
    ];

    for (const [name, body, call] of shapes) {
        it(`inlines it in ${name} position`, async () => {
            const files = {
                '/m.js': `import { fill } from './h.js';\n/* @optimize */\nexport function f(out, a, b) { ${body} }`,
                '/h.js': H,
            };
            const code = await build(files);
            expect(bodyOf(code, 'f')).not.toMatch(/\bfill\w*\s*\(/);
            expect(run(code, call)).toEqual(run(await build(files, { optimize: false }), call));
        });
    }
});
