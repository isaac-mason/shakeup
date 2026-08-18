import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, createSemantic, devTransform, type Node, parse } from '../src/index.ts';
import { assembleRunner, createRunnerCtx, moduleRunnerPass } from '../src/pass/module-runner.ts';
import { runPass } from '../src/pass/traverse.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';
import { astEqual } from './print-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF_SRC = resolve(__dirname, '..', 'src');

function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) out.push(...walkTs(p));
        else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

/** The Branch-A dev path: strip/JSX in the printer, structural rewrite as a mutation pass. */
function devViaPass(src: string, tsx: boolean): string {
    const { program } = parse(src, { ts: true, jsx: tsx });
    const semantic = createSemantic();
    analyze(semantic, program);
    const ctx = createRunnerCtx(src, semantic);
    runPass(program as Node, moduleRunnerPass, ctx);
    const p = createPrinter({ minify: false }); // strips TS while printing
    printModule(p, program);
    return assembleRunner(ctx, finishPrinter(p));
}

describe('dev path parity — pass+printer vs edit-based devTransform (shakeup src/ corpus)', () => {
    const files = walkTs(SELF_SRC);

    it(`reproduces devTransform for ${files.length} real TS modules`, () => {
        const failures: string[] = [];
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            const edit = devTransform(file, src, {});
            if (edit.errors.length > 0) continue; // skip anything the edit path rejects
            let mine: string;
            try {
                mine = devViaPass(src, false);
            } catch (e) {
                failures.push(`${file}: pass threw ${(e as Error).message}`);
                continue;
            }
            const a = parse(mine, { ts: false, jsx: false });
            const b = parse(edit.code, { ts: false, jsx: false });
            if (a.errors.length > 0) failures.push(`${file}: pass output reparse error: ${a.errors[0]?.msg}`);
            else if (b.errors.length === 0 && !astEqual(a.program, b.program)) failures.push(`${file}: diverged from devTransform`);
        }
        expect(failures.slice(0, 15).join('\n')).toBe('');
    });
});
