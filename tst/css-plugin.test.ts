import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createDevServer } from '../src/dev-server.ts';
import { createMemoryFs, type Fs } from '../src/fs.ts';
import { createModuleRunner } from '../src/module-runner.ts';
import { css } from '../src/plugins/css.ts';

const FILES = {
    '/main.ts': "import './styles.css';\nexport const x = 1;",
    '/styles.css': '.a { color: red; }',
};

describe('css plugin — .css imports', () => {
    it("empty mode: '.css' import resolves to a no-op module (styles shipped elsewhere)", async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs(FILES),
            external: [],
            output: {},
            plugins: [css({ mode: 'empty' })],
        });
        expect(r.errors).toEqual([]);
        expect(r.code).not.toContain('color: red');
        expect(r.code).not.toContain('createElement');
    });

    it('inject mode: emits a document-guarded <style> injector with the css text', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs(FILES),
            external: [],
            output: {},
            plugins: [css({ mode: 'inject' })],
        });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain("typeof document !== 'undefined'");
        expect(r.code).toContain('.a { color: red; }');
        expect(r.code).toContain('document.head.appendChild');
    });

    it('dev server: a .css import evaluates cleanly (no DOM → no-op inject)', async () => {
        const fs: Fs = { read: (id) => (FILES as Record<string, string>)[id] ?? null, exists: (id) => id in FILES };
        const server = createDevServer({ fs, plugins: [css()] });
        const runner = createModuleRunner({
            resolveId: (spec, importer) => server.resolveId(spec, importer),
            fetchModule: async (id) => {
                const res = await server.fetchModule(id);
                if (res.errors.length) throw new Error(res.errors.join('\n'));
                return res.code;
            },
            createImportMeta: (id) => ({ url: `sk://${id}` }),
        });
        const ns = (await runner.import('/main.ts')) as { x: number };
        expect(ns.x).toBe(1); // the .css side-effect ran without a document, entry still evaluated
    });
});
