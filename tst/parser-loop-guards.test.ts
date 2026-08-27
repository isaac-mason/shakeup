import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
