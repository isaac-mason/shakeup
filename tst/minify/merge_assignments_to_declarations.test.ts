// Ported from oxc_minifier/tests/peephole/merge_assignments_to_declarations.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('merge_assignments_to_declarations_var', () => {
    it('var a; a = 0', () => test('var a; a = 0', 'var a = 0'));
    it('var a = 0; a = 1', () => testSame('var a = 0; a = 1'));
    it('var a = 0; a = b()', () => testSame('var a = 0; a = b()'));
    it('var a = b(); a = c()', () => testSame('var a = b(); a = c()'));
    it('var a, b = 1; a = 0', () => testSame('var a, b = 1; a = 0'));
    it('var a, b = c(); a = 0', () => testSame('var a, b = c(); a = 0'));
    it('var a, b; a = 0', () => test('var a, b; a = 0', 'var a = 0, b'));
    it('var a, b; a = 0, b = 1', () => test('var a, b; a = 0, b = 1', 'var a = 0, b = 1'));
    it('var a, b; a = 0; b = 1', () => test('var a, b; a = 0; b = 1', 'var a = 0, b = 1'));
    it('var a, b; a = c()', () => test('var a, b; a = c()', 'var a = c(), b'));
    it('var a, b; a = c(), b = d()', () => test('var a, b; a = c(), b = d()', 'var a = c(), b = d()'));
    it('var a, b; a = c(); b = d()', () => test('var a, b; a = c(); b = d()', 'var a = c(), b = d()'));
    it('var a, b; a = b', () => test('var a, b; a = b', 'var a = b, b'));
    it('var a, b, c; a = 0, b = 1, c = 2', () => test('var a, b, c; a = 0, b = 1, c = 2', 'var a = 0, b = 1, c = 2'));
    it('var a, b; a = 0, b = 1, foo()', () => test('var a, b; a = 0, b = 1, foo()', 'var a = 0, b = 1; foo()'));
    it('var a; a = 0, foo(), bar()', () => test('var a; a = 0, foo(), bar()', 'var a = 0; foo(), bar()'));
    it('var a, b; foo(), bar()', () => testSame('var a, b; foo(), bar()'));
});

describe('merge_assignments_to_declarations_let', () => {
    it('let a; a = 0', () => test('let a; a = 0', 'let a = 0'));
    it('let a = 0; a = 1', () => testSame('let a = 0; a = 1'));
    it('let a = 0; a = b()', () => testSame('let a = 0; a = b()'));
    it('let a = b(); a = c()', () => testSame('let a = b(); a = c()'));
    it('let a, b = 1; a = 0', () => testSame('let a, b = 1; a = 0'));
    it('let a, b = c(); a = 0', () => testSame('let a, b = c(); a = 0'));
    it('let a, b; a = 0', () => testSame('let a, b; a = 0'));
    it('let a, b; a = 0; b = 1', () => test('let a, b; a = 0; b = 1', 'let a, b; a = 0, b = 1'));
    it('let a, b; a = c()', () => testSame('let a, b; a = c()'));
    it('let a, b; a = c(); b = d()', () => test('let a, b; a = c(); b = d()', 'let a, b; a = c(), b = d()'));
    it('let a, b; a = b', () => testSame('let a, b; a = b'));
    it('let a; a = foo(a)', () => testSame('let a; a = foo(a)'));
    it('let a; a = (() => a)()', () => test('let a; a = (() => a)()', 'let a; a = a;'));
    it('let a; a = () => a', () => test('let a; a = () => a', 'let a = () => a'));
});

describe('merge_assignments_to_declarations_other', () => {
    it('const a = 0; a = 1', () => testSame('const a = 0; a = 1'));
    it('using a = 0; a = 1', () => testSame('using a = 0; a = 1'));
    it('await using a = 0; a = 1', () => testSame('await using a = 0; a = 1'));
});
