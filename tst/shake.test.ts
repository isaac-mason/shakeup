import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = (files: Record<string, string>, treeshake = true) => {
    const result = bundle({ entry: '/main.ts', fs: createMemoryFs(files), external: [], treeshake });
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
        const { code, shaken } = build(files);
        expect(code).not.toContain('DEAD_MARKER_EXPORT');
        expect(code).not.toContain('DEAD_MARKER_LOCAL');
        expect(code).not.toContain('DEAD_MARKER_CONST');
        expect(code).toContain('DEAD_MARKER_KEEP_ALIVE_CHECK');
        expect(shaken!.dropped.length).toBe(3);
        const mod = await run(code);
        expect(mod.out).toBe(42);
    });

    it('treeshake: false keeps everything', async () => {
        const { code, shaken } = build(files, false);
        expect(code).toContain('DEAD_MARKER_EXPORT');
        expect(shaken).toBeNull();
        const mod = await run(code);
        expect(mod.out).toBe(42);
    });

    it('a wholly-dead module leaves no trace', () => {
        const { code } = build({
            '/main.ts': ["import { keep } from './used';", 'export const v = keep;'].join('\n'),
            '/used.ts': ["export { keep } from './deep';", 'export const DEAD_BARREL_ONLY = 1;'].join('\n'),
            '/deep.ts': 'export const keep = 7;',
        });
        expect(code).not.toContain('DEAD_BARREL_ONLY');
    });

    it('side effects are preserved even in otherwise-dead modules', async () => {
        const { code } = build({
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
        const { code } = build({
            '/main.ts': ["import { Live } from './enums';", 'export const kind = Live[Live.B];'].join('\n'),
            '/enums.ts': ['export enum Live { A, B }', 'export enum DeadEnum { X = 1 }'].join('\n'),
        });
        expect(code).not.toContain('DeadEnum');
        const mod = await run(code);
        expect(mod.kind).toBe('B');
    });

    it('impure top-level initializers are conservatively kept', async () => {
        const { code } = build({
            '/main.ts': ["import { pure } from './lib';", 'export const out = pure;'].join('\n'),
            '/lib.ts': ['export const pure = 1;', 'const kept = Math.max(1, 2);'].join('\n'),
        });
        expect(code).toContain('Math.max');
        const mod = await run(code);
        expect(mod.out).toBe(1);
    });

    it('namespace-imported modules keep their whole export surface', async () => {
        const { code } = build({
            '/main.ts': ["import * as ops from './ops';", 'export const r = ops.a();'].join('\n'),
            '/ops.ts': ['export const a = () => 1;', 'export const b = () => 2;'].join('\n'),
        });
        const mod = await run(code);
        expect(mod.r as number).toBe(1);
        expect(code).toContain('b:');
    });
});
