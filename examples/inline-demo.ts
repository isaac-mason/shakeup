/**
 * Demo: DIRECT function inlining on the flat AST (compilecat's @inline case).
 * Run: node examples/inline-demo.ts
 *
 * Mechanics on display:
 *  1. find call sites whose callee resolves (via semantic) to an inlinable fn
 *  2. cloneSubtree the fn's return expression with a substitute hook mapping
 *     param symbols -> argument subtrees
 *  3. repoint the call site's parent slot to the clone (setField via walker)
 *  4. re-run analyze() — the rebuild-per-round contract
 *  5. print + execute before/after to prove behavioral equivalence
 */
import { A, N, OP, type Ast, type NodeId, createAst, cloneSubtree, listAt, listLen, setField, spliceList, text, walkChildren } from '../src/ast.ts';
import { parse } from '../src/parser.ts';
import { analyze, createSemantic, type Semantic } from '../src/analysis/semantic.ts';
import { isPureExpr } from '../src/analysis/effects.ts';

const source = [
    'export function madd(a, b, c) { return a * b + c; }',
    'export const r1 = madd(2, 3, 4);',
    'export const r2 = madd(r1, 10, madd(1, 2, 3));',
].join('\n');

/* ------------------------------------------------------------- the inliner */

function inlineDirectCalls(ast: Ast, program: NodeId, sem: Semantic): number {
    // 1. collect inlinable functions: single-statement `return <expr>` bodies
    const inlinable = new Map<number, { params: NodeId[]; returnExpr: NodeId }>(); // fnSymbol -> info
    const body = A.Program.body(ast, program);
    for (let i = 0; i < listLen(ast, body); i++) {
        let stmt = listAt(ast, body, i);
        if (ast.type[stmt] === N.ExportNamed) stmt = A.ExportNamed.decl(ast, stmt);
        if (ast.type[stmt] !== N.FuncDecl) continue;
        const fnBody = A.FuncDecl.body(ast, stmt);
        if (listLen(ast, A.Block.body(ast, fnBody)) !== 1) continue;
        const only = listAt(ast, A.Block.body(ast, fnBody), 0);
        if (ast.type[only] !== N.Return) continue;
        const returnExpr = A.Return.arg(ast, only);
        if (returnExpr === 0) continue;
        const paramsRef = A.FuncDecl.params(ast, stmt);
        const params: NodeId[] = [];
        for (let p = 0; p < listLen(ast, paramsRef); p++) {
            const pat = A.Param.pattern(ast, listAt(ast, paramsRef, p));
            if (ast.type[pat] !== N.Ident) break; // demo: simple params only
            params.push(pat);
        }
        if (params.length !== listLen(ast, paramsRef)) continue;
        const fnSym = sem.nodeSymbol[A.FuncDecl.id(ast, stmt)];
        if (fnSym !== 0) inlinable.set(fnSym, { params, returnExpr });
    }

    // 2-3. walk; at each Call whose callee resolves to an inlinable fn, clone
    // the return expr with substitution and repoint the parent's slot.
    let count = 0;
    const visit = (node: NodeId): void => {
        walkChildren(ast, node, (child, fieldIndex, listIndex) => {
            visit(child); // bottom-up: inner calls inline first
            if (ast.type[child] !== N.Call) return;
            const callee = A.Call.callee(ast, child);
            if (ast.type[callee] !== N.Ident) return;
            const fn = inlinable.get(sem.nodeSymbol[callee]);
            if (fn === undefined) return;
            const argsRef = A.Call.args(ast, child);
            // demo scope: every arg must be pure (else we'd hoist temps via spliceList)
            const args: NodeId[] = [];
            for (let i = 0; i < listLen(ast, argsRef); i++) {
                const a = listAt(ast, argsRef, i);
                if (!isPureExpr(ast, a)) return;
                args.push(a);
            }
            if (args.length !== fn.params.length) return;
            const paramSyms = fn.params.map((p) => sem.nodeSymbol[p]);
            const inlined = cloneSubtree(ast, fn.returnExpr, ast, (src, id) => {
                if (src.type[id] !== N.Ident) return 0;
                const at = paramSyms.indexOf(sem.nodeSymbol[id]);
                return at >= 0 ? cloneSubtree(src, args[at], ast) : 0; // param -> arg copy
            });
            // repoint: direct slot vs list element — the distinction the first
            // run of this demo got wrong (and the walker now surfaces)
            if (listIndex >= 0) spliceList(ast, node, fieldIndex, listIndex, 1, [inlined]);
            else setField(ast, node, fieldIndex, inlined);
            count++;
        });
    };
    visit(program);
    return count;
}

