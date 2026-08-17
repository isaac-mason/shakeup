import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { buildGraph, linkGraph, resolveJSXOptions } from '../src/module-graph.ts';
import type { ModuleSideEffects } from '../src/plugin.ts';
import { treeshake } from '../src/treeshake.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (files: Record<string, string>, treeshake = true) => {
    const result = await bundle({ entry: '/main.ts', fs: createMemoryFs(files), external: [], treeshake });
    expect(result.errors).toEqual([]);
    return result;
};

describe('tree shaking', () => {
    const files = {
        '/main.ts': ["import { used } from './lib';", 'export const out = used();'].join('\n'),
        '/lib.ts': [
            'export function used() { return DEAD_MARKER_KEEP_ALIVE_CHECK(); }',
            'function DEAD_MARKER_KEEP_ALIVE_CHECK() { return 42; }',
            'export function deadExport() { return "DEAD_MARKER_EXPORT"; }',
            'const deadLocal = "DEAD_MARKER_LOCAL";',
            'export const deadConst = "DEAD_MARKER_CONST";',
        ].join('\n'),
    };

    it('drops unused exports, locals, and transitive helpers of dead code', async () => {
        const { code, shaken } = await build(files);
        expect(code).not.toContain('DEAD_MARKER_EXPORT');
        expect(code).not.toContain('DEAD_MARKER_LOCAL');
        expect(code).not.toContain('DEAD_MARKER_CONST');
        expect(code).toContain('DEAD_MARKER_KEEP_ALIVE_CHECK');
        expect(shaken!.dropped.length).toBe(3);
        const mod = await run(code);
        expect(mod.out).toBe(42);
    });

    it('treeshake: false keeps everything', async () => {
        const { code, shaken } = await build(files, false);
        expect(code).toContain('DEAD_MARKER_EXPORT');
        expect(shaken).toBeNull();
        const mod = await run(code);
        expect(mod.out).toBe(42);
    });

    it('a wholly-dead module leaves no trace', async () => {
        const { code } = await build({
            '/main.ts': ["import { keep } from './used';", 'export const v = keep;'].join('\n'),
            '/used.ts': ["export { keep } from './deep';", 'export const DEAD_BARREL_ONLY = 1;'].join('\n'),
            '/deep.ts': 'export const keep = 7;',
        });
        expect(code).not.toContain('DEAD_BARREL_ONLY');
    });

    it('side effects are preserved even in otherwise-dead modules', async () => {
        const { code } = await build({
            '/main.ts': [
                "import './effects';",
                "import { registry } from './registry';",
                'export const seen = registry.slice();',
            ].join('\n'),
            '/registry.ts': 'export const registry: string[] = [];',
            '/effects.ts': [
                "import { registry } from './registry';",
                "registry.push('effect-ran');",
                'export const neverImported = "DEAD_MARKER_FX";',
            ].join('\n'),
        });
        expect(code).not.toContain('DEAD_MARKER_FX');
        expect(code).toContain('effect-ran');
        return run(code).then((mod) => {
            expect(mod.seen).toEqual(['effect-ran']);
        });
    });

    it('dead enums vanish including their lowering; live enums stay', async () => {
        const { code } = await build({
            '/main.ts': ["import { Live } from './enums';", 'export const kind = Live[Live.B];'].join('\n'),
            '/enums.ts': ['export enum Live { A, B }', 'export enum DeadEnum { X = 1 }'].join('\n'),
        });
        expect(code).not.toContain('DeadEnum');
        const mod = await run(code);
        expect(mod.kind).toBe('B');
    });

    it('impure top-level initializers are conservatively kept', async () => {
        const { code } = await build({
            '/main.ts': ["import { pure } from './lib';", 'export const out = pure;'].join('\n'),
            '/lib.ts': ['export const pure = 1;', 'const kept = Math.max(1, 2);'].join('\n'),
        });
        expect(code).toContain('Math.max');
        const mod = await run(code);
        expect(mod.out).toBe(1);
    });

    it('narrows a namespace object to the members actually read', async () => {
        const { code } = await build({
            '/main.ts': ["import * as ops from './ops';", 'export const r = ops.a();'].join('\n'),
            '/ops.ts': ['export const a = () => 1;', 'export const b = () => 2;'].join('\n'),
        });
        const mod = await run(code);
        expect(mod.r as number).toBe(1);
        expect(code).toContain('a:');
        expect(code).not.toContain('b:');
    });

    it('keeps the whole namespace surface when the namespace escapes', async () => {
        const { code } = await build({
            '/main.ts': ["import * as ops from './ops';", 'export const ns = ops;'].join('\n'),
            '/ops.ts': ['export const a = () => 1;', 'export const b = () => 2;'].join('\n'),
        });
        const mod = await run(code);
        expect((mod.ns as { a: () => number }).a()).toBe(1);
        expect((mod.ns as { b: () => number }).b()).toBe(2);
        expect(code).toContain('a:');
        expect(code).toContain('b:');
    });

    it('unions member reads across multiple namespace importers', async () => {
        const { code } = await build({
            '/main.ts': [
                "import * as ops from './ops';",
                "import { viaB } from './other';",
                'export const r = ops.a() + viaB();',
            ].join('\n'),
            '/other.ts': ["import * as ops from './ops';", 'export const viaB = () => ops.b();'].join('\n'),
            '/ops.ts': ['export const a = () => 1;', 'export const b = () => 2;', 'export const c = () => 3;'].join('\n'),
        });
        const mod = await run(code);
        expect(mod.r as number).toBe(3);
        expect(code).toContain('a:');
        expect(code).toContain('b:');
        expect(code).not.toContain('c:'); // c read by nobody
    });

    it('keeps the whole surface when the module is also dynamically imported', async () => {
        const { code } = await build({
            '/main.ts': [
                "import * as ops from './ops';",
                'export const r = ops.a();',
                "export const lazy = () => import('./ops');",
            ].join('\n'),
            '/ops.ts': ['export const a = () => 1;', 'export const b = () => 2;'].join('\n'),
        });
        const mod = await run(code);
        expect(mod.r as number).toBe(1);
        expect(code).toContain('a:');
        expect(code).toContain('b:'); // dynamic import may read any export → whole surface
    });

    it('keeps the whole surface when re-exported as a namespace', async () => {
        const { code } = await build({
            '/main.ts': ["import * as ops from './ops';", "export * as reexport from './ops';", 'export const r = ops.a();'].join(
                '\n',
            ),
            '/ops.ts': ['export const a = () => 1;', 'export const b = () => 2;'].join('\n'),
        });
        const mod = await run(code);
        expect(mod.r as number).toBe(1);
        expect((mod.reexport as { b: () => number }).b()).toBe(2);
        expect(code).toContain('a:');
        expect(code).toContain('b:'); // export * as → opaque downstream → whole surface
    });
});

