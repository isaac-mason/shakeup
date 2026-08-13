import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as meriyah from 'meriyah';
import { parse } from '../src/parser.ts';
import { createAst, walk, TYPE_NAME, N, A } from '../src/ast.ts';
import { ESTREE_MAP } from './estree-map.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const THREE = resolve(REPO, 'llm/spikes/node_modules/three/build/three.core.js');

type Counts = Record<string, number>;

/** Count ESTree-mapped node types by walking our flat AST from the root. */
function countOurs(src: string): Counts {
    const { ast, program } = parse(createAst(), src, { ts: false });
    expect(ast.errors).toEqual([]);
    const counts: Counts = {};
    walk(ast, program, (id) => {
        const name = ESTREE_MAP[TYPE_NAME[ast.type[id]] as keyof typeof ESTREE_MAP];
        if (name != null) counts[name] = (counts[name] ?? 0) + 1;
        // A defaulted param `f(a = 1)` is a Param carrying an `init` for us, but
        // an AssignmentPattern for meriyah. Param itself maps to null, so count
        // each Param-with-init as an AssignmentPattern here — together with our
        // real AssignPattern nodes (nested destructuring defaults) this matches
        // meriyah's AssignmentPattern total. Documented modelling difference, not
        // a bug; see notes on Param in estree-map.ts.
        if (ast.type[id] === N.Param && A.Param.init(ast, id) !== 0) {
            counts.AssignmentPattern = (counts.AssignmentPattern ?? 0) + 1;
        }
    });
    return counts;
}

/** Count node types in a meriyah ESTree by recursively visiting node objects. */
function countMeriyah(root: unknown): Counts {
    const counts: Counts = {};
    const skip = new Set(['loc', 'range', 'regex']);
    const visit = (v: unknown): void => {
        if (Array.isArray(v)) {
            for (const el of v) visit(el);
            return;
        }
        if (v == null || typeof v !== 'object') return;
        const obj = v as Record<string, unknown>;
        if (typeof obj.type === 'string') {
            counts[obj.type] = (counts[obj.type] ?? 0) + 1;
        }
        for (const [k, child] of Object.entries(obj)) {
            if (skip.has(k)) continue;
            visit(child);
        }
    };
    visit(root);
    return counts;
}

/**
 * KNOWN_DIFFS: the full, documented divergence ledger between our parser's node
 * inventory and meriyah's for three.core.js. Anything NOT covered here that
 * still mismatches is treated as a likely REAL PARSER BUG (the suite fails and
 * prints an actionable diff table). Entries marked `suspectedBug: true` carry a
 * minimal repro and keep the suite green while clearly flagging the issue.
 *
 * There are three kinds of entry:
 *  - GROUP: sum several ESTree type names into one bucket on BOTH sides before
 *    comparing (used when we and meriyah split the same syntax across different
 *    node types, e.g. expr-vs-pattern for destructuring).
 *  - EXCLUDE: drop a type from the diff entirely (used when the count difference
 *    is inherent to a structural modelling choice with no clean 1:1 bucket).
 */
type Group = { name: string; members: string[]; reason: string };

const GROUPS: Group[] = [
    {
        name: 'Array(Expression|Pattern)',
        members: ['ArrayExpression', 'ArrayPattern'],
        reason:
            "We don't reinterpret assignment-side destructuring: `[a]=x` stays an ArrayExpression for us but is an ArrayPattern for meriyah. Sum both sides to compare.",
    },
    {
        name: 'Object(Expression|Pattern)',
        members: ['ObjectExpression', 'ObjectPattern'],
        reason:
            "Same as arrays: assignment-side object destructuring stays ObjectExpression for us but ObjectPattern for meriyah. Sum both sides.",
    },
];

/** type names excluded entirely from the diff, with reasons. */
const EXCLUDED: Record<string, string> = {
    Identifier:
        "MetaProperty handling differs: meriyah emits Identifier children (meta/property) under MetaProperty, we treat MetaProp as a leaf. Also destructuring-vs-expression shorthand differences shift Identifier counts. Excluded per spec.",
    ChainExpression:
        "meriyah wraps optional-chain roots in a ChainExpression node; we don't create wrapper nodes (optional flag lives on Member/Call). No corresponding node on our side.",
    ClassBody:
        "meriyah inserts a ClassBody wrapper node between a Class{Declaration,Expression} and its members; we store members directly on the class node's `body` list, so we have no ClassBody-equivalent node. Pure structural wrapper, no 1:1 bucket. (three.core.js: 219 ClassBody on their side, 0 on ours.)",
};

