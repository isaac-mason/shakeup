import { describe, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundle } from '../src/bundle.ts';

// THE GATE THAT WAS MISSING. Every other corpus test validates output with `parse()` — shakeup's OWN
// parser — which `semantic.ts` documents as having "no TDZ or redeclaration diagnostics". So the one
// parser we checked against is the one guaranteed not to notice a redeclaration, and two real bugs
// shipped behind it: the mangler naming a body-scoped `let` after a parameter, and the optimize tier
// emitting `gt[0++]`. Byte-identical comparisons stayed green throughout because the output was
// STABLY invalid.
//
// `node --check` is an INDEPENDENT parser that is always available. Anything that does not parse there
// is not JavaScript, whatever our own front end thinks of it.
const diskFs = {
    read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
};
const DIR = mkdtempSync(join(tmpdir(), 'shakeup-validity-'));

function assertParses(code: string, label: string): void {
    const file = join(DIR, `${label.replace(/[^a-z0-9]+/gi, '-')}.mjs`);
    writeFileSync(file, code);
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
        const err = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
        const syntax = /SyntaxError.*/.exec(err)?.[0] ?? err.slice(0, 200);
        throw new Error(`${label}: node rejected the output — ${syntax}`);
    }
}

const THREE = 'llm/spikes/node_modules/three/build/three.core.js';
const CRASHCAT = '/Users/isaacmason/Development/crashcat/src/index.ts';

describe('emitted bundles are valid JavaScript (independent parser)', () => {
    const stages = [
        ['whitespace', { whitespace: true }],
        ['mangle', { whitespace: true, mangle: true }],
        ['compress', { whitespace: true, compress: true }],
        ['full', true],
    ] as const;

    describe.skipIf(!existsSync(THREE))('three.core.js', () => {
        for (const [name, minify] of stages) {
            it(`${name}`, async () => {
                const r = await bundle({ entry: THREE, fs: diskFs, output: { minify } });
                assertParses(r.code, `three-${name}`);
            }, 180000);
        }
    });

    describe.skipIf(!existsSync(CRASHCAT))('crashcat (TS, runs the optimize tier)', () => {
        for (const optimize of [false, true]) {
            for (const [name, minify] of stages) {
                it(`optimize=${optimize} ${name}`, async () => {
                    const r = await bundle({
                        entry: CRASHCAT,
                        fs: diskFs,
                        external: ['math', 'math/shapes', 'three'],
                        output: { minify, optimize },
                    });
                    assertParses(r.code, `cc-${optimize}-${name}`);
                }, 180000);
            }
        }
    });
});
