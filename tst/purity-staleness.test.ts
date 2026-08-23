import { describe, expect, it } from 'vitest';
import { createBuildContext } from '../src/bundle.ts';
import { isPureExpr, markInferredPure, resetInferredPure } from '../src/analysis/effects.ts';
import type { Fs } from '../src/fs.ts';
import { N, walk } from '../src/ast.ts';
import { parse } from '../src/index.ts';

function mutableFs(files: Record<string, string>): Fs {
    return { read: (id) => files[id] ?? null, exists: (id) => id in files };
}

// Purity verdicts are derived from ANOTHER module's body, and a consumer's AST is cached across
// rebuilds with the SAME node objects. If last build's verdicts survive, a call stamped pure stays
// pure after its callee gains a side effect — the next build simply declines to re-stamp it while the
// stale stamp still says "pure", and a deletion pass drops a call that now has effects.
//
// Unlike `@inline`, nothing is baked into the consumer's AST here, so the fix is to CLEAR the verdicts
// each build rather than to track a dependency. That keeps purity out of the cached-cross-module-state
// category entirely.
describe('inferred purity does not survive a build', () => {
    const callNode = (src: string) => {
        let call: ReturnType<typeof parse>['program'] | null = null;
        walk(parse(src, { ts: false, jsx: false }).program, (n) => {
            if (n.type === N.CallExpression && call === null) call = n as never;
            return undefined;
        });
        return call! as never as Parameters<typeof markInferredPure>[0];
    };

    it('a stamped call stops being pure after a reset', () => {
        const call = callNode('f();');
        expect(isPureExpr(call)).toBe(false); // unstamped: a call is impure by default

        markInferredPure(call);
        expect(isPureExpr(call)).toBe(true); // the analysis proved it pure this build

        resetInferredPure();
        // The SAME node object — as a cached module's would be on the next build. Its verdict must be
        // gone, so the new build re-derives it instead of inheriting a stale one.
        expect(isPureExpr(call)).toBe(false);
    });

    it('a rebuild after the callee changes matches a cold build', async () => {
        const mk = (body: string): Record<string, string> => ({
            '/lib.js': `export function eff() { ${body} return 1; }`,
            '/entry.js': 'import { eff } from "./lib.js";\neff();\nexport const out = 1;',
        });
        const files = mk('');
        const ctx = createBuildContext({ entry: '/entry.js', fs: mutableFs(files), external: [] });
        await ctx.rebuild();
        files['/lib.js'] = mk('globalThis.__hit = 1;')['/lib.js'];
        const warm = await ctx.rebuild();

        const cold = await createBuildContext({
            entry: '/entry.js',
            fs: mutableFs(mk('globalThis.__hit = 1;')),
            external: [],
        }).rebuild();
        expect(warm.code).toBe(cold.code);
        expect(warm.code).toContain('__hit'); // the new side effect survives
    });
});
