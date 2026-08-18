import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { devTransform, parse } from '../src/index.ts';

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

// Independent-truth breadth: devTransform must accept the full range of real TS in our own src/ and
// always produce valid runner JS (reparse-as-JS with no errors ⇒ types erased, protocol well-formed).
describe('devTransform — real TS corpus (shakeup src/)', () => {
    const files = walkTs(SELF_SRC);

    it(`lowers ${files.length} real TS modules to valid runner JS`, () => {
        const failures: string[] = [];
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            const r = devTransform(file, src, {});
            if (r.errors.length > 0) {
                failures.push(`${file}: ${r.errors[0]}`);
                continue;
            }
            const reparsed = parse(r.code, { ts: false, jsx: false });
            if (reparsed.errors.length > 0) failures.push(`${file}: output not valid JS: ${reparsed.errors[0]?.msg}`);
        }
        expect(failures.slice(0, 15).join('\n')).toBe('');
    });
});
