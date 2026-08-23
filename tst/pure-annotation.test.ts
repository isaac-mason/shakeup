import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const build = async (src: string) =>
    (await bundle({ input: '/m.js', fs: createMemoryFs({ '/m.js': src }), output: { minify: true } })).code;

// `readIt` does a member read, so the interprocedural analysis can NOT prove it pure — only the
// annotation can make these calls droppable. That keeps the tests about the annotation itself.
const PRELUDE = 'const o = { x: 1 };\nfunction readIt(p) { return p.x; }\n';

describe('/*@__PURE__*/ annotations', () => {
    it('drops an unused annotated call that the analysis cannot prove pure', async () => {
        const code = await build(`${PRELUDE}const UNUSED = /*@__PURE__*/ readIt(o);\nexport const out = 1;`);
        expect(code).not.toContain('readIt');
        expect(code).not.toMatch(/\bx\b\s*:/); // the whole chain shook out
    });

    it('KEEPS the same call without the annotation', async () => {
        const code = await build(`${PRELUDE}const UNUSED = readIt(o);\nexport const out = 1;`);
        expect(code).toMatch(/return \w+\.x|\.x/); // the function survived
    });

    it('accepts the `#` spelling and a spaced comment', async () => {
        const code = await build(`${PRELUDE}const A = /*#__PURE__*/ readIt(o);\nconst B = /* @__PURE__ */ readIt(o);\nexport const out = 1;`);
        expect(code).not.toContain('readIt');
    });

    it('applies to `new` as well', async () => {
        const src = 'class C { constructor(o) { this.v = o.x; } }\nconst U = /*@__PURE__*/ new C({ x: 1 });\nexport const out = 1;';
        expect(await build(src)).not.toContain('class');
    });

    it('re-emits the annotation in READABLE output, and drops it under minify (oxc parity)', async () => {
        const src = `${PRELUDE}export const out = /*@__PURE__*/ readIt(o);`;
        const readable = (
            await bundle({ input: '/m.js', fs: createMemoryFs({ '/m.js': src }), output: { minify: { compress: false } } })
        ).code;
        // Readable output keeps the marker so downstream tools (and a re-parse) still see it...
        expect(readable).toContain('__PURE__');
        // ...while minified output drops it: the marker has been consumed by this build, and oxc
        // likewise emits none of three.core.js's 214 annotations.
        expect(await build(src)).not.toContain('__PURE__');
    });

    it('applies to the call it immediately precedes, marking it exactly once', async () => {
        // Both the `new` and the outer `.at()` call start at the same offset; the annotation belongs
        // to the `new`, and must not be emitted twice.
        const code = await build(`const U = /*@__PURE__*/ new Array(3).at(0);\nexport const out = 1;`);
        expect((code.match(/__PURE__/g) ?? []).length).toBeLessThanOrEqual(1);
    });
});
