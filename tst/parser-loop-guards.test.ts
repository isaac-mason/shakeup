import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

// A TRIPWIRE, not a unit test.
//
// `expectP` and `parseNameAsIdent` report an error WITHOUT consuming a token, so any
// `while (!isP(state, <closer>) && tok !== T_EOF)` loop whose body can take a failure path will spin
// forever, allocating a node per turn. That shipped: `llm/repro/parser-oom.js` is 347 bytes that
// exhausted a 4GB heap (fixed in `950d08e`).
//
// The fix guarded eight loops — but it fixed INSTANCES, not the class. oxc does not have this bug at
// all because it has ONE `parse_delimited_list_into` (`cursor.rs:486`) shared by 17 call sites;
// shakeup has twenty hand-written loops. The next one written will have the bug again, which is
// exactly how this one happened: `parseObjectLiteral` had a guard and `parseBindingTarget`'s
// object-pattern loop, ten lines away, did not.
//
// Until that duplication is removed, this test is the substitute: every such loop must contain a
// recognised progress guard. If you add a loop and this fails, add the guard — do not widen the
// allowlist without reading the note in `llm/notes/parser-perf-plan.md`.
const SRC = readFileSync(new URL('../src/parser/parser.ts', import.meta.url), 'utf8');
const LINES = SRC.split('\n');

/** `while (…)` loops that scan until a closing token — the shape that can stall. */
const loopLines = (): number[] =>
    LINES.map((l, i) =>
        /while \(!(isP\(state, P\.(RPAREN|RBRACE|RBRACKET)\)|isGtLike\(state\)) && \(state\.tok as number\) !== T_EOF\)/.test(l)
            ? i
            : -1,
    ).filter((i) => i >= 0);

/** A guard is recognised if the loop body captures a position mark, keeps its own `last` cursor, or
 *  exits on a missing separator (`if (!eatP(state, P.COMMA)) break;`). */
const isGuarded = (start: number): boolean => {
    let depth = 0;
    for (let i = start; i < LINES.length && i < start + 200; i++) {
        const l = LINES[i];
        if (
            /const mark = state\.tokStart;|state\.tokStart === last|if \(!eatP\(state, P\.COMMA\)\) break;|noProgress\(state,/.test(
                l,
            )
        )
            return true;
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        if (i > start && depth <= 0) return false;
    }
    return false;
};

describe('every parser recovery loop has a progress guard', () => {
    it('finds the loops at all (the regex has not rotted)', () => {
        // If a refactor changes the loop spelling this test would silently pass on zero loops.
        expect(loopLines().length).toBeGreaterThanOrEqual(15);
    });

    it('every scan-until-closer loop is guarded', () => {
        const unguarded = loopLines()
            .filter((i) => !isGuarded(i))
            .map((i) => `parser.ts:${i + 1}: ${LINES[i].trim()}`);
        expect(unguarded).toEqual([]);
    });
});

// The same class of bug, one layer down: the LEXER has bailouts that report and return WITHOUT
// advancing `pos` — `scanEscapedIdent` has four — and they rely on `raiseAt` jumping to end-of-input
// for their progress. `raiseAt` used to skip that jump once `fatal` was already latched, so a file
// with TWO lexer errors could leave the lexer exactly where it was and spin until the stack ran out.
//
// Found by `pnpm parserfuzz` on a truncated real source, minimised to fifteen bytes. Neither error
// alone reproduces it — that is the point, and it is why this pins pairs.
//
// TWO changes fixed it, and measured independently EITHER one is sufficient here: `raiseAt` now
// jumps unconditionally, and the identifier-start bailout no longer overwrote `pos`/`tok` to undo
// that jump. They are both kept deliberately. The second removed the only site that continued past a
// fatal raise, so nothing can currently trigger the first — which makes it defence in depth, and the
// note at the top of this file is the argument for keeping it: guarding the CLASS is what stops the
// next such site from being written with the bug.
describe('a second lexer error still terminates', () => {
    const ELLIPSIS = String.fromCodePoint(0x2026); // assigned, and not an identifier character
    const returns = (src: string) => {
        parse(src, { ts: true, jsx: false, kind: 'module' });
        parse(src, { ts: false, jsx: false, kind: 'unambiguous' });
        return true;
    };

    it.each([
        ['the fuzz-minimised original', `${ELLIPSIS}\`a\`b \${i} c:\\`],
        ['a bare trailing backslash after it', `${ELLIPSIS}x\\`],
        ['two bad identifier starts', `${ELLIPSIS}${ELLIPSIS}`],
        ['bad start then a bad escape', `${ELLIPSIS} var \\q;`],
        ['bad start then an unterminated string', `${ELLIPSIS} 'abc`],
        ['bad start then an unterminated template', `${ELLIPSIS} \`abc`],
        ['bad start then an unterminated regex', `${ELLIPSIS} var r = /abc`],
        ['bad start then an unterminated comment', `${ELLIPSIS} /* abc`],
    ])('%s', (_name, src) => {
        expect(returns(src)).toBe(true);
    });

    it('and each half on its own is fine, so the pair is what is being tested', () => {
        expect(returns(ELLIPSIS)).toBe(true);
        expect(returns('`a`b ${i} c:\\')).toBe(true);
    });
});
