import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// TypeScript treats an enum member access as a CONSTANT, and the other bundlers inline it: rolldown
// emits `0` for `Kind.STATIC` on a PLAIN enum, not only a `const enum`, and keeps the lowered object
// solely for whatever else still reads it. Verified against `rolldown` on this fixture's shape before
// any of this was written.
//
// It is the largest measured item in the crashcat size gap: 887 `Ident.MEMBER` accesses that rolldown
// resolves and we did not. `tsLower` already computed every value — the auto-increment sequence is
// what builds the IIFE — and threw it away; it now publishes them on the module.
//
// Substituting a LITERAL is why this needs none of the guards namespace elision does: it introduces
// no identifier, so nothing can be captured by a local and nothing needs importing across a chunk.
const build = async (files: Record<string, string>, entry = '/main.ts') => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry, fs, external: [], output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};

describe('constant enum members are inlined at the read', () => {
    const kind = 'export enum Kind { STATIC = 0, KINEMATIC = 1, DYNAMIC = 2 }\n';

    it('inlines ACROSS modules, which is the only shape that matters in practice', async () => {
        const code = await build({
            '/kind.ts': kind,
            '/main.ts': "import { Kind } from './kind.ts';\nexport const d = Kind.DYNAMIC;\nexport const s = Kind.STATIC;\n",
        });
        expect(code).toMatch(/const d = 2;/);
        expect(code).toMatch(/const s = 0;/);
        expect(code).not.toContain('Kind.DYNAMIC');
    });

    it('inlines a `const enum` and an explicit initialiser the same way', async () => {
        const code = await build({
            '/k.ts': 'export const enum C { A = 10, B = 20 }\n',
            '/main.ts': "import { C } from './k.ts';\nexport const c = C.A + C.B;\n",
        });
        expect(code).toMatch(/const c = 10 \+ 20;/);
    });

    it('inlines a STRING member, keeping the literal exactly as written', async () => {
        const code = await build({
            '/k.ts': "export enum S { A = 'left', B = 'right' }\n",
            '/main.ts': "import { S } from './k.ts';\nexport const s = S.B;\n",
        });
        expect(code).toMatch(/const s = 'right';/);
    });

    it('auto-increment continues from an explicit value, and stops when it cannot', async () => {
        const code = await build({
            '/k.ts': 'export enum E { A, B = 7, C, D = "x", E }\n',
            '/main.ts': "import { E } from './k.ts';\nexport const v = [E.A, E.B, E.C, E.D];\n",
        });
        // The literal is substituted VERBATIM, double quotes and all — the source wrote `D = "x"`.
        expect(code).toContain('[0,7,8,"x"]');
        // `E` follows a string member, so the sequence is no longer known — left as a read.
        expect(
            await build({
                '/k.ts': 'export enum E { A, B = 7, C, D = "x", E }\n',
                '/main.ts': "import { E } from './k.ts';\nexport const v = E.E;\n",
            }),
        ).toContain('E.E');
    });

    it('leaves a member whose value is not a literal', async () => {
        const code = await build({
            '/k.ts': 'declare const f: () => number;\nexport enum E { A = f(), B = -1 }\n',
            '/main.ts': "import { E } from './k.ts';\nexport const v = E.A + E.B;\n",
        });
        expect(code).toContain('E.A');
        expect(code).toContain('E.B'); // `-1` is a unary expression, not a literal — conservative
    });

    it('leaves a COMPUTED read, and so keeps the object it needs', async () => {
        const code = await build({
            '/kind.ts': kind,
            '/main.ts': "import { Kind } from './kind.ts';\nexport const n = Kind[Kind.DYNAMIC];\n",
        });
        expect(code).toMatch(/Kind\[2\]/);
        expect(code).toContain('"DYNAMIC"');
    });

    it('does not touch a member read off something that merely shares the name', async () => {
        const code = await build({
            '/kind.ts': kind,
            '/main.ts':
                "import { Kind } from './kind.ts';\n" +
                'function f(Kind: { DYNAMIC: string }) { return Kind.DYNAMIC; }\n' +
                'export const got = f({ DYNAMIC: "no" });\n' +
                'export const real = Kind.STATIC;\n',
        });
        expect(code, 'the parameter read is untouched').toContain('return Kind.DYNAMIC');
        expect(code).toMatch(/const real = 0;/);
    });
});
