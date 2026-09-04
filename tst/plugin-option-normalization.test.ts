import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// A plugin list may be nested arrays, promises, and falsy holes — Rollup and rolldown share ONE
// implementation of the flattening, and rolldown's `utils/async-flatten.ts` says so in a comment
// linking Rollup's `utils/asyncFlatten.ts`. Both then run
//
//     (await asyncFlatten([plugins])).filter(Boolean)
//
// shakeup passed `options.plugins` straight to `compilePipeline`, so a `null` entry threw
// "Cannot read properties of undefined" and a nested or promised plugin silently contributed nothing.
//
// The `options` hook is the other half: it runs against the build options between the two flattens,
// which is what lets it PUSH a plugin that then takes part in the build (Rollup's
// `getProcessedInputOptions`, rolldown's `PluginDriver.callOptionsHook`). rollupsuite's
// `nested-and-async-plugin` needs both at once.
const build = async (plugins: unknown, src = 'export const foo = 1;\n') =>
    bundle({ entry: '/main.js', fs: createMemoryFs({ '/main.js': src }), external: [], plugins } as never);

const rewrite = (from: string, to: string) => ({
    name: `rewrite-${from}`,
    transform: (code: string) => code.replace(from, to),
});

describe('plugin list normalization', () => {
    it('flattens nested arrays, awaits promises, and drops falsy holes', async () => {
        // biome-ignore lint/suspicious/noSparseArray: a sparse hole is exactly what this pins
        const r = await build([[Promise.resolve(rewrite('foo = 1', 'foo = 2'))], [undefined, Promise.resolve([null])], ,]);
        expect(r.errors).toEqual([]);
        expect(r.chunks.map((c) => c.code).join('\n')).toContain('foo = 2');
    });

    it('re-flattens while a promise resolves TO more promises', async () => {
        // `asyncFlatten`'s do/while: one pass is not enough when a promise yields an array of them.
        const r = await build(Promise.resolve([Promise.resolve([Promise.resolve(rewrite('foo = 1', 'foo = 3'))])]));
        expect(r.errors).toEqual([]);
        expect(r.chunks.map((c) => c.code).join('\n')).toContain('foo = 3');
    });

    it('an `options` hook can push a plugin that then runs', async () => {
        const added = rewrite('answer = 41', 'answer = 42');
        const pusher = {
            name: 'pusher',
            options(opts: { plugins: unknown[] }) {
                opts.plugins.push(added);
            },
        };
        const r = await build([pusher, rewrite('foo = 1', 'foo = 2')], 'export const foo = 1;\nexport const answer = 41;\n');
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code).toContain('foo = 2');
        expect(code, 'the pushed plugin took part in the build').toContain('answer = 42');
    });

    it('an `options` hook returning an object REPLACES the options', async () => {
        const replacer = {
            name: 'replacer',
            options: (opts: Record<string, unknown>) => ({ ...opts, plugins: [rewrite('foo = 1', 'foo = 9')] }),
        };
        const r = await build([replacer, rewrite('foo = 1', 'foo = 2')]);
        expect(r.errors).toEqual([]);
        expect(r.chunks.map((c) => c.code).join('\n')).toContain('foo = 9');
    });
});
