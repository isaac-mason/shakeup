/**
 * Exemplar integration test — a self-contained mini-library ("puddle", a 2D
 * particle-physics toy) written in the crashcat house style, bundled and
 * executed end-to-end. It concentrates the constructs the bundler has to
 * survive: name collisions across modules, barrels + star/namespace re-exports,
 * a 3-deep named re-export chain, three enum flavors, a def-object registry with
 * a side-effect module, types everywhere, defaults (named + anonymous),
 * namespace-import calling style, deduped externals, shorthand/destructuring,
 * and one class with TS modifiers.
 *
 * Construct -> file map:
 *   collisions (add/dot/lengthSq/scale)   math/vec2.ts, math/vec3.ts
 *   barrels + star re-export              math/index.ts
 *   3-deep named re-export chain          math/index.ts -> scalar-barrel.ts -> scalar.ts
 *   enums (auto / flags / string)         motion.ts
 *   registry + side-effect module         shapes/{registry,circle,box,register-all}.ts
 *   types everywhere                      types.ts (+ import type across modules)
 *   defaults (named fn / anon object)     label.ts, config.ts
 *   namespace imports + `export * as`     sim/integrate.ts, main.ts
 *   externals (node:path, deduped)        label.ts, config.ts, types.ts (type-only)
 *   shorthand + destructuring             math/vec2.ts, emitter.ts, main.ts
 *   one class (TS modifiers)              emitter.ts
 *   entry (sim + re-exports)              main.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { parse } from '../src/parser.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'exemplar');

/** recursively load fixtures/exemplar into a memory-fs map keyed '/main.ts' etc */
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

/** strip // line and /* block *\/ comments so text assertions see only code.
 *  The fixtures are template-literal-free at the lines that matter; a naive
 *  strip is safe here and keeps the assertions honest (comments legitimately
 *  contain the words `export`, `import type`, `from 'node:path'`, etc). */
const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const built = bundle({ entry: '/main.ts', fs: createMemoryFs(loadFixtures()), external: ['node:path'] });

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
            label: 'shape:circle.ts', // basename('/a/b/circle.ts') keeps the ext
            gravity: 10,
            sepLen: 1,
            splatCollision: { x: 100, y: 200, splat: { x: 7, y: 7 } },
        });
        // registry.size === 2 proves the side-effect module ran exactly once
        expect(mod.registrySize).toBe(2);
        expect(mod.enums).toEqual({ motionName: 'DYNAMIC', collideBoth: 5, phaseLive: 'live' });
        // 3-deep named re-export chain resolved
        expect(mod.clamp).toBeTypeOf('function');
        // `export * as ops` namespace re-export object works
        const ops = mod.ops as Record<string, (a: unknown, b: unknown) => unknown>;
        expect(Object.keys(ops).sort()).toEqual(['add', 'create', 'dot', 'lengthSq', 'scale', 'splat']);
        expect(ops.add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
        expect(ops.dot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
    });

    it('emits exactly one deduped external import line for node:path', () => {
        // (comment-stripped: comments mention `from 'node:path'` on purpose)
        expect(stripComments(built.code).match(/from 'node:path'/g)?.length).toBe(1);
    });

    it('strips all TS type syntax from the output', () => {
        const c = stripComments(built.code);
        expect(c).not.toMatch(/\binterface\b/);
        expect(c).not.toMatch(/\bimport type\b/);
        expect(c).not.toMatch(/\bsatisfies\b/);
        // ParsedPath is a type-only external name — must never appear as a value
        expect(c).not.toMatch(/\bParsedPath\b/);
        // type aliases (Unwrap/Bounds/Dict/PathInfo) fully vanish
        expect(c).not.toMatch(/\bUnwrap\b/);
        expect(c).not.toMatch(/\bBounds\b/);
        // no return-type / var-type annotations survive: a `)` followed by a
        // `: Type` before `{`/`=>` would be an annotation. Enum member ACCESS
        // like `motion: MotionType.DYNAMIC` is a value (property init), not an
        // annotation, so we check the annotation-shaped form specifically.
        expect(c).not.toMatch(/\)\s*:\s*[A-Za-z_$][\w$.<>[\] |]*\s*(?:=>|\{)/);
    });

    it('has no stray export keywords beyond the final entry export statements', () => {
        const lines = stripComments(built.code).split('\n');
        const exportLines = lines.filter((l) => /\bexport\b/.test(l));
        // the ONLY surviving export(s) are the final entry export statement(s)
        for (const line of exportLines) {
            expect(line.trim()).toMatch(/^export (\{|\* )/);
        }
        // there is exactly one such statement (all exports collapse to one line)
        expect(exportLines.length).toBe(1);
    });

    it('self-oracle: our parser accepts the bundle with 0 errors', () => {
        const { errors } = parse(built.code, { ts: false });
        expect(errors).toEqual([]);
    });

    it('self-oracle: no duplicate top-level declarations; unresolved globals are exactly the expected set', () => {
        const { program, errors, nodeCount } = parse(built.code, { ts: false });
        expect(errors).toEqual([]);
        const sem = createSemantic();
        analyze(sem, program, nodeCount);

        // module-scope symbol names must be unique (deconflict guarantees this)
        const moduleScope = sem.nodeScope[program.id];
        const names: string[] = [];
        for (let sym = 1; sym < sem.symCount; sym++) {
            if (sem.symScope[sym] !== moduleScope) continue;
            names.push(sem.symDecl[sym]!.name);
        }
        expect(new Set(names).size).toBe(names.length);

        // unresolved globals: only real ambient globals. The hoisted external
        // (`basename`, `sep`) is bound by the top import, so it must NOT appear.
        const unresolved = new Set(sem.unresolved.map((n) => n.name));
        expect(unresolved.has('basename')).toBe(false);
        expect(unresolved.has('sep')).toBe(false);
        // whatever remains must be a known ambient global (Map/Object here)
        const allowedGlobals = new Set(['Map', 'Object', 'Math', 'console', 'undefined']);
        for (const g of unresolved) expect(allowedGlobals.has(g)).toBe(true);
    });
});

