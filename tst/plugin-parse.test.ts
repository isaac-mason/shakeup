import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { pluginParse } from '../src/bundler/plugin.ts';

// `this.parse` — rolldown has it too, and implements it the same way (`plugin-context.ts:459` ->
// `parseAst`): the bundler already owns a parser, so a plugin should not have to bring one.
//
// The projection it returns is `src/ast/estree.ts`, which the AST barrel deliberately omits because
// its only `@typescript-eslint/types` import is a devDependency. That import is `import type`, so
// node's erase-only stripping removes it — `tst/node-native-entry.test.ts` is what proves the package
// entry still loads under bare node, and it must stay green for this to be safe.
describe('PluginCtx.parse', () => {
    it('returns an ESTree Program', () => {
        const ast = pluginParse('const answer = 1;');
        expect(ast.type).toBe('Program');
        expect(ast.sourceType).toBe('module');
        expect(ast.body).toHaveLength(1);
    });

    it('carries start/end, which is what a plugin actually uses', () => {
        // Rollup's own `plugin-parse` sample drives `magic-string` off these offsets.
        const src = 'const answer = 1;';
        const ast = pluginParse(src) as unknown as {
            body: { type: string; declarations: { id: { name: string }; init: { start: number; end: number } }[] }[];
        };
        const decl = ast.body[0].declarations[0];
        expect(decl.id.name).toBe('answer');
        expect(src.slice(decl.init.start, decl.init.end)).toBe('1');
    });

    it('honours sourceType and parses JSX', () => {
        expect(pluginParse('const a = 1;', { sourceType: 'script' }).sourceType).toBe('script');
        expect(pluginParse('const a = <div/>;').body).toHaveLength(1);
    });

    it('throws on invalid input rather than returning a broken tree', () => {
        expect(() => pluginParse('const = ;')).toThrow(/this\.parse:/);
    });

    it('is reachable as `this.parse` from a transform hook', async () => {
        const files: Record<string, string> = { '/main.js': 'export const answer = 1;\n' };
        const seen: string[] = [];
        const r = await bundle({
            entry: '/main.js',
            fs: { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files },
            external: [],
            plugins: [
                {
                    name: 'uses-parse',
                    transform(code: string) {
                        // biome-ignore lint/complexity/useArrowFunction: `this` is the point of the test
                        const ast = (this as { parse: (c: string) => { body: { type: string }[] } }).parse(code);
                        for (const n of ast.body) seen.push(n.type);
                        return null;
                    },
                },
            ] as never,
            output: {},
        });
        expect(r.errors).toEqual([]);
        expect(seen).toContain('ExportNamedDeclaration');
    });
});
