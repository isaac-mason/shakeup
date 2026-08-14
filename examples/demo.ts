/**
 * Demo: parse real code into the TYPE+DATA AST, walk it, run a small transform.
 * Run: node examples/demo.ts   (Node >= 23 strips types natively)
 */
import { readFileSync } from 'node:fs';
import {
    type Node,
    N,
    TYPE_NAME,
    cloneNode,
    makeIdentifierReference,
    walk,
    walkChildren,
} from '../src/ast.ts';
import { parse } from '../src/parser.ts';

/* 1 — parse a snippet and dump it */
const snippet = `
export interface Vec3 { x: number; y: number; z: number }
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export function scale(v: Vec3, s: number): Vec3 {
    return { x: v.x * s, y: v.y * s, z: v.z * s };
}
`;
const { program, errors, nodeCount } = parse(snippet, { ts: true });
console.log('— snippet parse:', nodeCount - 1, 'nodes,', errors.length, 'errors');
if (errors.length) console.log(errors);

/* 2 — transform demo: count + collect every member access path like `a.x` */
const memberPaths: string[] = [];
walk(program, (n) => {
    if (n.type === N.StaticMemberExpression) {
        const obj = n.data.object;
        const prop = n.data.property;
        if (obj.type === N.IdentifierReference) memberPaths.push(`${obj.name}.${prop.name}`);
    }
});
console.log('— member accesses:', memberPaths.join(' '));

/* 3 — transform demo: constant-fold `x * 1` and `x + 0` in place. The type+data
 * node is one mutable object: fold by overwriting its slots with the left child's
 * (native narrowing gives us .operator/.left/.right directly). */
let folds = 0;
walk(program, (n): void => {
    if (n.type !== N.BinaryExpression) return;
    const right = n.data.right;
    if (right.type !== N.NumericLiteral) return;
    if ((n.data.operator === '*' && right.name === '1') || (n.data.operator === '+' && right.name === '0')) {
        const left = n.data.left as Node;
        // become the left operand in place (cheapest fold — slot copy on the object)
        const raw = n as unknown as { type: number; start: number; end: number; name: string; data: unknown };
        const lraw = left as unknown as { type: number; start: number; end: number; name: string; data: unknown };
        raw.type = lraw.type;
        raw.start = lraw.start;
        raw.end = lraw.end;
        raw.name = lraw.name;
        raw.data = lraw.data;
        folds++;
    }
});
console.log('— folded', folds, 'no-op arithmetic nodes (x*1, x+0)');

/* 4 — clone-with-substitution demo (the inlining primitive) */
const src2 = parse('const doubled = v.x * 2 + v.y * 2;', { ts: true });
let decl: Node | null = null;
walk(src2.program, (n) => {
    if (n.type === N.BinaryExpression && decl === null) { decl = n; return false; }
    return;
});
// clone `v.x * 2 + v.y * 2`, renaming `v` -> `vec` (a synthetic named ident)
const renamed = cloneNode(decl, (n) => {
    if (n.type === N.IdentifierReference && n.name === 'v') return makeIdentifierReference('vec');
    return null;
})!;
console.log('— clone ok:', TYPE_NAME[renamed.type], 'root, rebuilt subtree standalone (source droppable)');

/* 5 — TS-awareness demo: read tuple arity / interface fields (the compilecat queries) */
const ts = parse('interface V { x: number; y: number }; type T3 = [number, number, number];', { ts: true });
walk(ts.program, (n) => {
    if (n.type === N.TSInterfaceDeclaration) {
        const fields: string[] = [];
        for (const m of n.data.body) if (m.type === N.TSPropertySignature) fields.push(m.data.key.name);
        console.log('— interface', n.data.id.name, 'fields:', fields.join(','));
    }
    if (n.type === N.TSTupleType) {
        let count = 0;
        walkChildren(n, () => { count++; });
        console.log('— tuple arity:', count);
    }
});

/* 6 — the real test: parse the fixtures */
for (const [name, path, isTs] of [
    ['three.core.js', new URL('../llm/spikes/node_modules/three/build/three.core.js', import.meta.url), false],
    ['crashcat concat', null, true],
] as const) {
    let source: string;
    if (path) source = readFileSync(path, 'utf8');
    else {
        const { readdirSync, statSync } = await import('node:fs');
        const { join } = await import('node:path');
        const files: string[] = [];
        const walkDir = (d: string) => {
            for (const fEntry of readdirSync(d)) {
                const p = join(d, fEntry);
                if (statSync(p).isDirectory()) walkDir(p);
                else if (fEntry.endsWith('.ts')) files.push(readFileSync(p, 'utf8'));
            }
        };
        walkDir('/Users/isaacmason/Development/crashcat/src');
        source = files.join('\n');
    }
    const t0 = performance.now();
    const r = parse(source, { ts: isTs });
    const dt = performance.now() - t0;
    const mb = source.length / 1024 / 1024;
    console.log(
        `— ${name}: ${mb.toFixed(2)}MB, ${r.nodeCount - 1} nodes, ${r.errors.length} errors, ${dt.toFixed(1)}ms (${(mb / (dt / 1000)).toFixed(1)} MB/s cold)`,
    );
    for (const e of r.errors.slice(0, 5)) {
        const line = source.slice(0, e.pos).split('\n').length;
        console.log(`   err L${line}: ${e.msg} — ...${JSON.stringify(source.slice(Math.max(0, e.pos - 40), e.pos + 40))}...`);
    }
}
