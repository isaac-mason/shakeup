import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// The `external` FUNCTION takes Rollup's three arguments, `(id, parentId, isResolved)`. shakeup passed
// only the specifier, so every call looked like an entry resolution to a config that branches on the
// importer — Rollup's `external-function-always-true` throws on exactly that.
//
// And a `\0`-prefixed id is never offered to it: `\0` is the reserved marker for a plugin's VIRTUAL
// module, never a real specifier. rolldown wraps a function `external` with the same guard
// (`bindingify-input-options.ts:172`). The ARRAY form is NOT filtered in either bundler — naming a
// `\0` id there is explicit.
const files: Record<string, string> = {
    '/dep.js': 'export const d = 1;\n',
    '/main.js': "import { d } from './dep.js';\nimport 'bare';\nexport const v = d;\n",
};
const build = async (external: unknown, plugins?: unknown[]) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    return bundle({ entry: '/main.js', fs, external: external as never, plugins: plugins as never, output: {} });
};

describe('the external option', () => {
    it('passes the IMPORTER as the second argument', async () => {
        const seen: [string, string | undefined][] = [];
        const r = await build((id: string, parentId?: string) => {
            seen.push([id, parentId]);
            return id === 'bare';
        });
        expect(r.errors).toEqual([]);
        expect(seen.length).toBeGreaterThan(0);
        expect(
            seen.every(([, p]) => p !== undefined),
            'no call looked like an entry',
        ).toBe(true);
        expect(seen.map(([i]) => i)).toContain('bare');
    });

    it('passes isResolved as the third argument', async () => {
        const seen: unknown[] = [];
        await build((_id: string, _p?: string, isResolved?: boolean) => {
            seen.push(isResolved);
            return false;
        });
        // Consulted BEFORE resolution, so it is false — the argument exists so a config can tell.
        expect(seen.every((x) => x === false)).toBe(true);
    });

    it('never offers a \\0 id to the function', async () => {
        const seen: string[] = [];
        const r = await build(
            (id: string) => {
                seen.push(id);
                return false;
            },
            [
                {
                    name: 'virtual',
                    resolveId: (id: string) => (id === '\0virtual' ? id : null),
                    load: (id: string) => (id === '\0virtual' ? 'export default 1;' : null),
                    transform: (_code: string, id: string) =>
                        id === '/main.js' ? "import v from '\0virtual';\nexport const w = v;\n" : null,
                },
            ],
        );
        expect(r.errors).toEqual([]);
        expect(
            seen.some((id) => id.startsWith('\0')),
            'the marker never reached the predicate',
        ).toBe(false);
    });

    it('an ARRAY external is matched verbatim, `\\0` included', async () => {
        const r = await build(['\0kept', 'bare']);
        expect(r.errors).toEqual([]);
        expect(r.chunks.map((c) => c.code).join('\n')).toContain("'bare'");
    });

    it('a TRUTHY return means external; `undefined` means it is not', async () => {
        // rolldown normalises with `?? false` and takes the value's truthiness — not `=== true`. A
        // first cut of this used a strict comparison and quietly disagreed with both oracles, which
        // this case exists to stop.
        const truthy = await build((id: string) => (id === 'bare' ? (1 as unknown as boolean) : false));
        expect(truthy.errors).toEqual([]);
        // The WARNING is what discriminates. `'bare'` appears in the output either way — declared
        // external, or unresolved and implicitly externalised — so asserting on the code alone passes
        // against a strict `=== true` too, which is how the first version of this case slipped past
        // its own sabotage.
        expect(truthy.warnings, 'declared external, so nothing failed to resolve').toEqual([]);
        expect(truthy.chunks.map((c) => c.code).join('\n')).toContain("'bare'");

        const undef = await build(() => undefined as unknown as boolean);
        // Nothing is declared external, so `bare` goes to resolution. It does not exist, and shakeup's
        // answer there is a WARNING plus an implicit external — not an error — so that is what this
        // asserts. The point of the case is that `undefined` did not short-circuit to external.
        expect(undef.errors).toEqual([]);
        expect(undef.warnings.join()).toMatch(/'bare'.*could not be resolved/);
    });
});
