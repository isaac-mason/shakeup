import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// `bindingKey` packs (scope, namespace, name) into one integer, taking a Smi-range fast path when the
// fields fit and a disjoint wide form when they do not. A collision between the two forms — or within
// one — would resolve a reference to the WRONG binding, silently, with no crash and no test failure
// anywhere else. These exercise the packing through the real resolver at shapes that stress it.
const run = (code: string): unknown => {
    const g: Record<string, unknown> = {};
    new Function('globalThis', code)(g);
    return g.sink;
};
const build = async (src: string): Promise<string> => {
    const r = await bundle({ entry: '/e.js', fs: createMemoryFs({ '/e.js': src }), external: [], output: { minify: true, optimize: true } } as never);
    return (r as { code: string }).code;
};

describe('scope/name packing resolves correctly at scale', () => {
    it('resolves through DEEP nesting past scope id 256', async () => {
        // Each level reads the level above and binds a fresh name, so a mis-resolved binding changes
        // the total. DEPTH is past 256, where the old composite key left Smi range.
        const DEPTH = 300;
        let body = 'let v0 = 1;\n';
        for (let i = 1; i <= DEPTH; i++) body += `{ let v${i} = v${i - 1} + 1;\n`;
        body += `globalThis.sink = v${DEPTH};\n` + '}'.repeat(DEPTH);
        const code = await build(body);
        expect(run(code)).toBe(DEPTH + 1);
    });

    it('resolves correctly with MANY distinct names across many scopes', async () => {
        // Widens the nameId field alongside the scope field.
        const SCOPES = 120, NAMES = 40;
        let body = 'let acc = 0;\n';
        for (let s = 0; s < SCOPES; s++) {
            body += '{\n';
            for (let n = 0; n < NAMES; n++) body += `  const n${s}_${n} = ${s * NAMES + n};\n`;
            body += `  acc += n${s}_${NAMES - 1};\n}\n`;
        }
        const code = await build(`${body}\nglobalThis.sink = acc;\n`);
        let want = 0;
        for (let s = 0; s < SCOPES; s++) want += s * NAMES + (NAMES - 1);
        expect(run(code)).toBe(want);
    });

    it('keeps value and type namespaces distinct for the same name', async () => {
        // `ns` is the low bit of the packed key; losing it would merge the two namespaces.
        const code = await build('class T { m() { return 1; } }\nconst T2 = T;\nglobalThis.sink = new T2().m();');
        expect(run(code)).toBe(1);
    });
});
