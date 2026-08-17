import { describe, expect, it } from 'vitest';
import { analyzeNsUsage } from '../src/analysis/ns-usage.ts';
import { analyze, createSemantic, symbolOf } from '../src/analysis/semantic.ts';
import { N, walk } from '../src/ast.ts';
import { parse } from '../src/parser.ts';

/** Parse `src`, resolve symbols, and classify the `import * as ns` binding named `nsName`. */
function usageOf(src: string, nsName = 'ns'): { escapes: boolean; members: string[] } {
    const { program, errors } = parse(src, { ts: false, jsx: false });
    expect(errors).toEqual([]);
    const sem = createSemantic();
    analyze(sem, program);
    // The namespace binding symbol: the declared `ns` identifier.
    let nsSym = 0;
    walk(program, (n) => {
        if ((n.type === N.BindingIdentifier || n.type === N.IdentifierReference) && n.name === nsName) {
            const s = symbolOf(sem, n);
            if (s !== 0 && nsSym === 0) nsSym = s;
        }
    });
    expect(nsSym).not.toBe(0);
    const u = analyzeNsUsage(program, sem, new Set([nsSym])).get(nsSym)!;
    return { escapes: u.escapes, members: [...u.members].sort() };
}

describe('analyzeNsUsage', () => {
    it('records static member reads', () => {
        expect(usageOf("import * as ns from 'x'; console.log(ns.a, ns.b);")).toEqual({
            escapes: false,
            members: ['a', 'b'],
        });
    });

    it('dedups repeated member reads', () => {
        expect(usageOf("import * as ns from 'x'; ns.a; ns.a; ns.a;")).toEqual({ escapes: false, members: ['a'] });
    });

    it('nested member `ns.a.b` records only the namespace member `a`', () => {
        expect(usageOf("import * as ns from 'x'; ns.a.b.c;")).toEqual({ escapes: false, members: ['a'] });
    });

    it('optional member `ns?.a` narrows', () => {
        expect(usageOf("import * as ns from 'x'; ns?.a;")).toEqual({ escapes: false, members: ['a'] });
    });

    it('bare reference escapes', () => {
        expect(usageOf("import * as ns from 'x'; sink(ns); ns.a;")).toEqual({ escapes: true, members: ['a'] });
    });

    it('call `ns()` escapes', () => {
        expect(usageOf("import * as ns from 'x'; ns();")).toEqual({ escapes: true, members: [] });
    });

    it('computed access `ns[k]` escapes', () => {
        expect(usageOf("import * as ns from 'x'; const k = 'a'; ns[k];")).toEqual({ escapes: true, members: [] });
    });

    it('string-computed access `ns["a"]` escapes (conservative)', () => {
        expect(usageOf("import * as ns from 'x'; ns['a'];")).toEqual({ escapes: true, members: [] });
    });

    it('spread `{...ns}` escapes', () => {
        expect(usageOf("import * as ns from 'x'; const o = {...ns};")).toEqual({ escapes: true, members: [] });
    });

    it('return of the namespace escapes', () => {
        expect(usageOf("import * as ns from 'x'; export function f() { return ns; }")).toEqual({
            escapes: true,
            members: [],
        });
    });

    it('member read as an argument still narrows', () => {
        expect(usageOf("import * as ns from 'x'; sink(ns.a, ns.b);")).toEqual({ escapes: false, members: ['a', 'b'] });
    });

    it('shadowing binding is not confused for the namespace', () => {
        // The inner `ns` is a different symbol; only the outer `ns.a` counts.
        expect(usageOf("import * as ns from 'x'; ns.a; function f(ns) { return ns.zzz; }")).toEqual({
            escapes: false,
            members: ['a'],
        });
    });
});