/* ------------------------------------------- tiny printer (demo grammar) */

const OP_TEXT: Record<number, string> = { [OP.ADD]: '+', [OP.SUB]: '-', [OP.MUL]: '*', [OP.DIV]: '/' };
function print(ast: Ast, id: NodeId): string {
    switch (ast.type[id]) {
        case N.Ident:
        case N.Num:
            return text(ast, id);
        case N.Binary:
            return `(${print(ast, A.Binary.left(ast, id))} ${OP_TEXT[ast.flags[id] & 63]} ${print(ast, A.Binary.right(ast, id))})`;
        case N.Call: {
            const args: string[] = [];
            const ref = A.Call.args(ast, id);
            for (let i = 0; i < listLen(ast, ref); i++) args.push(print(ast, listAt(ast, ref, i)));
            return `${print(ast, A.Call.callee(ast, id))}(${args.join(', ')})`;
        }
        case N.VarDecl: {
            const d = listAt(ast, A.VarDecl.declarators(ast, id), 0);
            return `const ${text(ast, A.VarDeclarator.id(ast, d))} = ${print(ast, A.VarDeclarator.init(ast, d))};`;
        }
        case N.ExportNamed: {
            const decl = A.ExportNamed.decl(ast, id);
            return decl !== 0 ? `export ${print(ast, decl)}` : '<export>';
        }
        case N.FuncDecl: {
            const params: string[] = [];
            const ref = A.FuncDecl.params(ast, id);
            for (let i = 0; i < listLen(ast, ref); i++) params.push(text(ast, A.Param.pattern(ast, listAt(ast, ref, i))));
            const stmts: string[] = [];
            const b = A.Block.body(ast, A.FuncDecl.body(ast, id));
            for (let i = 0; i < listLen(ast, b); i++) stmts.push(print(ast, listAt(ast, b, i)));
            return `function ${text(ast, A.FuncDecl.id(ast, id))}(${params.join(', ')}) { ${stmts.join(' ')} }`;
        }
        case N.Return:
            return `return ${print(ast, A.Return.arg(ast, id))};`;
        default:
            return `<${ast.type[id]}>`;
    }
}
function printModule(ast: Ast, program: NodeId): string {
    const out: string[] = [];
    const body = A.Program.body(ast, program);
    for (let i = 0; i < listLen(ast, body); i++) out.push(print(ast, listAt(ast, body, i)));
    return out.join('\n');
}

/* ---------------------------------------------------------------- run it */

const ast = createAst();
const { program } = parse(ast, source, { ts: true });
const sem = createSemantic();
analyze(sem, ast, program);

console.log('— before:');
console.log(printModule(ast, program));

const n = inlineDirectCalls(ast, program, sem);
analyze(sem, ast, program); // rebuild-per-round: semantic re-derives over the mutated AST

console.log(`\n— after (${n} calls inlined):`);
const after = printModule(ast, program);
console.log(after);

// prove equivalence by executing both
const a = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const b = await import(`data:text/javascript,${encodeURIComponent(after)}`);
console.log(`\n— execute: original r2=${a.r2}, inlined r2=${b.r2}, equal=${a.r2 === b.r2}`);
console.log(`— arena: ${ast.nodeCount - 1} nodes (grew by clones; dead call nodes are unreferenced garbage until re-parse)`);
