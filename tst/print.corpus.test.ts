import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emitModule, parse } from '../src/index.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';
import { astEqual, semanticEqual } from './print-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const THREE = resolve(REPO, 'llm/spikes/node_modules/three/build/three.core.js');
const CRASHCAT_SRC = resolve(REPO, '..', 'crashcat', 'src');

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

describe.skipIf(!existsSync(CRASHCAT_SRC))('printer — real corpus (crashcat TS strip-parity vs edit engine)', () => {
    const files = walkTs(CRASHCAT_SRC);

    it(`strips ${files.length} TS files identically to the edit engine`, () => {
        const failures: string[] = [];
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            const program = parse(src, { ts: true, jsx: false }).program;
            const p = createPrinter({ minify: false });
            let printed: string;
            try {
                printModule(p, program);
                printed = finishPrinter(p);
            } catch (e) {
                failures.push(`${file}: threw ${(e as Error).message}`);
                continue;
            }
            const edit = emitModule(parse(src, { ts: true, jsx: false }).program, src, { stripTypes: true });
            const a = parse(printed, { ts: false, jsx: false });
            const b = parse(edit, { ts: false, jsx: false });
            if (a.errors.length > 0) failures.push(`${file}: printed reparse errors: ${a.errors[0]?.msg}`);
            else if (b.errors.length === 0 && !astEqual(a.program, b.program))
                failures.push(`${file}: AST diverged from edit engine`);
        }
        expect(failures.slice(0, 20).join('\n')).toBe('');
    });
});