// The module-level side-effect gate, pinned at the treeshake() unit level (independent
// of the plugin path): feed a graph whose non-entry module carries the flag directly.
describe('tree shaking — module-level side-effect gate (unit seam)', () => {
    const seamFiles = {
        '/main.ts': "import './effect.ts';\nexport const out = 1;",
        '/effect.ts': 'globalThis.__SEAM__ = 42;\nconst dead = 7;',
    };
    const shakeWith = async (effectSideEffects: ModuleSideEffects) => {
        const graph = await buildGraph({ entry: '/main.ts', fs: createMemoryFs(seamFiles), external: [] });
        expect(graph.errors).toEqual([]);
        const effect = graph.modules[graph.byId.get('/effect.ts')!];
        effect.sideEffects = effectSideEffects;
        const linked = linkGraph(graph);
        const jsxPure = resolveJSXOptions(undefined).pure;
        const shaken = treeshake(graph, linked, jsxPure);
        return { graph, shaken, effectIdx: effect.idx };
    };

    it('sideEffects false: an unused impure statement is NOT auto-rooted (dropped)', async () => {
        const { shaken, effectIdx } = await shakeWith(false);
        const effectLive = shaken.live[effectIdx];
        // Nothing in /effect.ts is referenced by main, and it may not auto-root effects.
        const droppedFromEffect = shaken.dropped.filter(([m]) => m === effectIdx);
        expect(droppedFromEffect.length).toBeGreaterThan(0);
        expect(effectLive.size).toBe(0);
    });

    it("sideEffects 'no-treeshake': every statement is rooted", async () => {
        const { graph, shaken, effectIdx } = await shakeWith('no-treeshake');
        const effectLive = shaken.live[effectIdx];
        const total = graph.modules[effectIdx].program.data.body.length;
        expect(effectLive.size).toBe(total);
    });

    it('sideEffects true (default): an impure statement is auto-rooted (kept)', async () => {
        const { shaken, effectIdx } = await shakeWith(true);
        const effectLive = shaken.live[effectIdx];
        // The `globalThis.__SEAM__ = 42;` assignment is impure → rooted.
        expect(effectLive.size).toBeGreaterThan(0);
    });
});
