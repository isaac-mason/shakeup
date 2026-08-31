import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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

/** Toolchain code sitting at the top level rather than in one of those directories. Empty by design:
 *  `src/` is `index.ts` plus directories, and the third test below keeps it that way. Kept as a real
 *  hook rather than deleted, so a future top-level module has an obvious place to be declared. */
const TOOLCHAIN_FILES: string[] = [];

/** Above both halves: the two `exports` entries, which re-export across the boundary by design. */
const ENTRIES = ['index.ts', 'node'];

/** The bundler: everything rolldown would own. Since the split it is one directory, so the check is
 *  a single name — plus the package entry, which re-exports both halves, so reaching the bundler
 *  THROUGH it is the same violation wearing a different specifier. */
const BUNDLER = new Set(['bundler', 'index']);

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
    const corpus = [...TOOLCHAIN.flatMap((d) => tsFiles(join(SRC, d))), ...TOOLCHAIN_FILES.map((f) => join(SRC, f))];
    {
        for (const file of corpus) {
            const text = readFileSync(file, 'utf8');
            for (const re of SPECIFIERS) {
                for (const m of text.matchAll(re)) {
                    const spec = m[1];
                    if (!spec.startsWith('.')) continue; // a package, not our tree
                    // RESOLVE rather than pattern-match the specifier. A `spec.includes('../')` test
                    // reads as "stays inside its own directory", but that is only true for a file in
                    // a subdirectory: from top-level `src/sourcemap.ts`, `'./bundler/graph-types.ts'`
                    // escapes into the other half with no `../` in it at all. That heuristic silently
                    // exempted every top-level file, and a sabotage run is what exposed it.
                    const abs = resolve(dirname(file), spec);
                    if (!abs.startsWith(SRC)) continue; // outside src/ entirely
                    const head = abs.slice(SRC.length + 1).split(sep)[0].replace(/\.ts$/, '');
                    if (BUNDLER.has(head)) found.push(`${file.slice(SRC.length + 1)} -> ${spec}`);
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

    it('leaves no file under src/ unclassified', () => {
        // The hole this closes: the scan used to cover seven DIRECTORIES, so `sourcemap.ts`,
        // `estree.ts` and `jsx-text.ts` — 873 lines sitting at the top level — were invisible to it.
        // Two of those have since moved into scanned directories and `sourcemap.ts` is now named
        // explicitly, but naming it is not enough: the NEXT top-level file would be invisible too.
        // So require every entry under `src/` to be accounted for, and fail on anything new.
        const known = new Set([...TOOLCHAIN, ...TOOLCHAIN_FILES, ...ENTRIES, 'bundler']);
        const stray = readdirSync(SRC).filter((e) => !known.has(e));
        expect(stray).toEqual([]);
    });
});
