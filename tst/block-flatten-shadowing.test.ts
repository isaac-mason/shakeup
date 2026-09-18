import { describe, expect, it } from 'vitest';
import { setVerifyExtras, verifySemantic } from '../src/analysis/ref-facts.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { bundle, createMemoryFs } from '../src/index.ts';
import { parseProgram } from '../src/parser/index.ts';
import { runCompress } from '../src/passes/compress/index.ts';

// A nested block that REBINDS a name the enclosing scope already uses cannot be flattened into it:
// the declaration hoists to the top of the target block, so a reference that used to resolve to the
// outer binding now sits in the inner binding's temporal dead zone.
//
//   const topo = o.topo;                    let topo = o.topo;
//   if (a) {                                if (a) {
//       if (g()) topo[a] = b;        ->         g() && (topo[a] = b);   // reads the INNER topo now
//       { const topo = o.topo; … }             let topo = o.topo;      // …declared after it
//   }                                      }
//
// Found via crashcat, where inlining produces shadowing blocks constantly.
setVerifyExtras(true);

const SRC = `export function f(o, a, b, c) {
    const topo = o.topo;
    if (a !== -1) {
        if (g(o, c)) topo[a] = b;
        {
            const topo = o.topo;
            topo[b] = -1;
        }
    }
}`;

describe('a shadowing block is not flattened into its parent', () => {
    it('keeps the maintained semantic consistent', () => {
        const program = parseProgram(SRC, { ts: false, jsx: false }) as never;
        let semantic = createSemantic();
        analyze(semantic, program);
        const refreshed = runCompress(program, semantic, 'full');
        if (refreshed !== null) semantic = refreshed;
        expect(verifySemantic(semantic, program)).toEqual([]);
    });

    it('does not emit a reference that precedes its own declaration', async () => {
        const r = await bundle({
            input: '/m.js',
            fs: createMemoryFs({ '/m.js': SRC }),
            output: { minify: { compress: true } },
        } as never);
        const code = r.chunks[0].code;
        // the inner binding must either stay in its own block or be renamed; what it must NOT do is
        // land in a block where the same name is read above it
        const inner = code.indexOf('let topo = o.topo;', code.indexOf('let topo = o.topo;') + 1);
        if (inner !== -1) {
            const blockStart = code.lastIndexOf('{', inner);
            expect(code.slice(blockStart, inner)).not.toMatch(/\btopo\b/);
        }
    });

    it('runs without a TDZ error', async () => {
        const r = await bundle({
            input: '/m.js',
            fs: createMemoryFs({ '/m.js': SRC }),
            output: { minify: { compress: true } },
        } as never);
        const js = r.chunks[0].code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
        const run = new Function(`${js}\nconst g = () => true;\nreturn f({ topo: [0, 0, 0] }, 1, 2, 0);`);
        expect(() => run()).not.toThrow();
    });
});
