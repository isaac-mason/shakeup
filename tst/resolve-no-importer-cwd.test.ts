import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// `this.resolve('./x')` from a plugin has NO importer, so there is no directory to resolve against.
// Rollup uses the process cwd — `resolve(source)` in `utils/resolveId.ts`, and its function-test
// runner `process.chdir`s into each sample first. rolldown's resolver holds the same directory and
// falls back to it when the importer is absent, commenting that this is "matching Rollup's behavior
// of resolving bare relative paths against CWD when no importer is present"
// (`rolldown_resolver/src/resolver.rs`).
//
// shakeup used to return the specifier untouched, so `custom-resolve-options` got `id: './main.js'`
// where Rollup gives an absolute path — and `this.resolve` answered null outright whenever the cwd
// was not the fixture directory. The directory is an explicit `resolve.cwd` option because shakeup
// also runs in a browser, where there is no `process`.
const build = async (files: Record<string, string>, plugins: unknown[], cwd?: string) =>
    bundle({
        entry: '/app/main.js',
        fs: createMemoryFs(files),
        external: [],
        plugins: plugins as never,
        ...(cwd === undefined ? {} : { resolve: { cwd } }),
    });

describe('a resolve with no importer', () => {
    const files = { '/app/main.js': 'export const x = 1;\n', '/app/dep.js': 'export const y = 2;\n' };

    it('resolves against `resolve.cwd`', async () => {
        let seen: string | null | undefined;
        const r = await build(
            files,
            [
                {
                    name: 'p',
                    async transform(this: { resolve: (s: string) => Promise<{ id: string } | null> }) {
                        seen = (await this.resolve('./dep.js'))?.id ?? null;
                        return null;
                    },
                },
            ],
            '/app',
        );
        expect(r.errors).toEqual([]);
        expect(seen).toBe('/app/dep.js');
    });

    it('defaults to the process cwd', async () => {
        // No `resolve.cwd` given. Reads a real file off disk because the default only means anything
        // against a real cwd — on the memory fs every id is absolute, so this case cannot be faked.
        let seen: string | null | undefined;
        await bundle({
            entry: '/app/main.js',
            fs: {
                read: (id: string) =>
                    id === '/app/main.js' ? 'export const x = 1;\n' : existsSync(id) ? readFileSync(id, 'utf8') : null,
                exists: (id: string) => id === '/app/main.js' || existsSync(id),
            },
            external: [],
            plugins: [
                {
                    name: 'p',
                    async transform(this: { resolve: (s: string) => Promise<{ id: string } | null> }) {
                        seen = (await this.resolve('./package.json'))?.id ?? null;
                        return null;
                    },
                },
            ] as never,
        });
        expect(seen).toBe(join(process.cwd(), 'package.json'));
    });

    it('an importer still wins over the cwd', async () => {
        let seen: string | null | undefined;
        await build(
            files,
            [
                {
                    name: 'p',
                    async transform(this: { resolve: (s: string, i: string) => Promise<{ id: string } | null> }) {
                        seen = (await this.resolve('./dep.js', '/app/main.js'))?.id ?? null;
                        return null;
                    },
                },
            ],
            '/elsewhere',
        );
        expect(seen).toBe('/app/dep.js');
    });
});
