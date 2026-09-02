// A line comment ends at ANY line terminator. Scanning for `\n` alone meant `//c\rvar a = 1;`
// swallowed the rest of the FILE and reported no error — a silent miscompile, the worst class:
// not a rejection you would notice, but wrong output you would not.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

describe('line comments end at every line terminator', () => {
    it.each([
        ['\\n', '\n'],
        ['\\r', '\r'],
        ['\\u2028', '\u2028'],
        ['\\u2029', '\u2029'],
        ['\\r\\n', '\r\n'],
    ])('%s terminates the comment', (_label, term) => {
        const src = `//c${term}var a = 1;`;
        expect(() => new Function(src), 'node must agree it is valid').not.toThrow();
        const r = parse(src, { ts: false, jsx: false });
        expect(r.errors).toEqual([]);
        // The statement after the comment must actually be parsed, not silently swallowed.
        expect(r.nodeCount, 'code after the comment must survive').toBeGreaterThan(3);
    });

    it('a comment running to end of input is still fine', () => {
        expect(parse('//c', { ts: false, jsx: false }).errors).toEqual([]);
    });
});

describe('hashbang comments end at every line terminator too', () => {
    // Same defect as the line comment above, same silent-swallow consequence.
    it.each([
        ['\\n', '\n'],
        ['\\r', '\r'],
        ['\\u2028', '\u2028'],
        ['\\u2029', '\u2029'],
    ])('%s terminates the hashbang', (_label, term) => {
        const r = parse(`#! shebang${term}var a = 1;`, { ts: false, jsx: false });
        expect(r.errors).toEqual([]);
        expect(r.nodeCount, 'code after the hashbang must survive').toBeGreaterThan(3);
    });
});

describe('a string escape may span CRLF as one line-terminator sequence', () => {
    it('\\ + CRLF is a line continuation, not an unterminated string', () => {
        const src = 'var s = "a\\\r\nb";';
        expect(() => new Function(src)).not.toThrow();
        expect(parse(src, { ts: false, jsx: false }).errors).toEqual([]);
    });
});
