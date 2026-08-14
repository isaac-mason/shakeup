import { describe, expect, it } from 'vitest';
import {
    CHILD_FIELDS,
    N,
    NODE_TYPE_NAMES,
    isTypeOnlyNode,
    makeIdentifierReference,
    walk,
    walkChildren,
    type Node,
    type TypeName,
} from '../src/ast.ts';

/** Synthetic node of type `t` with every child field filled by named idents
 * (lists get two idents around a null hole). Scalar payload fields are absent —
 * the walkers never read them. */
function synthetic(t: TypeName): { n: Node; expected: string[] } {
    const data: Record<string, unknown> = {};
    const expected: string[] = [];
    for (const spec of CHILD_FIELDS[t]) {
        if (spec.list) {
            const a = makeIdentifierReference(`${t}.${spec.name}.0`);
            const b = makeIdentifierReference(`${t}.${spec.name}.1`);
            data[spec.name] = [a, null, b];
            expected.push(a.name, b.name);
        } else {
            const c = makeIdentifierReference(`${t}.${spec.name}`);
            data[spec.name] = c;
            expected.push(c.name);
        }
    }
    const n = { id: 0, type: N[t], start: 0, end: 0, name: '', data } as unknown as Node;
    return { n, expected };
}

const interiorTypes = NODE_TYPE_NAMES.filter((t) => CHILD_FIELDS[t].length > 0);

describe('walk drift vs CHILD_FIELDS', () => {
    it('hand-switch walk visits every child field of every type, in schema order', () => {
        for (const t of interiorTypes) {
            const { n, expected } = synthetic(t);
            const seen: string[] = [];
            walk(n, (c) => { if (c.type === N.IdentifierReference) seen.push(c.name); });
            expect(seen, `walk cases for ${t}`).toEqual(expected);
        }
    });

    it('hand-switch walk and generic walkChildren agree on visitation order', () => {
        for (const t of interiorTypes) {
            const { n } = synthetic(t);
            const viaSwitch: string[] = [];
            walk(n, (c) => { if (c.type === N.IdentifierReference) viaSwitch.push(c.name); });
            const viaSchema: string[] = [];
            walkChildren(n, (c) => { viaSchema.push(c.name); });
            expect(viaSwitch, `oracle agreement for ${t}`).toEqual(viaSchema);
        }
    });

    it('tolerates all-null child fields and empty lists', () => {
        for (const t of interiorTypes) {
            const data: Record<string, unknown> = {};
            for (const spec of CHILD_FIELDS[t]) data[spec.name] = spec.list ? [] : null;
            const n = { id: 0, type: N[t], start: 0, end: 0, name: '', data } as unknown as Node;
            const seen: Node[] = [];
            walk(n, (c) => { seen.push(c); });
            expect(seen).toEqual([n]);
        }
    });

    it('enter=false skips children and exit', () => {
        const { n } = synthetic('IfStatement');
        const seen: string[] = [];
        let exited = 0;
        walk(n, (c) => { seen.push(c.name); return c.type === N.IfStatement ? false : undefined; }, () => { exited++; });
        expect(seen).toEqual(['']);
        expect(exited).toBe(0);
    });
});

describe('isTypeOnlyNode range: keyword leaves + TSThisType vs value/runtime types', () => {
    const KEYWORD_LEAVES: TypeName[] = [
        'TSAnyKeyword', 'TSStringKeyword', 'TSNumberKeyword', 'TSBooleanKeyword', 'TSBigIntKeyword',
        'TSSymbolKeyword', 'TSObjectKeyword', 'TSVoidKeyword', 'TSUndefinedKeyword', 'TSNullKeyword',
        'TSNeverKeyword', 'TSUnknownKeyword', 'TSIntrinsicKeyword', 'TSThisType',
    ];

    it('the 14 keyword leaves (incl. TSThisType) are contiguous type ids', () => {
        const ids = KEYWORD_LEAVES.map((t) => N[t]);
        for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1] + 1);
    });

    it('every keyword leaf classifies as type-only', () => {
        for (const t of KEYWORD_LEAVES) expect(isTypeOnlyNode(N[t]), t).toBe(true);
    });

    it('ImportMeta / NewTarget and value-wrapping TS exprs are NOT type-only', () => {
        for (const t of ['ImportMeta', 'NewTarget', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSEnumDeclaration', 'TSEnumMember', 'TSModuleDeclaration'] as TypeName[]) {
            expect(isTypeOnlyNode(N[t]), t).toBe(false);
        }
    });
});
