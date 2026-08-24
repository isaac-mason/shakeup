import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildCfg, verifyCfg } from '../src/analysis/cfg.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
import { bundle } from '../src/bundle.ts';
import { parse } from '../src/index.ts';
import { setLivenessDriver } from '../src/passes/optimize/dead-store.ts';

// crashcat as a corpus. It covers ground three.js structurally CANNOT:
//   • real multi-module TYPESCRIPT (97 modules), so the whole TS pipeline runs end to end
//   • it AUTHORS compilecat's directives — 32 `@optimize`, 10 `@inline`, 1 `@sroa` — making it the only
//     corpus that reaches the optimize tier at all, including the cross-module `@inline` path, which is
//     the single place in the system that creates cross-module cache dependencies
// three.core.js is a PREBUILT SINGLE-FILE JS bundle and can exercise none of that. Adding this corpus
// immediately surfaced a crash in the coalescing pass that three.js never reached, which is the whole
// argument for having it.
const ROOT = '/Users/isaacmason/Development/crashcat/src';
const ENTRY = `${ROOT}/index.ts`;
const EXTERNAL = ['math', 'math/shapes', 'three'];
const diskFs = {
    read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
};

const buildIt = async () =>
    (await bundle({ entry: ENTRY, fs: diskFs, external: EXTERNAL, output: { minify: true } })).code;

describe.skipIf(!existsSync(ENTRY))('crashcat corpus (real multi-module TS with directives)', () => {
    it('bundles, minifies, and round-trips as valid JS', async () => {
        const r = await bundle({ entry: ENTRY, fs: diskFs, external: EXTERNAL, output: { minify: true } });
        expect(r.chunks[0].moduleIds.length).toBeGreaterThan(50);
        expect(r.code.length).toBeGreaterThan(100_000);
        expect(() => parse(r.code, { ts: false, jsx: false })).not.toThrow();
    }, 180000);

    it('both liveness drivers produce identical output', async () => {
        // The Phase 2 differential, on the corpus that actually exercises the optimize tier.
        setLivenessDriver('structural');
        const a = await buildIt();
        setLivenessDriver('cfg');
        const b = await buildIt();
        setLivenessDriver('structural');
        expect(b).toBe(a);
    }, 240000);

    it('every function builds a well-formed CFG', () => {
        // Over the SOURCE modules, not the bundle, so TS-derived shapes are covered too.
        const files = ['index.ts', 'world.ts', 'solver.ts', 'contacts.ts', 'ccd.ts', 'debug.ts', 'filter.ts']
            .map((f) => `${ROOT}/${f}`)
            .filter((f) => existsSync(f));
        expect(files.length).toBeGreaterThan(0);
        let checked = 0;
        for (const f of files) {
            const { program } = parse(readFileSync(f, 'utf8'), { ts: true, jsx: false });
            const sem = createSemantic();
            analyze(sem, program);
            walk(program, (n) => {
                if (
                    n.type !== N.FunctionDeclaration &&
                    n.type !== N.FunctionExpression &&
                    n.type !== N.ArrowFunctionExpression
                )
                    return undefined;
                const body = (n.data as { body: Node | null }).body;
                if (body === null || body.type !== N.BlockStatement) return undefined;
                checked++;
                expect(verifyCfg(buildCfg(body))).toEqual([]);
                return undefined;
            });
        }
        expect(checked).toBeGreaterThan(20);
    }, 60000);
});
