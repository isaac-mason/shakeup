import { describe, expect, it } from 'vitest';
import { parse } from '../src/index.ts';
import { anyInSource, DIRECTIVE, directiveSpans, opts, scanDirectives } from '../src/passes/optimize/directives.ts';
import { Gate } from '../src/passes/optimize/gate.ts';

const spans = (src: string, want: number) => directiveSpans(src, parse(src, { ts: false, jsx: false }).program, want);

describe('directive scanning', () => {
    it('pre-filters files with no directive at all', () => {
        expect(anyInSource('const x = 1; // nothing here')).toBe(false);
        expect(anyInSource('/* @inline */ function f() {}')).toBe(true);
        expect(anyInSource('const email = "a@b.c";')).toBe(false); // has `@`, but no directive token
    });

    it('attaches a directive to the construct that FOLLOWS it', () => {
        const src = '/* @inline */ function f() {}\nfunction g() {}\n';
        const hits = scanDirectives(src);
        expect([...hits.keys()]).toEqual([src.indexOf('function f')]);
        expect([...hits.values()]).toEqual([DIRECTIVE.INLINE]);
    });

    it('propagates a directive on an exported declaration to the declaration itself', () => {
        const src = '/* @inline */ export function f() {}\n';
        const s = spans(src, DIRECTIVE.INLINE);
        expect(s.has(src.indexOf('export'))).toBe(true);
        expect(s.has(src.indexOf('function f'))).toBe(true); // propagated through `export`
    });

    it('expands @optimize to its implied directives but NOT to @inline or @unroll', () => {
        expect(opts(DIRECTIVE.OPTIMIZE, DIRECTIVE.FLATTEN)).toBe(true);
        expect(opts(DIRECTIVE.OPTIMIZE, DIRECTIVE.SROA)).toBe(true);
        expect(opts(DIRECTIVE.OPTIMIZE, DIRECTIVE.INLINE)).toBe(false);
        expect(opts(DIRECTIVE.OPTIMIZE, DIRECTIVE.UNROLL)).toBe(false); // size-for-speed stays explicit
        expect(opts(DIRECTIVE.UNROLL, DIRECTIVE.UNROLL)).toBe(true);
    });

    it('selects only the requested directive', () => {
        const src = '/* @unroll */ function a() {}\n/* @inline */ function b() {}\n';
        expect(spans(src, DIRECTIVE.INLINE).has(src.indexOf('function b'))).toBe(true);
        expect(spans(src, DIRECTIVE.INLINE).has(src.indexOf('function a'))).toBe(false);
    });

    it('combines two directives on one construct', () => {
        const src = '/* @inline @unroll */ function f() {}\n';
        const at = src.indexOf('function f');
        expect(scanDirectives(src).get(at)).toBe(DIRECTIVE.INLINE | DIRECTIVE.UNROLL);
    });
});

describe('Gate', () => {
    it('is always active when ungated', () => {
        const g = Gate.ungated();
        expect(g.active).toBe(true);
        g.enterFn(999);
        expect(g.active).toBe(true); // an ungated gate never turns off
    });

    it('RESETS at a function boundary — a nested un-annotated function is not optimized', () => {
        const g = Gate.gated(new Set([10]));
        const outer = g.enterFn(10);
        expect(g.active).toBe(true);
        const inner = g.enterFn(20); // nested, not annotated
        expect(g.active).toBe(false);
        g.exit(inner);
        expect(g.active).toBe(true);
        g.exit(outer);
        expect(g.active).toBe(false);
    });

    it('INHERITS at a block boundary, and a directive-attached block turns it on', () => {
        const g = Gate.gated(new Set([50]));
        const a = g.enterScope(1); // not annotated, not active → stays off
        expect(g.active).toBe(false);
        g.exit(a);
        const b = g.enterScope(50); // directive-attached block
        expect(g.active).toBe(true);
        const c = g.enterScope(60); // inherits
        expect(g.active).toBe(true);
        g.exit(c);
        g.exit(b);
        expect(g.active).toBe(false);
    });
});
