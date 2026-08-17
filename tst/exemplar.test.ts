import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, createSemantic, scopeOf } from '../src/analysis/semantic.ts';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { parse } from '../src/parser.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'exemplar');

function loadFixtures(): Map<string, string> {
    const map = new Map<string, string>();
    const walkDir = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walkDir(full);
            else if (entry.endsWith('.ts')) map.set(`/${relative(FIXTURE_ROOT, full)}`, readFileSync(full, 'utf8'));
        }
    };
    walkDir(FIXTURE_ROOT);
    return map;
}

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const built = await bundle({ entry: '/main.ts', fs: createMemoryFs(loadFixtures()), external: ['node:path'] });

describe('exemplar: the puddle mini-library bundles + executes', () => {
    it('bundles with no errors or warnings', () => {
        expect(built.errors).toEqual([]);
        expect(built.warnings).toEqual([]);
    });

    it('executes and every exported value is exact', async () => {
        const mod = await run(built.code);
        expect(mod.snapshot).toEqual({
            finalPos: { x: 4, y: 2 },
            spawnA: { x: 11, y: 0 },
            spawnB: { x: 12, y: 0 },
            total: 2,
            circleArea: 12,
            boxArea: 4,
            clamped: 3,
            label: 'shape:circle.ts',
            gravity: 10,
            sepLen: 1,
            splatCollision: { x: 100, y: 200, splat: { x: 7, y: 7 } },
        });
        expect(mod.registrySize).toBe(2);
        expect(mod.enums).toEqual({ motionName: 'DYNAMIC', collideBoth: 5, phaseLive: 'live' });
        expect(mod.clamp).toBeTypeOf('function');
        const ops = mod.ops as Record<string, (a: unknown, b: unknown) => unknown>;
        expect(Object.keys(ops).sort()).toEqual(['add', 'create', 'dot', 'lengthSq', 'scale', 'splat']);
        expect(ops.add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
        expect(ops.dot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
    });

    it('emits exactly one deduped external import line for node:path', () => {
        expect(stripComments(built.code).match(/from 'node:path'/g)?.length).toBe(1);
    });

    it('strips all TS type syntax from the output', () => {
        const c = stripComments(built.code);
        expect(c).not.toMatch(/\binterface\b/);
        expect(c).not.toMatch(/\bimport type\b/);
        expect(c).not.toMatch(/\bsatisfies\b/);
        expect(c).not.toMatch(/\bParsedPath\b/);
        expect(c).not.toMatch(/\bUnwrap\b/);
        expect(c).not.toMatch(/\bBounds\b/);
        expect(c).not.toMatch(/\)\s*:\s*[A-Za-z_$][\w$.<>[\] |]*\s*(?:=>|\{)/);
    });

    it('has no stray export keywords beyond the final entry export statements', () => {
        const lines = stripComments(built.code).split('\n');
        const exportLines = lines.filter((l) => /\bexport\b/.test(l));
        for (const line of exportLines) {
            expect(line.trim()).toMatch(/^export (\{|\* )/);
        }
        expect(exportLines.length).toBe(1);
    });

    it('self-oracle: our parser accepts the bundle with 0 errors', () => {
        const { errors } = parse(built.code, { ts: false, jsx: false });
        expect(errors).toEqual([]);
    });

    it('self-oracle: no duplicate top-level declarations; unresolved globals are exactly the expected set', () => {
        const { program, errors } = parse(built.code, { ts: false, jsx: false });
        expect(errors).toEqual([]);
        const sem = createSemantic();
        analyze(sem, program);

        const moduleScope = scopeOf(sem, program);
        const names: string[] = [];
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            if (sem.symbols[sym].scope !== moduleScope) continue;
            names.push(sem.symbols[sym].decl!.name);
        }
        expect(new Set(names).size).toBe(names.length);

        const unresolved = new Set(sem.unresolved.map((n) => n.name));
        expect(unresolved.has('basename')).toBe(false);
        expect(unresolved.has('sep')).toBe(false);
        const allowedGlobals = new Set(['Map', 'Object', 'Math', 'console', 'undefined']);
        for (const g of unresolved) expect(allowedGlobals.has(g)).toBe(true);
    });
});

describe('exemplar: pinned known limitations', () => {
    const buildOne = async (files: Record<string, string>) => bundle({ entry: '/main.ts', fs: createMemoryFs(files), external: [] });

    it('lowered enum qualifies intra-enum member references (A | B → E.A | E.B)', async () => {
        const { code } = await buildOne({
            '/main.ts': "import { E } from './e';\nexport const both = E.BOTH;",
            '/e.ts': 'export enum E { A = 1, B = 2, BOTH = A | B }',
        });
        // prior-member refs are qualified to the enum object, so BOTH = 1 | 2 = 3.
        expect(code).toMatch(/\["BOTH"\] = \w+\.A \| \w+\.B\]/);
        const ns = await run(code);
        expect(ns.both).toBe(3);
    });

    it('KNOWN LIMITATION: namespace object snapshots mutated `let` exports (no live binding)', async () => {
        const { code } = await buildOne({
            '/main.ts': [
                "import * as ns from './c';",
                "import { bump } from './c';",
                'bump();',
                'export const v = ns.count;',
            ].join('\n'),
            '/c.ts': 'export let count = 0;\nexport const bump = () => { count += 1; };',
        });
        const mod = await run(code);
        expect(mod.v).toBe(0);
    });
});
