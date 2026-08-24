import { defineConfig } from '@pmndrs/labs';

export default defineConfig({
    benchDir: '.',
    benchMatch: '**/*.bench.ts',
    // The default 5s budget cannot converge the heavier bundle benches: a minified 300-module build
    // runs ~150ms/iter, so 5s buys ~33 samples — and this machine's CPU drifts >100% (Apple Silicon
    // offers no frequency pinning), which is exactly the case adaptive sampling needs samples to see
    // through. At 5s labs correctly flagged 5 of 6 minify benches `noisy`, i.e. it refused to report a
    // verdict it could not support. Raising the ceiling lets them converge; benches that already
    // converge stop early and are unaffected.
    maxCpuTime: 60,
});
