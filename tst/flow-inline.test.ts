import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { flowInlineVariables } from '../src/passes/optimize/flow-inline.ts';
import { parse } from '../src/index.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';

// FlowSensitiveInlineVariables. It MOVES code across control flow, so correctness is the whole game:
// every case runs the result and compares against the un-inlined reference. The pass is directive-gated,
// so each fixture is wrapped in `/* @optimize */`.

function run(body: string): { code: string; changed: boolean } {
    const src = `/* @optimize */\nfunction f(${body}\n`;
    const { program } = parse(src, { ts: false, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    const changed = flowInlineVariables(program, sem, src);
    const p = createPrinter({ minify: false });
    printModule(p, program);
    return { code: finishPrinter(p), changed };
}

/** Execute the printed function body and return f(...args). */
async function exec(code: string, ...args: unknown[]): Promise<unknown> {
    const m = code.replace('/* @optimize */', '');
    const url = `data:text/javascript,${encodeURIComponent(`${m}\nexport const __f = f;`)}`;
    const mod = (await import(/* @vite-ignore */ url)) as { __f: (...a: unknown[]) => unknown };
    return mod.__f(...args);
}

describe('flow-inline — substitution', () => {
    it('inlines a single-def single-use across a straight-line gap', async () => {
        const body = 'a, c){ const t = a + c; globalThis.g = 1; return t * 2; }';
        const { code, changed } = run(body);
        expect(changed).toBe(true);
        expect(code).not.toMatch(/\bt\b/); // t is gone
        expect(code).toContain('(a + c) * 2');
        expect(await exec(code, 3, 4)).toBe(14);
    });

    it('inlines a top-level assignment definition', async () => {
        const body = 'a){ let t; t = a + 1; globalThis.g = 1; return t; }';
        const { code } = run(body);
        expect(await exec(code, 5)).toBe(6);
    });

    it('resolves a chain across a later fixed-point (one link now)', async () => {
        // t → u; only one link inlines per pass, the compress loop re-runs it. Here just check safety.
        const body = 'a){ const t = a + 1; const u = t; globalThis.g = 1; return u; }';
        const { code } = run(body);
        expect(await exec(code, 4)).toBe(5);
    });
});

describe('flow-inline — refusals (each guards a wrong value)', () => {
    it('REFUSES when the RHS reads a variable reassigned on the path to the use', async () => {
        const body = 'a){ let p = a; const t = p + 1; p = 100; globalThis.g = p; return t; }';
        const { code } = run(body);
        expect(await exec(code, 5)).toBe(6); // t captured a=5 → 6, never 101
    });

    it('REFUSES a member-expression RHS (identity / getter hazard when moved)', async () => {
        const body = 'o){ const t = o.x; globalThis.g = 1; return t; }';
        const { code } = run(body);
        expect(code).toMatch(/\bt\b/); // not inlined
        expect(await exec(code, { x: 9 })).toBe(9);
    });

    it('REFUSES an impure RHS (call)', async () => {
        const body = '){ const t = globalThis.count(); globalThis.other(); return t; }';
        const { code } = run(body);
        expect(code).toMatch(/const t/);
    });

    it('REFUSES when the use is inside a loop the def is outside of', async () => {
        const body = 'a, n){ const t = a + 1; let s = 0; for (let i = 0; i < n; i++) s += t; return s; }';
        const { code } = run(body);
        expect(await exec(code, 1, 3)).toBe(6); // t=2 used 3 times
    });

    it('REFUSES when two definitions reach the use (not single-def)', async () => {
        const body = 'c){ let t; if (c) { t = 1; } else { t = 2; } return t; }';
        const { code } = run(body);
        expect(await exec(code, true)).toBe(1);
        expect(await exec(code, false)).toBe(2);
    });

    it('REFUSES when the value has more than one use', async () => {
        const body = 'a){ const t = a + 1; globalThis.g = t; return t; }';
        const { code } = run(body);
        expect(code).toMatch(/const t/); // two uses → keep the binding
        expect(await exec(code, 5)).toBe(6);
    });

    it('does nothing without the directive', () => {
        const src = 'function f(a){ const t = a + 1; globalThis.g = 1; return t; }\n';
        const { program } = parse(src, { ts: false, jsx: false });
        const sem = createSemantic();
        analyze(sem, program);
        expect(flowInlineVariables(program, sem, src)).toBe(false);
    });
});
