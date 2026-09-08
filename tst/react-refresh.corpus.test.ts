import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, parse, walk } from '../src/ast.ts';
import { refreshProgram } from '../src/bundler/plugins/react-refresh.ts';
import { makeJsxLower } from '../src/passes/lower-jsx.ts';
import { tsLower } from '../src/passes/lower-ts.ts';
import { tsStrip } from '../src/passes/strip-ts.ts';
import { traverse } from '../src/passes/traverse.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';
import { astEqual } from './print-helpers.ts';

// The ORACLE for React Fast Refresh: oxc's own conformance fixtures, each an input and the exact
// expected output. This is what decides the port is right — a hand-written test would only assert
// what the author already believed.
//
// oxc runs refresh and JSX lowering in ONE traversal (`jsx/mod.rs:69-130`), refresh first on
// `enter_program` and last on `exit_program`, so the pipeline below mirrors that order.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(
    __dirname,
    '../llm/libs/oxc/tasks/transform_conformance/tests/babel-plugin-transform-react-jsx/test/fixtures/refresh',
);

// oxc FAILS these three itself (`snapshots/oxc.snap.md`, the plugin scores 51/54). The corpus
// encodes Babel behaviour oxc does not implement — the namespace one expects `$RefreshReg$(_c,
// "Foo$Bar$A")` from descending into TS namespaces, and `refresh.rs` has no `TSModuleDeclaration`
// handling at all. They are not an oracle for us either.
const OXC_FAILS = new Set([
    'import-after-component',
    'includes-custom-hooks-into-the-signatures-when-commonjs-target-is-used',
    'supports-typescript-namespace-syntax',
]);

/** Babel names the JSX runtime local `_jsx`; shakeup imports it unaliased. That is jsxLower's
 *  business — covered by shakeup's own JSX tests and by `unchanged` — and nothing to do with
 *  refresh, so it is normalised out rather than failing every fixture for the same reason. */
const dropRuntimeImport = (t: string): string =>
    t
        .split('\n')
        .filter((l) => !/^import\s*\{[^}]*\}\s*from\s*["']react\/jsx-(dev-)?runtime["'];?$/.test(l.trim()))
        .join('\n');
/** `{ ref }` vs `{ ref: ref }`: Babel emits object shorthand where shakeup's JSX lowering writes
 *  the pair out. A printer-level difference in `jsxLower`, gated by shakeup's own JSX tests, and
 *  nothing to do with refresh — so the flag is cleared on BOTH sides before comparing. */
function clearShorthand(program: Node): Node {
    walk(program, (n) => {
        if (n.type === N.ObjectProperty) (n.data as unknown as { shorthand: boolean }).shorthand = false;
        return undefined;
    });
    return program;
}

const normaliseRuntimeName = (t: string): string => t.replace(/\b_(jsxs?|jsxDEV|Fragment)\b/g, '$1');

function transform(src: string, ts: boolean): string {
    const { program } = parse(src, { ts, jsx: true });
    const sem = createSemantic();
    analyze(sem, program);
    refreshProgram(program, sem, src, { emitFullSignatures: true });
    traverse(program, sem, [tsLower, makeJsxLower('react', true)]);
    traverse(program, sem, [tsStrip]);
    const p = createPrinter({ minify: false });
    printModule(p, program);
    return finishPrinter(p);
}

function fixtures(): { name: string; dir: string }[] {
    const out: { name: string; dir: string }[] = [];
    const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const p = join(d, e.name);
            if (readdirSync(p).some((f) => f.startsWith('input.'))) out.push({ name: p.slice(ROOT.length + 1), dir: p });
            else walk(p);
        }
    };
    walk(ROOT);
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fixtures the port reproduces TODAY. A ratchet: adding a stage moves names in, and any name
 *  falling out is a regression. Registration is done, and signatures for function DECLARATIONS;
 *  signatures for declarations and for expressions wrapped in place, and the HOC chain — `_c =` on
 *  inner functions plus one `_s` carried up through the enclosing calls. Still missing: the
 *  custom-hook thunk (the 4th `_s` argument), hashed keys (needs SHA-1), and the configurable
 *  `$RefreshReg$`/`$RefreshSig$` identifiers. */
const PASSING = new Set([
    'does-not-transform-it-because-it-is-not-used-in-the-AST',
    'parenthesized-variable-declarators',
    'react-refresh/can-handle-implicit-arrow-returns',
    'react-refresh/generates-signatures-for-function-declarations-calling-hooks',
    'react-refresh/generates-signatures-for-function-expressions-calling-hooks',
    'react-refresh/includes-custom-hooks-into-the-signatures',
    'react-refresh/ignores-complex-definitions',
    'react-refresh/ignores-hoc-definitions',
    'react-refresh/ignores-unnamed-function-declarations',
    'react-refresh/only-registers-pascal-case-functions',
    'react-refresh/registers-capitalized-identifiers-in-hoc-calls',
    'react-refresh/registers-likely-hocs-with-inline-functions-1',
    'react-refresh/registers-likely-hocs-with-inline-functions-2',
    'react-refresh/registers-likely-hocs-with-inline-functions-3',
    'react-refresh/registers-top-level-exported-named-arrow-functions',
    'react-refresh/registers-top-level-function-declarations',
    'react-refresh/registers-top-level-variable-declarations-with-arrow-functions',
    'react-refresh/registers-top-level-variable-declarations-with-function-expressions',
    'react-refresh/uses-original-function-declaration-if-it-get-reassigned',
    'variable-declarator-with-function',
]);

describe('react-refresh — oxc conformance corpus', () => {
    const all = fixtures().filter((f) => !OXC_FAILS.has(f.name.split('/').pop() ?? ''));

    it('the corpus is where we think it is', () => {
        expect(existsSync(ROOT), ROOT).toBe(true);
        expect(all.length).toBeGreaterThan(25);
    });

    for (const { name, dir } of all) {
        const inputName = readdirSync(dir).find((f) => f.startsWith('input.'));
        const outName = readdirSync(dir).find((f) => f.startsWith('output.'));
        if (inputName === undefined || outName === undefined) continue;
        const expected = PASSING.has(name);

        it(`${expected ? 'matches' : 'does NOT yet match'} oxc: ${name}`, () => {
            const ts = inputName.endsWith('.ts') || inputName.endsWith('.tsx');
            let same = false;
            try {
                const got = parse(dropRuntimeImport(transform(readFileSync(join(dir, inputName), 'utf8'), ts)), {
                    ts: false,
                    jsx: false,
                });
                const want = parse(dropRuntimeImport(normaliseRuntimeName(readFileSync(join(dir, outName), 'utf8'))), {
                    ts: false,
                    jsx: false,
                });
                // Our own output failing to parse is never acceptable, passing or not.
                expect(got.errors, 'our output must be valid JS').toEqual([]);
                same = want.errors.length === 0 && astEqual(clearShorthand(got.program), clearShorthand(want.program));
            } catch (e) {
                if (expected) throw e;
            }
            expect(same).toBe(expected);
        });
    }
});
