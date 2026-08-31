import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// A failed build still returns a `BundleResult`, and what it carries is API surface: a caller reads
// `result.errors`, but also `result.graph` / `.linked` / `.shaken` to see how far the build got and
// `result.warnings` for anything reported along the way.
//
// Six sites used to construct that result by hand, and they disagreed. Two of the disagreements were
// oversights rather than intent, and these pin the corrected behaviour so the next hand-rolled
// failure path cannot quietly reintroduce them.
describe('a failed build reports the state it reached', () => {
    it('keeps warnings raised before the failure', async () => {
        // The scan/link failure paths returned `warnings: []`, discarding plugin `this.warn()`
        // output and every scan warning — so a plugin could warn about the very thing that then
        // broke the build and the caller would never see it.
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({ '/main.js': "import './nope.js';" }),
            plugins: [
                {
                    name: 'w',
                    buildStart() {
                        (this as unknown as { warn: (m: string) => void }).warn('reported before the failure');
                    },
                },
            ],
        });
        expect(r.errors.length).toBeGreaterThan(0);
        expect(r.warnings).toContain('reported before the failure');
    });

    it('reports linked and shaken when the failure is after them', async () => {
        // `inlineDynamicImports` + `manualChunks` is rejected by chunk-option resolution, which runs
        // AFTER link and tree-shake. That path used to return `linked: null, shaken: null` while
        // holding both.
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({ '/main.js': 'export const a = 1;' }),
            output: { inlineDynamicImports: true, manualChunks: { vendor: ['/main.js'] } },
        });
        expect(r.errors.length).toBe(1);
        expect(r.graph).not.toBeNull();
        expect(r.linked).not.toBeNull();
        expect(r.shaken).not.toBeNull();
    });

    it('reports null for stages the build never reached', async () => {
        // The other direction: a scan failure genuinely has no link or shake result, and must not
        // pretend otherwise.
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({ '/main.js': "import './nope.js';" }),
        });
        expect(r.errors.length).toBeGreaterThan(0);
        expect(r.linked).toBeNull();
        expect(r.shaken).toBeNull();
    });
});
