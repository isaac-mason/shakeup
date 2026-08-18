import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as meriyah from 'meriyah';
import { describe, expect, it } from 'vitest';
import { N, type Node, walk } from '../src/ast.ts';
import { ESTREE_TYPE } from '../src/estree.ts';
import { parse } from '../src/parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSX_DIR = resolve(__dirname, 'fixtures/jsx');

type Counts = Record<string, number>;

function countOurs(src: string): { counts: Counts; errors: unknown[] } {
    const { program, errors } = parse(src, { ts: false, jsx: true });
    const counts: Counts = {};
    walk(program, (n: Node) => {
        const name = ESTREE_TYPE[n.type];
        if (name === '') {
            if (n.type === N.FormalParameter && (n.data as { init: Node | null }).init !== null) {
                counts.AssignmentPattern = (counts.AssignmentPattern ?? 0) + 1;
            }
            return;
        }
        counts[name] = (counts[name] ?? 0) + 1;
    });
    return { counts, errors };
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
        if (typeof obj.type === 'string') counts[obj.type] = (counts[obj.type] ?? 0) + 1;
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
        name: 'Ident(JSX|value|this)',
        members: ['Identifier', 'JSXIdentifier', 'ThisExpression'],
        reason: 'Head-role split (plan §6): capitalized/member-head/`this` JSX tag names are IdentifierReference/ThisExpression for us (resolving value refs) but JSXIdentifier for meriyah. Summing all three on both sides absorbs the reclassification.',
    },
];

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
    return out;
}

const fixtures = readdirSync(JSX_DIR)
    .filter((f) => f.endsWith('.jsx'))
    .sort();

describe('JSX differential vs meriyah (jsx:true corpus)', () => {
    it('found the .jsx fixture corpus', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(3);
    });

    for (const f of fixtures) {
        it(`per-ESTree-type node counts match for ${f} (modulo the documented head-role group)`, () => {
            const src = readFileSync(resolve(JSX_DIR, f), 'utf8');

            const { counts, errors } = countOurs(src);
            expect(errors, `our parser produced errors on ${f}: ${JSON.stringify(errors)}`).toEqual([]);

            const ours = applyGroups(counts);
            const theirs = applyGroups(countMeriyah(meriyah.parse(src, { module: true, next: true, jsx: true })));

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
                            `  ${d.type.padEnd(w)}  ours=${String(d.ours).padStart(6)}  theirs=${String(d.theirs).padStart(6)}  delta=${String(d.delta).padStart(6)}`,
                    )
                    .join('\n');
                expect.fail(
                    `\nMISMATCHED ESTree node counts (${f}) beyond the documented head-role group:\n${rows}\n\n` +
                        `Groups: ${GROUPS.map((g) => g.name).join(', ')}\n` +
                        `A mismatch here that isn't the head-role split is a LIKELY REAL JSX PARSER BUG. Localize it and add a documented ledger entry (or fix the parser).\n`,
                );
            }
            expect(diffs).toEqual([]);
        });
    }
});
