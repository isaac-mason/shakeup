import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parse } from '../src/index.ts';
import { makeJsxLower } from '../src/passes/lower-jsx.ts';
import { tsLower } from '../src/passes/lower-ts.ts';
import { tsStrip } from '../src/passes/strip-ts.ts';
import { traverse } from '../src/passes/traverse.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';
import { astEqual, semanticEqual } from './print-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const THREE = resolve(REPO, 'llm/spikes/node_modules/three/build/three.core.js');
const CRASHCAT_SRC = resolve(REPO, '..', 'crashcat', 'src');
const SELF_SRC = resolve(REPO, 'src');
const JSX_DIR = resolve(REPO, 'tst', 'fixtures', 'jsx');

function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) out.push(...walkTs(p));
        else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

describe('printer — real corpus (three.core.js, pure JS round-trip)', () => {
    const source = readFileSync(THREE, 'utf8');
    const original = parse(source, { ts: false, jsx: false }).program;

    for (const minify of [false, true]) {
        it(`round-trips structurally (minify:${minify})`, () => {
            const p = createPrinter({ minify });
            printModule(p, original);
            const printed = finishPrinter(p);
            const reparsed = parse(printed, { ts: false, jsx: false });
            expect(reparsed.errors).toEqual([]);
            const eq = minify ? semanticEqual : astEqual;
            expect(eq(original, reparsed.program)).toBe(true);
        });
    }
});

// Strip breadth: the printer must handle the full range of real TS syntax and always emit valid,
// type-free JS (reparse-as-JS with no errors ⇒ every type node was erased and nothing was left
// syntactically broken). Curated semantic parity lives in print.test.ts (vs esbuild).
function stripBreadth(files: string[]): string[] {
    const failures: string[] = [];
    for (const file of files) {
        const src = readFileSync(file, 'utf8');
        const isx = file.endsWith('.tsx');
        const p = createPrinter({ minify: false });
        try {
            const { program } = parse(src, { ts: true, jsx: isx });
            const sem = createSemantic();
            analyze(sem, program);
            traverse(program, sem, isx ? [tsLower, makeJsxLower('react', true)] : [tsLower]);
            traverse(program, sem, [tsStrip]);
            printModule(p, program);
        } catch (e) {
            failures.push(`${file}: printer threw ${(e as Error).message}`);
            continue;
        }
        const reparsed = parse(finishPrinter(p), { ts: false, jsx: false });
        if (reparsed.errors.length > 0) failures.push(`${file}: stripped output is not valid JS: ${reparsed.errors[0]?.msg}`);
    }
    return failures;
}

describe('printer — self corpus (shakeup src/, TS strip breadth)', () => {
    const files = walkTs(SELF_SRC);
    it(`strips ${files.length} of our own TS files to valid JS`, () => {
        expect(stripBreadth(files).slice(0, 20).join('\n')).toBe('');
    });
});

describe.skipIf(!existsSync(CRASHCAT_SRC))('printer — real corpus (crashcat TS strip breadth)', () => {
    const files = walkTs(CRASHCAT_SRC);
    it(`strips ${files.length} TS files to valid JS`, () => {
        expect(stripBreadth(files).slice(0, 20).join('\n')).toBe('');
    });
});

describe('printer — JSX corpus (lowers every fixture to valid JS)', () => {
    const files = readdirSync(JSX_DIR)
        .filter((f) => f.endsWith('.jsx') || f.endsWith('.tsx'))
        .map((f) => join(JSX_DIR, f));

    it(`lowers ${files.length} JSX/TSX fixtures — no JSX survives`, () => {
        const failures: string[] = [];
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            const ts = file.endsWith('.tsx');
            const p = createPrinter({ minify: false });
            try {
                const { program } = parse(src, { ts, jsx: true });
                const sem = createSemantic();
                analyze(sem, program);
                traverse(program, sem, [makeJsxLower('react', true)]);
                printModule(p, program);
            } catch (e) {
                failures.push(`${file}: printer threw ${(e as Error).message}`);
                continue;
            }
            // Reparse as plain JS (jsx:false): any surviving JSX node would be a parse error.
            const reparsed = parse(finishPrinter(p), { ts: false, jsx: false });
            if (reparsed.errors.length > 0) failures.push(`${file}: lowered output not valid JS: ${reparsed.errors[0]?.msg}`);
        }
        expect(failures.slice(0, 20).join('\n')).toBe('');
    });
});

describe('printer — pathological JS round-trip (ASI / precedence / paren minimality)', () => {
    const CASES: string[] = [
        // precedence / parenthesization
        '(a + b) * c;',
        'a ** b ** c;',
        '(-2) ** 2;',
        '!(a || b) && c;',
        'a ? b : c ? d : e;',
        '(a, b).c;',
        'new (foo())();',
        'new foo().bar;',
        '(function () {})();',
        '({}).x;',
        'a => ({ x: 1 });',
        '(a || b) ?? c;',
        'typeof -a;',
        // unary spacing (ASI-adjacent)
        'a - -b;',
        'a + +b;',
        '- -a;',
        // regex vs divide
        'let x = a / b / c;',
        'let r = /ab+/g.test(s);',
        'foo(/re/, 1 / 2);',
        // ASI hazards
        'function f() { return\n a; }',
        'let a = 1\n let b = 2',
        // member / call / optional chain
        'a?.b?.()?.[c];',
        'a.b.c().d;',
        // literals + templates + keys
        'const o = { 0: 1, "a-b": 2, c, [d]: 3 };',
        'const t = `x${a + b}y${c}`;',
        // destructuring
        'const [, x, , y = 1, ...r] = arr;',
        'const { a = 1, b: { c } = {}, ...rest } = o;',
        // class corner
        'class C { static #x = 1; #m() { return #x in this; } get y() { return 1; } }',
        // sequence / comma in for
        'for (let i = 0, j = 1; i < j; i++, j--) {}',
    ];

    it(`round-trips ${CASES.length} pathological cases (both minify modes)`, () => {
        const failures: string[] = [];
        for (const src of CASES) {
            const original = parse(src, { ts: false, jsx: false });
            if (original.errors.length > 0) {
                failures.push(`parse failed (test bug): ${JSON.stringify(src)} — ${original.errors[0]?.msg}`);
                continue;
            }
            for (const minify of [false, true]) {
                const p = createPrinter({ minify });
                let printed: string;
                try {
                    printModule(p, original.program);
                    printed = finishPrinter(p);
                } catch (e) {
                    failures.push(`minify:${minify} threw on ${JSON.stringify(src)}: ${(e as Error).message}`);
                    continue;
                }
                const reparsed = parse(printed, { ts: false, jsx: false });
                if (reparsed.errors.length > 0)
                    failures.push(
                        `minify:${minify} reparse errors on ${JSON.stringify(src)} → ${JSON.stringify(printed)}: ${reparsed.errors[0]?.msg}`,
                    );
                else {
                    const eq = minify ? semanticEqual : astEqual;
                    if (!eq(original.program, reparsed.program))
                        failures.push(`minify:${minify} diverged on ${JSON.stringify(src)} → ${JSON.stringify(printed)}`);
                }
            }
        }
        expect(failures.join('\n')).toBe('');
    });
});
