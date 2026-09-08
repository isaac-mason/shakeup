import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64, sha1 } from '../src/util/sha1.ts';

// SHA-1 exists for exactly one caller: React Fast Refresh's signature key, which oxc hashes with
// SHA-1 and encodes with STANDARD base64. `util/hash.ts` cannot stand in — it is xxHash64 with a
// radix base64url encoding, a different algorithm AND a different alphabet.
describe('sha1 + standard base64', () => {
    const cases = [
        '',
        'abc',
        'The quick brown fox jumps over the lazy dog',
        'useContext{}',
        'useState{[foo, setFoo](0)}\\nuseEffect{}',
        'a'.repeat(55), // one byte under a block boundary
        'a'.repeat(56), // forces a second padding block
        'a'.repeat(64),
        'a'.repeat(1000),
        'ünïcodé — multibyte',
    ];

    it.each(cases)('agrees with node:crypto on %j', (input) => {
        expect(base64(sha1(input))).toBe(createHash('sha1').update(input).digest('base64'));
    });

    it('reproduces the oxc fixture vector', () => {
        // From `emit-full-signatures-option`: this exact string is what the corpus asserts, so it is
        // the one vector that proves the whole key pipeline and not just the hash.
        expect(base64(sha1('useContext{}'))).toBe('gDsCjeeItUuvgOWf1v4qoK9RF6k=');
    });

    it('pads to a multiple of four with `=`', () => {
        // 20 bytes is not a multiple of 3, so every digest ends in one `=`.
        expect(base64(sha1('anything'))).toHaveLength(28);
        expect(base64(sha1('anything')).endsWith('=')).toBe(true);
    });
});
