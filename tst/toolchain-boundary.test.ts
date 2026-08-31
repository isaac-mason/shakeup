import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// shakeup contains two things its references keep in separate crates: a language toolchain (oxc's
// job — parse, analyse, transform, print) and a bundler (rolldown's job — scan, link, chunk, emit).
// rolldown depends on oxc; nothing in oxc knows a bundler exists.
//
// shakeup keeps that same direction, and has almost always kept it — a scan across every reference
// form found exactly TWO violations in ~15k lines of toolchain code, both of which were misplaced
// code rather than real dependencies (`base54`, a digit encoder, and `stampPureCallsGraph`, a
// bundler-stage driver sitting in `analysis/`). Both are fixed.
//
// This test is what stops the third one. The invariant costs nothing to keep and is invisible to
// break: an `import { Linked } from '../graph-types.ts'` in a pass compiles, passes every other
// test, and quietly makes the toolchain half depend on the bundler's data model.
//
// See `llm/notes/bundler-toolchain-split-plan.md`.

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** The language toolchain: everything oxc would own. */
const TOOLCHAIN = ['ast', 'parser', 'analysis', 'passes', 'print', 'mangle', 'util'];

/** The bundler: everything rolldown would own. Modules, not paths — matched on the first segment
 *  of a relative specifier that escapes the toolchain directory. */
const BUNDLER = new Set([
    'scan',
    'link',
    'bundle',
    'chunk-graph',
    'treeshake',
    'deconflict',
    'graph-types',
    'init-obligations',
    'chunk-compress',
    'resolve',
    'node-resolve',
    'loaders',
    'plugin',
    'output-options',
    'patches',
    'transform',
    'watch',
    'fs',
    'purity-graph',
    'generate',
    'plugins',
    'runtime',
    // The package entry re-exports both halves, so reaching the bundler THROUGH it is the same
    // violation wearing a different specifier.
    'index',
]);

/** Every reference form, not just `import … from`. A dynamic import or a re-export is the same edge. */
const SPECIFIERS = [/from\s+'([^']+)'/g, /import\s*\(\s*'([^']+)'\s*\)/g, /require\s*\(\s*'([^']+)'\s*\)/g];

function tsFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) tsFiles(p, out);
        else if (e.endsWith('.ts')) out.push(p);
    }
    return out;
}

/** Bundler modules referenced from a toolchain file, as `file -> specifier` strings. */
function crossHalfImports(): string[] {
    const found: string[] = [];
    for (const dir of TOOLCHAIN) {
        for (const file of tsFiles(join(SRC, dir))) {
            const text = readFileSync(file, 'utf8');
            for (const re of SPECIFIERS) {
                for (const m of text.matchAll(re)) {
                    const spec = m[1];
                    if (!spec.startsWith('.')) continue; // a package, not our tree
                    if (!spec.includes('../')) continue; // stays inside its own directory
                    const head = spec.split('/').filter((p) => p !== '.' && p !== '..')[0];
                    if (head !== undefined && BUNDLER.has(head.replace(/\.ts$/, '')))
                        found.push(`${file.slice(SRC.length + 1)} -> ${spec}`);
                }
            }
        }
    }
    return [...new Set(found)].sort();
}

describe('the language toolchain does not depend on the bundler', () => {
    it('has no imports from a bundler module', () => {
        const violations = crossHalfImports();
        if (violations.length > 0)
            expect.fail(
                `\nThe language toolchain must not import the bundler:\n${violations.map((v) => `  ${v}`).join('\n')}\n\n` +
                    `Either the code belongs on the bundler side, or what it needs does — a value used by both ` +
                    `(a pure utility, a shared type) belongs in the toolchain half, not behind a bundler import.\n`,
            );
    });

    it('is checking the directories it claims to', () => {
        // A boundary test that scans nothing passes forever. Pin the corpus it actually reads.
        const scanned = TOOLCHAIN.flatMap((d) => tsFiles(join(SRC, d)));
        expect(scanned.length).toBeGreaterThan(60);
    });
});
