import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, createSemantic, type Semantic, SYM } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
import { parse } from '../src/parser.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF_SRC = resolve(__dirname, '..', 'src');

function anal(src: string, tsx = false): { sem: Semantic; program: Node } {
    const p = parse(src, { ts: true, jsx: tsx });
    expect(p.errors, `parse: ${p.errors[0]?.msg}`).toEqual([]);
    const sem = createSemantic();
    analyze(sem, p.program);
    return { sem, program: p.program };
}
const refs = (program: Node, name: string): Node[] => {
    const out: Node[] = [];
    walk(program, (n) => {
        if (n.type === N.IdentifierReference && n.name === name) out.push(n);
    });
    return out;
};
const bindings = (program: Node, name: string): Node[] => {
    const out: Node[] = [];
    walk(program, (n) => {
        if (n.type === N.BindingIdentifier && n.name === name) out.push(n);
    });
    return out;
};

describe('single-pass semantic — resolution correctness', () => {
    it('resolves hoisted var referenced before declaration', () => {
        const { program } = anal('function f() { return x; var x = 1; }');
        const ref = refs(program, 'x')[0];
        expect(ref.sym).not.toBe(0);
        expect(ref.sym).toBe(bindings(program, 'x')[0].sym); // ref → the var binding
    });

    it('resolves let referenced before declaration (no TDZ)', () => {
        const { program } = anal('function f() { return y; let y = 1; }');
        expect(refs(program, 'y')[0].sym).toBe(bindings(program, 'y')[0].sym);
    });

    it('block shadowing: inner and outer refs resolve to different bindings', () => {
        const { program } = anal('const a = 1; { const a = 2; a; } a;');
        const r = refs(program, 'a');
        expect(r).toHaveLength(2);
        expect(r[0].sym).not.toBe(0);
        expect(r[1].sym).not.toBe(0);
        expect(r[0].sym).not.toBe(r[1].sym); // inner shadows outer
    });

    it('closure over an outer binding resolves across function scopes', () => {
        const { program } = anal('function outer(a) { function inner() { return a; } return inner; }');
        expect(refs(program, 'a')[0].sym).toBe(bindings(program, 'a')[0].sym);
    });

    it('import binding carries the IMPORT flag', () => {
        const { sem, program } = anal('import { a } from "m";\nconst x = a;');
        const sym = refs(program, 'a')[0].sym;
        expect(sym).not.toBe(0);
        expect(sem.symbols[sym].flags & SYM.IMPORT).not.toBe(0);
    });

    it('undeclared reference stays unresolved (sym 0)', () => {
        const { sem, program } = anal('zzz.doThing();');
        expect(refs(program, 'zzz')[0].sym).toBe(0);
        expect(sem.unresolved.some((n) => n.name === 'zzz')).toBe(true);
    });

    it('type reference resolves to a type-space binding', () => {
        const { sem, program } = anal('type A = number;\nlet v: A;');
        const sym = refs(program, 'A')[0].sym; // the `A` in `: A`
        expect(sym).not.toBe(0);
        expect(sem.symbols[sym].flags & SYM.TYPE).not.toBe(0);
    });

    it('class used as a type resolves via the class/value fallback', () => {
        const { sem, program } = anal('class C {}\nlet c: C;');
        const sym = refs(program, 'C')[0].sym;
        expect(sym).not.toBe(0);
        expect(sem.symbols[sym].flags & SYM.CLASS).not.toBe(0);
    });

    it('namespace member head resolves to the namespace binding', () => {
        const { sem, program } = anal('namespace NS { export const y = 1; }\nconst z = NS.y;');
        const sym = refs(program, 'NS')[0].sym;
        expect(sym).not.toBe(0);
        expect(sem.symbols[sym].flags & SYM.NAMESPACE).not.toBe(0);
    });
});

function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) out.push(...walkTs(p));
        else if ((e.endsWith('.ts') || e.endsWith('.tsx')) && !e.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

describe('single-pass semantic — corpus invariant', () => {
    it('every resolved reference points at a real symbol across shakeup src/', () => {
        const failures: string[] = [];
        for (const file of walkTs(SELF_SRC)) {
            const src = readFileSync(file, 'utf8');
            const p = parse(src, { ts: true, jsx: file.endsWith('.tsx') });
            if (p.errors.length > 0) continue;
            const sem = createSemantic();
            analyze(sem, p.program);
            walk(p.program, (n) => {
                if ((n.type === N.IdentifierReference || n.type === N.BindingIdentifier) && n.sym !== 0) {
                    const rec = sem.symbols[n.sym];
                    if (rec === undefined || rec.decl === null)
                        failures.push(`${file}: '${n.name}'@${n.start} → dangling sym ${n.sym}`);
                }
            });
        }
        expect(failures.slice(0, 10).join('\n')).toBe('');
    });
});
