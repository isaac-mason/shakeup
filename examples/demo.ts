/**
 * Demo: parse real code into the flat AST, walk it, run a small transform.
 * Run: node examples/demo.ts   (Node >= 23 strips types natively)
 */
import { readFileSync } from 'node:fs';
import {
    A,
    FL,
    N,
    OP,
    TYPE_NAME,
    cloneSubtree,
    createAst,
    make,

    text,
    toObject,
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
const { ast, program } = parse(createAst(), snippet, { ts: true });
console.log('— snippet parse:', ast.nodeCount - 1, 'nodes,', ast.errors.length, 'errors');
if (ast.errors.length) console.log(ast.errors);

/* 2 — transform demo: count + collect every member access path like `a.x` */
const memberPaths: string[] = [];
walk(ast, program, (id) => {
    if (ast.type[id] === N.Member && (ast.flags[id] & FL.COMPUTED) === 0) {
        const obj = A.Member.object(ast, id);
        const prop = A.Member.property(ast, id);
        if (ast.type[obj] === N.Ident) memberPaths.push(`${text(ast, obj)}.${text(ast, prop)}`);
    }
});
console.log('— member accesses:', memberPaths.join(' '));

/* 3 — transform demo: constant-fold `x * 1` and `x + 0` in place */
const before = JSON.stringify(toObject(ast, program)).length;
let folds = 0;
walk(ast, program, (id): void => {
    if (ast.type[id] !== N.Binary) return;
    const op = ast.flags[id];
    const right = A.Binary.right(ast, id);
    if (ast.type[right] !== N.Num) return;
    const rtext = text(ast, right);
    if ((op === OP.MUL && rtext === '1') || (op === OP.ADD && rtext === '0')) {
        // fold: replace this Binary with its left operand — repoint via parent slot
        // (demo uses the walker's field info: here we just overwrite the node in place
        // by turning it into its left child via column copy — cheapest possible fold)
        const left = A.Binary.left(ast, id);
        ast.type[id] = ast.type[left];
        ast.flags[id] = ast.flags[left];
        ast.a[id] = ast.a[left];
        ast.b[id] = ast.b[left];
        ast.start[id] = ast.start[left];
        ast.end[id] = ast.end[left];
        folds++;
    }
});
console.log('— folded', folds, 'no-op arithmetic nodes (x*1, x+0); tree bytes', before, '->', JSON.stringify(toObject(ast, program)).length);

/* 4 — clone-with-substitution demo (the inlining primitive) */
const src2 = parse(createAst(), 'const doubled = v.x * 2 + v.y * 2;', { ts: true });
const target = createAst(); // a fresh module arena — no parse needed to init
const decl = (() => {
    let found = 0;
    walk(src2.ast, src2.program, (id) => {
        if (src2.ast.type[id] === N.Binary && found === 0) { found = id; return false; }
        return;
    });
    return found;
})();
// clone `v.x * 2 + v.y * 2` into another module, renaming `v` -> `vec`
const renamed = cloneSubtree(src2.ast, decl, target, (sa, id, dst) => {
    if (sa.type[id] === N.Ident && text(sa, id) === 'v') {
        return make.Ident(dst, 0, 0, 0); // span 0 = synthetic; real impl records name in a side table
    }
    return 0;
});
console.log('— cross-module clone ok:', TYPE_NAME[target.type[renamed]], 'root,', target.nodeCount - 1, 'nodes in target arena');

/* 5 — TS-awareness demo: read tuple arity / interface fields (the compilecat queries) */
const ts = parse(createAst(), 'interface V { x: number; y: number }; type T3 = [number, number, number];', { ts: true });
walk(ts.ast, ts.program, (id) => {
    const t = ts.ast.type[id];
    if (t === N.TSInterfaceDecl) {
        const fields: string[] = [];
        walkChildren(ts.ast, id, (m) => {
            if (ts.ast.type[m] === N.TSPropSig) fields.push(text(ts.ast, A.TSPropSig.key(ts.ast, m)));
        });
        console.log('— interface', text(ts.ast, A.TSInterfaceDecl.id(ts.ast, id)), 'fields:', fields.join(','));
    }
    if (t === N.TSTuple) {
        let n = 0;
        walkChildren(ts.ast, id, () => { n++; });
        console.log('— tuple arity:', n);
    }
});

/* 6 — the real test: parse the fixtures */
for (const [name, path, isTs] of [
    ['three.core.js', new URL('../spikes/node_modules/three/build/three.core.js', import.meta.url), false],
    ['crashcat concat', null, true],
] as const) {
    let source: string;
    if (path) source = readFileSync(path, 'utf8');
    else {
        const { readdirSync, statSync } = await import('node:fs');
        const { join } = await import('node:path');
        const files: string[] = [];
        const walkDir = (d: string) => {
            for (const f of readdirSync(d)) {
                const p = join(d, f);
                if (statSync(p).isDirectory()) walkDir(p);
                else if (f.endsWith('.ts')) files.push(readFileSync(p, 'utf8'));
            }
        };
        walkDir('/Users/isaacmason/Development/crashcat/src');
        source = files.join('\n');
    }
    const t0 = performance.now();
    const r = parse(createAst(), source, { ts: isTs });
    const dt = performance.now() - t0;
    const mb = source.length / 1024 / 1024;
    console.log(
        `— ${name}: ${(mb).toFixed(2)}MB, ${r.ast.nodeCount - 1} nodes, ${r.ast.errors.length} errors, ${dt.toFixed(1)}ms (${(mb / (dt / 1000)).toFixed(1)} MB/s cold)`,
    );
    for (const e of r.ast.errors.slice(0, 5)) {
        const line = source.slice(0, e.pos).split('\n').length;
        console.log(`   err L${line}: ${e.msg} — ...${JSON.stringify(source.slice(Math.max(0, e.pos - 40), e.pos + 40))}...`);
    }
}
