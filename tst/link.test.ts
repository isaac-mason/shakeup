import { describe, expect, it } from 'vitest';
import { deconflictWholeBundle } from '../src/deconflict.ts';
import { createMemoryFs } from '../src/fs.ts';
import { buildGraph, finalNameOf, linkGraph, packRef, refMod } from '../src/module-graph.ts';

const build = async (files: Record<string, string>, external: string[] = []) => {
    const graph = await buildGraph({ entry: '/main.ts', fs: createMemoryFs(files), external });
    expect(graph.errors).toEqual([]);
    const linked = linkGraph(graph);
    deconflictWholeBundle(graph, linked); // this test asserts on final (deconflicted) names
    return { graph, linked };
};

describe('graph + link', () => {
    it('binds imports through re-export chains, orders deps first, deconflicts collisions', async () => {
        const { graph, linked } = await build(
            {
                '/main.ts': [
                    "import { add } from './math';",
                    "import * as util from './util';",
                    "import { helper } from 'external-pkg';",
                    "export { scale } from './math';",
                    'export const result = add(util.one(), helper());',
                ].join('\n'),
                '/math.ts':
                    'export const add = (a: number, b: number) => a + b;\nexport function scale(v: number, s: number) { return v * s; }',
                '/util.ts': "export { one } from './impl';",
                '/impl.ts': 'const add = (x: number) => x + 1;\nexport const one = () => add(0);',
            },
            ['external-pkg'],
        );

        expect(linked.errors).toEqual([]);

        const order = linked.order.map((i) => graph.modules[i].id);
        expect(order[order.length - 1]).toBe('/main.ts');
        expect(order.indexOf('/math.ts')).toBeLessThan(order.indexOf('/main.ts'));
        expect(order.indexOf('/impl.ts')).toBeLessThan(order.indexOf('/util.ts'));

        const main = graph.modules[graph.entries[0].module];
        const mathIdx = graph.byId.get('/math.ts')!;
        const addBinds = [...linked.binds.entries()].filter(([ref]) => refMod(ref) === main.idx);
        const found = addBinds.map(([, b]) => b);
        expect(found.some((b) => b.kind === 'found' && refMod(b.ref) === mathIdx)).toBe(true);
        expect(found.some((b) => b.kind === 'external' && b.specifier === 'external-pkg')).toBe(true);
        const utilIdx = graph.byId.get('/util.ts')!;
        expect(linked.namespaceOf.has(utilIdx)).toBe(true);

        const renamed = [...linked.finalNames.values()];
        expect(renamed).toContain('add$1');

        const entryExports = linked.exportMaps.get(graph.entries[0].module)!;
        expect([...entryExports.keys()].sort()).toEqual(['result', 'scale']);
        const scale = entryExports.get('scale')!;
        expect(scale.kind).toBe('found');
        if (scale.kind === 'found') {
            expect(refMod(scale.ref)).toBe(mathIdx);
            expect(finalNameOf(linked, scale.ref)).toBe('scale');
        }
    });

    it('star re-exports resolve, ambiguity across stars errors', async () => {
        const { linked } = await build({
            '/main.ts': "import { thing } from './barrel'; export const x = thing;",
            '/barrel.ts': "export * from './a'; export * from './b';",
            '/a.ts': 'export const thing = 1;',
            '/b.ts': 'export const other = 2;',
        });
        expect(linked.errors).toEqual([]);

        const ambiguous = await build({
            '/main.ts': "import { thing } from './barrel'; export const x = thing;",
            '/barrel.ts': "export * from './a'; export * from './b';",
            '/a.ts': 'export const thing = 1;',
            '/b.ts': 'export const thing = 2;',
        });
        expect(ambiguous.linked.errors.join(' ')).toMatch(/ambiguous export 'thing'/);
    });

    it('missing export is a link error; re-export cycles do not hang', async () => {
        const missing = await build({
            '/main.ts': "import { nope } from './a'; export const x = nope;",
            '/a.ts': 'export const yes = 1;',
        });
        expect(missing.linked.errors.join(' ')).toMatch(/'nope' is not exported/);

        const cyclic = await build({
            '/main.ts': "import { ghost } from './a'; export const x = ghost;",
            '/a.ts': "export { ghost } from './b';",
            '/b.ts': "export { ghost } from './a';",
        });
        expect(cyclic.linked.errors.join(' ')).toMatch(/'ghost' is not exported/);
    });

    it('anonymous default export synthesizes a named binding', async () => {
        const { graph, linked } = await build({
            '/main.ts': "import fn from './lib'; export const y = fn();",
            '/lib.ts': 'export default function () { return 7; }',
        });
        expect(linked.errors).toEqual([]);
        const libIdx = graph.byId.get('/lib.ts')!;
        const mainBinds = [...linked.binds.values()];
        const def = mainBinds.find((b) => b.kind === 'found' && refMod(b.ref) === libIdx);
        expect(def).toBeDefined();
        if (def && def.kind === 'found') expect(finalNameOf(linked, def.ref)).toBe('lib_default');
    });

    it('import type and interface exports produce no runtime bindings', async () => {
        const { graph, linked } = await build({
            '/main.ts': "import type { Shape } from './types'; import { real } from './types'; export const z: Shape = real;",
            '/types.ts': 'export interface Shape { n: number }\nexport const real = { n: 1 };',
        });
        expect(linked.errors).toEqual([]);
        const typesIdx = graph.byId.get('/types.ts')!;
        const exports = linked.exportMaps.get(typesIdx) ?? new Map();
        const types = graph.modules[typesIdx];
        expect([...types.namedExports.keys()]).toEqual(['real']);
        expect(exports.size === 0 || exports.has('real')).toBe(true);
        const mainBinds = [...linked.binds.entries()].filter(([ref]) => refMod(ref) === graph.entries[0].module);
        expect(mainBinds.length).toBe(1);
    });
});

it('packRef/refMod roundtrip', () => {
    expect(refMod(packRef(3, 12345))).toBe(3);
});
