import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { setSemanticVerify } from '../src/analysis/ref-facts.ts';

// Coverage for the CROSS-MODULE `@inline` path (`bundle.ts`'s `inlineCrossModule`), which neither
// corpus exercises — crashcat and three.core.js both run exactly one `analyze` per module, so the
// re-analysis this path performs never fired and the code was untested.
//
// That mattered when removing the last per-module rebuild: a green gate proves nothing about a branch
// nothing takes. This fixture takes it (measured: 3 `analyze` calls for 2 modules before the rebuild
// was removed), so the maintained semantic is genuinely checked here.
const fs = createMemoryFs({
    '/helper.ts': '/* @inline */ export function addOne(x: number): number { return x + 1; }\n',
    '/e.ts':
        'import { addOne } from "./helper.ts";\n' +
        '/* @optimize */ export function run(n: number): number { const a = addOne(n); const b = addOne(a); return a + b; }\n' +
        'globalThis.sink = run(Number(globalThis.input));\n',
});

describe('cross-module @inline keeps the semantic in step', () => {
    it('inlines an imported helper and emits correct code', { timeout: 60_000 }, async () => {
        setSemanticVerify(true);
        let code: string;
        try {
            const r = await bundle({ entry: '/e.ts', fs, external: [], output: { minify: true, optimize: true } } as never);
            code = (r as { code: string }).code;
        } finally {
            setSemanticVerify(false);
        }
        // The helper is gone — it was spliced into both call sites.
        expect(code).not.toMatch(/addOne\s*\(/);
        // And the result is right: addOne(5)=6, addOne(6)=7, 6+7=13.
        const g: Record<string, unknown> = { input: 5 };
        new Function('globalThis', code.replace(/^export\s*\{[^}]*\};?\s*$/m, ''))(g);
        expect(g.sink).toBe(13);
    });
});
