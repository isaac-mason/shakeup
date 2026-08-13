import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = (files: Record<string, string>, external: string[] = []) => {
    const result = bundle({ entry: '/main.ts', fs: createMemoryFs(files), external });
    expect(result.errors).toEqual([]);
    return result;
};

describe('bundle: executable output', () => {
    it('bundles + executes a multi-module TS package (types stripped, renames applied)', async () => {
        const { code } = build({
            '/main.ts': [
                "import { add } from './math';",
                "import { one } from './util';",
                'export const result: number = add(one(), 2);',
                "export { scale } from './math';",
            ].join('\n'),
            '/math.ts': [
                'export interface V { n: number }',
                'export const add = (a: number, b: number): number => a + b;',
                'export function scale(v: number, s: number): number { return v * s; }',
            ].join('\n'),
            '/util.ts': [
                // deliberate collision with math's `add`
                'const add = (x: number): number => x + 1;',
                'export const one = (): number => add(0);',
            ].join('\n'),
        });
        const mod = await run(code);
        expect(mod.result).toBe(3); // one() = 1, add(1, 2) = 3
        expect((mod.scale as (a: number, b: number) => number)(3, 4)).toBe(12);
    });

    it('re-export chains, star exports, and namespace imports execute', async () => {
        const { code } = build({
            '/main.ts': [
                "import * as lib from './lib';",
                "import { thing } from './barrel';",
                'export const viaNs = lib.double(thing);',
            ].join('\n'),
            '/lib.ts': 'export const double = (x: number) => x * 2;',
            '/barrel.ts': "export * from './a';",
            '/a.ts': 'export const thing = 21;',
        });
        const mod = await run(code);
        expect(mod.viaNs).toBe(42);
    });

    it('default exports (named + anonymous) execute', async () => {
        const { code } = build({
            '/main.ts': [
                "import anon from './anon';",
                "import named from './named';",
                'export const sum = anon() + named();',
            ].join('\n'),
            '/anon.ts': 'export default function () { return 7; }',
            '/named.ts': 'export default function seven() { return 35; }',
        });
        const mod = await run(code);
        expect(mod.sum).toBe(42);
    });

    it('enums lower and execute inside a bundle (no export keyword leakage)', async () => {
        const { code } = build({
            '/main.ts': ["import { Motion } from './motion';", 'export const kind = Motion[Motion.DYNAMIC];'].join('\n'),
            '/motion.ts': 'export enum Motion { STATIC = 0, DYNAMIC = 1 }',
        });
        expect(code).not.toMatch(/export var/);
        const mod = await run(code);
        expect(mod.kind).toBe('DYNAMIC');
    });

    it('external imports hoist and dedupe; externals stay imports', async () => {
        const { code } = build(
            {
                '/main.ts': ["import { platform } from 'node:process';", "export { arch } from './other';", 'export const p = platform;'].join('\n'),
                '/other.ts': "import { arch } from 'node:process';\nexport { arch };",
            },
            ['node:process'],
        );
        expect(code.match(/from 'node:process'/g)?.length).toBe(1); // hoisted + deduped
        const mod = await run(code);
        expect(typeof mod.p).toBe('string');
        expect(typeof mod.arch).toBe('string');
    });

    it('shorthand object properties survive renames', async () => {
        const { code } = build({
            '/main.ts': ["import { pack } from './a';", 'const value = 5;', 'export const packed = pack(value);'].join('\n'),
            // `value` here collides with main's `value`; shorthand `{ value }` must expand
            '/a.ts': 'const value = 10;\nexport const pack = (v: number) => ({ value, v });',
        });
        const mod = await run(code);
        expect(mod.packed).toEqual({ value: 10, v: 5 });
    });

    it('type-only graphs produce runtime-clean output', async () => {
        const { code } = build({
            '/main.ts': [
                "import type { Shape } from './types';",
                "import { area } from './types';",
                'export const a: number = area({ w: 3, h: 4 } as Shape);',
            ].join('\n'),
            '/types.ts': [
                'export interface Shape { w: number; h: number }',
                'export type Alias = Shape;',
                'export const area = (s: Shape): number => s.w * s.h;',
            ].join('\n'),
        });
        expect(code).not.toMatch(/interface|Alias/);
        const mod = await run(code);
        expect(mod.a).toBe(12);
    });
});