/**
 * suspectedBug: a mismatch we believe is a genuine parser divergence, kept out
 * of the strict diff so the suite stays green while flagging it loudly. Each
 * entry pins the exact residual delta (ours - theirs) we expect, so the guard
 * fails the moment the delta drifts (e.g. if the bug is fixed, or worsens).
 */
type SuspectedBug = { type: string; delta: number; repro: string; analysis: string };

const SUSPECTED_BUGS: SuspectedBug[] = [
    // (empty — the for-init ExprStmt wrapping bug this harness found was fixed:
    //  For.init is now the bare expression, per ESTree and our own schema.)
];

/** collapse counts according to GROUPS (members summed under group name). */
function applyGroups(counts: Counts): Counts {
    const out: Counts = { ...counts };
    for (const g of GROUPS) {
        let sum = 0;
        for (const m of g.members) {
            sum += out[m] ?? 0;
            delete out[m];
        }
        out[g.name] = sum;
    }
    for (const k of Object.keys(EXCLUDED)) delete out[k];
    return out;
}

describe('differential vs meriyah (three.core.js)', () => {
    it('per-ESTree-type node counts match (modulo documented groups/exclusions)', () => {
        const src = readFileSync(THREE, 'utf8');

        const ours = applyGroups(countOurs(src));
        const theirs = applyGroups(countMeriyah(meriyah.parse(src, { module: true, next: true })));

        // Neutralize known/suspected-bug deltas so the suite stays green while
        // flagging them. Pinning the exact delta means the guard re-fires if the
        // delta ever drifts (bug fixed, or regressed further).
        for (const b of SUSPECTED_BUGS) {
            ours[b.type] = (ours[b.type] ?? 0) - b.delta;
        }

        const allTypes = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort();
        const diffs: { type: string; ours: number; theirs: number; delta: number }[] = [];
        for (const t of allTypes) {
            const o = ours[t] ?? 0;
            const m = theirs[t] ?? 0;
            if (o !== m) diffs.push({ type: t, ours: o, theirs: m, delta: o - m });
        }

        if (diffs.length > 0) {
            const w = Math.max(4, ...allTypes.map((t) => t.length));
            const rows = diffs
                .map(
                    (d) =>
                        `  ${d.type.padEnd(w)}  ours=${String(d.ours).padStart(7)}  theirs=${String(d.theirs).padStart(7)}  delta=${String(d.delta).padStart(7)}`,
                )
                .join('\n');
            const table =
                `\nMISMATCHED ESTree node counts (three.core.js) beyond documented diffs:\n${rows}\n\n` +
                `Excluded: ${Object.keys(EXCLUDED).join(', ')}\n` +
                `Groups: ${GROUPS.map((g) => g.name).join(', ')}\n` +
                `Suspected bugs (delta-adjusted): ${SUSPECTED_BUGS.map((b) => `${b.type}(${b.delta})`).join(', ')}\n\n` +
                `A mismatch here that isn't one of the above is a LIKELY REAL PARSER BUG. Localize it and add a documented KNOWN_DIFFS entry (or fix the test) — do not silently widen exceptions.\n`;
            expect.fail(table);
        }

        expect(diffs).toEqual([]);
    });

    // Regression guard for the for-init bug this harness originally found:
    // For.init must be the BARE expression (ESTree semantics), never an ExprStmt.
    it('regression: for-loop expression init is a bare expression', () => {
        const repro = 'for (i = 0; i < n; i++) {}';
        const { ast, program } = parse(createAst(), repro, { ts: false });
        expect(ast.errors).toEqual([]);

        let forId = 0;
        walk(ast, program, (id) => {
            if (ast.type[id] === N.For) forId = id;
        });
        expect(forId).toBeGreaterThan(0);
        const init = A.For.init(ast, forId);
        expect(TYPE_NAME[ast.type[init]]).toBe('Assign');
    });
});
