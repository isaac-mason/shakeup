import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { VERSION } from '../src/bundler/version.ts';

// `src/bundler/version.ts` is a hand-written constant because it is bundled into browser builds, where
// there is no manifest to read. This is what stops it drifting from the manifest silently.
it('the reported version matches package.json', () => {
    const manifest = JSON.parse(
        readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(manifest.version);
});
