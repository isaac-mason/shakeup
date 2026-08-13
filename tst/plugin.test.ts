import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Plugin } from '../src/plugin.ts';
import { json } from '../src/plugins/json.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = (files: Record<string, string>, plugins: Plugin[] = [], external: string[] = []) => {
    const result = bundle({ entry: '/main.ts', fs: createMemoryFs(files), external, plugins });
    expect(result.errors).toEqual([]);
    return result;
};

describe('plugin pipeline', () => {
    it('virtual modules via resolveId + load', async () => {
        const virtual: Plugin = {
            name: 'virtual-config',
            resolveId: (_ctx, spec) => (spec === 'virtual:config' ? '\0virtual:config' : null),
            load: (_ctx, id) => (id === '\0virtual:config' ? 'export const version = "9.9.9";' : null),
        };
        const { code } = build(
            { '/main.ts': "import { version } from 'virtual:config';\nexport const v = version;" },
            [virtual],
        );
        const mod = await run(code);
        expect(mod.v).toBe('9.9.9');
    });

    it('transform chain: string replacement then Edit[] patches, in order', async () => {
        const replacer: Plugin = {
            name: 'define',
            transform: (_ctx, code) => code.replace('__BUILD__', '"1.2.3"'),
        };
        const patcher: Plugin = {
            name: 'patcher',
            transform: (_ctx, code) => {
                const at = code.indexOf('MARK');
                return at < 0 ? null : [{ start: at, end: at + 4, text: 'PATCHED' }];
            },
        };
        const { code } = build(
            { '/main.ts': 'export const build = __BUILD__;\nexport const mark = "MARK";' },
            [replacer, patcher],
        );
        const mod = await run(code);
        expect(mod.build).toBe('1.2.3');
        expect(mod.mark).toBe('PATCHED');
    });

    it('filters run in core: non-matching modules never invoke the handler', () => {
        let calls = 0;
        const special: Plugin = {
            name: 'special-only',
            transform: {
                filter: { id: /\.special\.ts$/ },
                handler: (_ctx, code) => {
                    calls++;
                    return code;
                },
            },
        };
        build(
            {
                '/main.ts': "import { s } from './thing.special.ts';\nexport const out = s;",
                '/thing.special.ts': 'export const s = 1;',
            },
            [special],
        );
        expect(calls).toBe(1); // only the .special.ts module, not /main.ts
    });

    it('json plugin: import a .json file, tree-shaking friendly', async () => {
        const { code } = build(
            {
                '/main.ts': "import cfg from './config.json';\nexport const name = cfg.name;",
                '/config.json': '{ "name": "puddle", "unused": [1, 2, 3] }',
            },
            [json()],
        );
        const mod = await run(code);
        expect(mod.name).toBe('puddle');
    });

    it('resolveId returning false marks a specifier external', () => {
        const externalize: Plugin = {
            name: 'externalize-lodash',
            resolveId: (_ctx, spec) => (spec === 'lodash-esque' ? false : null),
        };
        const { code } = build(
            { '/main.ts': "import { chunk } from 'lodash-esque';\nexport const c = () => chunk([1], 1);" },
            [externalize],
        );
        expect(code).toContain("from 'lodash-esque'");
    });

    it('renderChunk sees the final chunk; buildStart/buildEnd bracket the build', () => {
        const order: string[] = [];
        const banner: Plugin = {
            name: 'banner',
            buildStart: () => {
                order.push('start');
            },
            renderChunk: (_ctx, code) => {
                order.push('render');
                return `/* built by shakeup */\n${code}`;
            },
            buildEnd: () => {
                order.push('end');
            },
        };
        const { code } = build({ '/main.ts': 'export const x = 1;' }, [banner]);
        expect(code.startsWith('/* built by shakeup */')).toBe(true);
        expect(order).toEqual(['start', 'render', 'end']);
    });

    it('moduleParsed sees every module with its ast + semantic', () => {
        const seen: string[] = [];
        const spy: Plugin = {
            name: 'spy',
            moduleParsed: (_ctx, info) => {
                seen.push(info.id);
                expect(info.ast.nodeCount).toBeGreaterThan(1);
                expect(info.semantic.symCount).toBeGreaterThan(0);
            },
        };
        build(
            {
                '/main.ts': "import { a } from './a';\nexport const out = a;",
                '/a.ts': 'export const a = 1;',
            },
            [spy],
        );
        expect(seen.sort()).toEqual(['/a.ts', '/main.ts']);
    });

    it('ctx.warn lands in result warnings', () => {
        const warner: Plugin = {
            name: 'warner',
            transform: (ctx, code) => {
                ctx.warn('something smells');
                return code;
            },
        };
        const { warnings } = build({ '/main.ts': 'export const x = 1;' }, [warner]);
        expect(warnings).toContain('something smells');
    });
});
