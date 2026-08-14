/**
 * Demo: DIRECT function inlining on the TYPE+DATA AST (compilecat's @inline case).
 * Run: node examples/inline-demo.ts
 *
 * The ergonomics proof: native discriminated-union narrowing on `n.type` gives
 * typed `.data` with named fields (n.data.callee, n.data.arguments, ...), so the
 * transform reads like the grammar. No arena, no (ast,id) pairs, no column reads.
 *
 * Mechanics on display:
 *  1. find inlinable functions (single-statement `return <expr>` bodies)
 *  2. at each resolving call site, cloneNode the return expr with a substitute
 *     hook mapping param symbols -> argument subtrees
 *  3. repoint the call site in its parent (direct slot or list element)
 *  4. re-run analyze() — the rebuild-per-round contract
 *  5. print + execute before/after to prove behavioral equivalence
 */
import { type Node, type Program, N, FIELDS, isIdentifier, cloneNode, walkChildren, peekNodeId } from '../src/ast.ts';
import { parse } from '../src/parser.ts';
import { analyze, createSemantic, type Semantic } from '../src/analysis/semantic.ts';
import { isPureExpr } from '../src/analysis/effects.ts';

const source = [
    'export function madd(a, b, c) { return a * b + c; }',
    'export const r1 = madd(2, 3, 4);',
    'export const r2 = madd(r1, 10, madd(1, 2, 3));',
].join('\n');

/* ------------------------------------------------------------- the inliner */

function inlineDirectCalls(program: Program, sem: Semantic): number {
    // 1. collect inlinable functions: single-statement `return <expr>` bodies
    const inlinable = new Map<number, { params: Node[]; returnExpr: Node }>(); // fnSymbol -> info
    for (let stmt of program.data.body) {
        if (stmt.type === N.ExportNamedDeclaration && stmt.data.declaration !== null) stmt = stmt.data.declaration;
        if (stmt.type !== N.FunctionDeclaration || stmt.data.body === null) continue;
        const block = stmt.data.body;
        if (block.type !== N.BlockStatement || block.data.body.length !== 1) continue;
        const only = block.data.body[0];
        if (only.type !== N.ReturnStatement || only.data.argument === null) continue;
        // demo: simple ident params only
        const params: Node[] = [];
        for (const p of stmt.data.params) {
            if (p.type !== N.FormalParameter || p.data.pattern.type !== N.BindingIdentifier) { params.length = 0; break; }
            params.push(p.data.pattern);
        }
        if (params.length !== stmt.data.params.length || params.length === 0) continue;
        const id = stmt.data.id;
        if (id === null) continue;
        const fnSym = sem.nodeSymbol[id.id];
        if (fnSym !== 0) inlinable.set(fnSym, { params, returnExpr: only.data.argument });
    }

    // 2-3. walk; at each Call whose callee resolves to an inlinable fn, clone the
    // return expr with param->arg substitution and repoint the parent's slot.
    let count = 0;
    const visit = (node: Node): void => {
        walkChildren(node, (child, fieldIndex, listIndex) => {
            visit(child); // bottom-up: inner calls inline first
            if (child.type !== N.CallExpression || child.data.callee.type !== N.IdentifierReference) return;
            const fn = inlinable.get(sem.nodeSymbol[child.data.callee.id]);
            if (fn === undefined) return;
            // demo scope: every arg must be pure (else we'd hoist temps)
            const args = child.data.arguments;
            for (const a of args) if (!isPureExpr(a)) return;
            if (args.length !== fn.params.length) return;
            const paramSyms = fn.params.map((p) => sem.nodeSymbol[p.id]);
            const inlined = cloneNode(fn.returnExpr, (n) => {
                if (n.type !== N.IdentifierReference) return null;
                const at = paramSyms.indexOf(sem.nodeSymbol[n.id]);
                return at >= 0 ? cloneNode(args[at]) : null; // param -> arg copy
            })!;
            // repoint: direct slot vs list element — the distinction the walker surfaces.
            const data = (node as unknown as { data: Record<string, unknown> }).data;
            const field = fieldName(node, fieldIndex);
            if (listIndex >= 0) (data[field] as Node[])[listIndex] = inlined;
            else data[field] = inlined;
            count++;
        });
    };
    visit(program);
    return count;
}

/** field name at schema index (child navigation for the repoint above). */
function fieldName(node: Node, fieldIndex: number): string {
    return FIELDS[node.type][fieldIndex].name;
}

/* ------------------------------------------- tiny printer (demo grammar) */

function print(n: Node): string {
    if (isIdentifier(n.type)) return n.name; // any identifier role prints its name
    switch (n.type) {
        case N.NumericLiteral:
            return n.name;
        case N.BinaryExpression:
            return `(${print(n.data.left)} ${n.data.operator} ${print(n.data.right)})`;
        case N.CallExpression:
            return `${print(n.data.callee)}(${n.data.arguments.map(print).join(', ')})`;
        case N.VariableDeclaration: {
            const d = n.data.declarations[0];
            if (d.type !== N.VariableDeclarator) return '<vardecl>';
            return `const ${print(d.data.id)} = ${d.data.init === null ? '' : print(d.data.init)};`;
        }
        case N.ExportNamedDeclaration:
            return n.data.declaration !== null ? `export ${print(n.data.declaration)}` : '<export>';
        case N.FunctionDeclaration: {
            const params = n.data.params
                .map((p) => (p.type === N.FormalParameter ? print(p.data.pattern) : '?'))
                .join(', ');
            const body = n.data.body;
            const stmts = body !== null && body.type === N.BlockStatement ? body.data.body.map(print).join(' ') : '';
            return `function ${n.data.id === null ? '' : print(n.data.id)}(${params}) { ${stmts} }`;
        }
        case N.ReturnStatement:
            return `return ${n.data.argument === null ? '' : print(n.data.argument)};`;
        default:
            return `<${n.type}>`;
    }
}
function printModule(program: Program): string {
    return program.data.body.map(print).join('\n');
}

/* ---------------------------------------------------------------- run it */

const { program, nodeCount } = parse(source, { ts: true });
const sem = createSemantic();
analyze(sem, program, nodeCount);

console.log('— before:');
console.log(printModule(program));

const n = inlineDirectCalls(program, sem);
// rebuild-per-round: re-derive semantic over the mutated AST. cloneNode draws
// fresh ids from the shared counter, so `peekNodeId() + 1` covers every node
// (parsed + cloned) — no id collisions, one id space.
const sem2 = createSemantic();
analyze(sem2, program, peekNodeId() + 1);

console.log(`\n— after (${n} calls inlined):`);
const after = printModule(program);
console.log(after);

// prove equivalence by executing both
const a = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const b = await import(`data:text/javascript,${encodeURIComponent(after)}`);
console.log(`\n— execute: original r2=${a.r2}, inlined r2=${b.r2}, equal=${a.r2 === b.r2}`);