/**
 * Pinned KNOWN LIMITATIONS. Each reproduces a v1 gap the exemplar deliberately
 * sidesteps (see the comments at motion.ts's Collide enum). These tests pin the
 * CURRENT (broken) behavior; when the bundler fixes them, flip the assertion to
 * the spec-correct value and delete the sidestep note.
 */
describe('exemplar: pinned known limitations', () => {
    const buildOne = (files: Record<string, string>) =>
        bundle({ entry: '/main.ts', fs: createMemoryFs(files), external: [] });

    it('KNOWN LIMITATION: lowered enum does not qualify intra-enum member references', async () => {
        // `BOTH = A | B` should lower to `E[E["BOTH"] = E.A | E.B] = "BOTH"`
        // (tsc qualifies member refs). v1 emits bare `A | B` -> ReferenceError.
        // This is why the exemplar's Collide.BOTH is written as a literal `5`.
        const { code } = buildOne({
            '/main.ts': "import { E } from './e';\nexport const both = E.BOTH;",
            '/e.ts': 'export enum E { A = 1, B = 2, BOTH = A | B }',
        });
        // pin the broken emit: bare `A | B`, NOT `E.A | E.B`
        expect(code).toMatch(/E\["BOTH"\] = A \| B\]/);
        await expect(run(code)).rejects.toThrow(/A is not defined/);
    });

    it('KNOWN LIMITATION: namespace object snapshots mutated `let` exports (no live binding)', async () => {
        // `ns.count` reads the value frozen into the synthesized namespace object
        // at construction time, not the live (later-mutated) binding. Spec-correct
        // result is 1; v1 yields 0. The exemplar avoids mutated `let` exports.
        const { code } = buildOne({
            '/main.ts': [
                "import * as ns from './c';",
                "import { bump } from './c';",
                'bump();',
                'export const v = ns.count;',
            ].join('\n'),
            '/c.ts': 'export let count = 0;\nexport const bump = () => { count += 1; };',
        });
        const mod = await run(code);
        expect(mod.v).toBe(0); // pinned: live-binding fidelity would give 1
    });
});
