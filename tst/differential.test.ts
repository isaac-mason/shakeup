import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as meriyah from 'meriyah';
import { describe, expect, it } from 'vitest';
import { N, type Node, walk } from '../src/ast.ts';
import { ESTREE_TYPE } from '../src/estree.ts';
import { parse } from '../src/parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const THREE = resolve(REPO, 'llm/spikes/node_modules/three/build/three.core.js');

type Counts = Record<string, number>;

function countOurs(src: string): Counts {
    const { program, errors } = parse(src, { ts: false, jsx: false });
    expect(errors).toEqual([]);
    const counts: Counts = {};
    walk(program, (n: Node) => {
        const name = ESTREE_TYPE[n.type];
        if (name === 'Param' || name === '') {
            if (n.type === N.FormalParameter && n.data.init !== null) {
                counts.AssignmentPattern = (counts.AssignmentPattern ?? 0) + 1;
            }
            return;
        }
        counts[name] = (counts[name] ?? 0) + 1;
    });
    return counts;
}

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

type Group = { name: string; members: string[]; reason: string };

const GROUPS: Group[] = [
    {
        name: 'Array(Expression|Pattern)',
        members: ['ArrayExpression', 'ArrayPattern'],
        reason: "We don't reinterpret assignment-side destructuring: `[a]=x` stays an ArrayExpression for us but is an ArrayPattern for meriyah. Sum both sides to compare.",
    },
    {
        name: 'Object(Expression|Pattern)',
        members: ['ObjectExpression', 'ObjectPattern'],
        reason: 'Same as arrays: assignment-side object destructuring stays ObjectExpression for us but ObjectPattern for meriyah. Sum both sides.',
    },
];

const EXCLUDED: Record<string, string> = {
    Identifier:
        "We split Identifier into four roles (BindingIdentifier / IdentifierReference / IdentifierName / LabelIdentifier), all of which serialize as 'Identifier' in ESTREE_NAME so they land in this one bucket. Counts still diverge from meriyah for two reasons: (1) MetaProperty handling — meriyah emits Identifier children (meta/property) under MetaProperty, we treat ImportMeta/NewTarget as leaves; (2) shorthand `{a}` — we now materialize the key (IdentifierName) and value (IdentifierReference/BindingIdentifier) as two distinct nodes, and we keep assignment-side destructuring expression-flavored, both shifting Identifier counts. Excluded per spec.",
    ClassBody:
        "meriyah inserts a ClassBody wrapper node between a Class{Declaration,Expression} and its members; we store members directly on the class node's `body` list, so we have no ClassBody-equivalent node. Pure structural wrapper, no 1:1 bucket. (three.core.js: 219 ClassBody on their side, 0 on ours.)",
};

type SuspectedBug = { type: string; delta: number; repro: string; analysis: string };

const SUSPECTED_BUGS: SuspectedBug[] = [];

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

    it('regression: for-loop expression init is a bare expression', () => {
        const repro = 'for (i = 0; i < n; i++) {}';
        const { program, errors } = parse(repro, { ts: false, jsx: false });
        expect(errors).toEqual([]);

        let forNode: Node | null = null;
        walk(program, (n) => {
            if (n.type === N.ForStatement) forNode = n;
        });
        expect(forNode).not.toBeNull();
        const init = (forNode as unknown as { data: { init: Node } }).data.init;
        expect(init.type).toBe(N.AssignmentExpression);
    });
});
