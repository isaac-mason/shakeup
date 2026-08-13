// Real-package fixtures: REAL package.json files harvested from packages on this
// machine (node_modules/ and llm/spikes/node_modules/), paired with tiny stub
// source files that export distinguishable literals. The package.jsons are the
// genuine published shapes (three, meriyah, @vitest/expect); react's is
// TRANSCRIBED verbatim from react@19.2.4 (marked with an _note field). Source
// files are shakeup stubs, never real package source.
//
// Lives on disk under tst/fixtures/resolve-real/ so enhanced-resolve can read it
// directly; this loader mirrors the same tree into a memory-Fs record for our
// plugin, keyed by the same real absolute paths.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the real-fixture root (contains node_modules/). */
export const REAL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'resolve-real');

/** Read the on-disk fixture tree into an absolute-path -> contents record. */
export function loadRealFixtures(): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else files[p] = readFileSync(p, 'utf8');
        }
    };
    walk(REAL_ROOT);
    return files;
}
