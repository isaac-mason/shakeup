import { type Node, type Program, N, isIdentifier, cloneNode, walkChildren } from '../src/ast.ts';
import { parse } from '../src/parser.ts';
import { analyze, createSemantic, symbolOf, type Semantic } from '../src/analysis/semantic.ts';
import { isPureExpr } from '../src/analysis/effects.ts';

const source = [
    'export function madd(a, b, c) { return a * b + c; }',
    'export const r1 = madd(2, 3, 4);',
    'export const r2 = madd(r1, 10, madd(1, 2, 3));',
].join('\n');

function inlineDirectCalls(program: Program, sem: Semantic): number {
    const inlinable = new Map<number, { params: Node[]; returnExpr: Node }>();
    for (let stmt of program.data.body) {
        if (stmt.type === N.ExportNamedDeclaration && stmt.data.declaration !== null) stmt = stmt.data.declaration;
        if (stmt.type !== N.FunctionDeclaration || stmt.data.body === null) continue;
        const block = stmt.data.body;
        if (block.type !== N.BlockStatement || block.data.body.length !== 1) continue;
        const only = block.data.body[0];
        if (only.type !== N.ReturnStatement || only.data.argument === null) continue;
        const params: Node[] = [];
        for (const p of stmt.data.params) {
            if (p.type !== N.FormalParameter || p.data.pattern.type !== N.BindingIdentifier) { params.length = 0; break; }
            params.push(p.data.pattern);
        }
        if (params.length !== stmt.data.params.length || params.length === 0) continue;
        const id = stmt.data.id;
        if (id === null) continue;
        const fnSym = symbolOf(sem, id);
        if (fnSym !== 0) inlinable.set(fnSym, { params, returnExpr: only.data.argument });
    }

    let count = 0;
    const visit = (node: Node): void => {
        walkChildren(node, (child, field, listIndex) => {
            visit(child);
            if (child.type !== N.CallExpression || child.data.callee.type !== N.IdentifierReference) return;
            const fn = inlinable.get(symbolOf(sem, child.data.callee));
            if (fn === undefined) return;
            const args = child.data.arguments;
            for (const a of args) if (!isPureExpr(a, true)) return;
            if (args.length !== fn.params.length) return;
            const paramSyms = fn.params.map((p) => symbolOf(sem, p));
            const inlined = cloneNode(fn.returnExpr, (n) => {
                if (n.type !== N.IdentifierReference) return null;
                const at = paramSyms.indexOf(symbolOf(sem, n));
                return at >= 0 ? cloneNode(args[at]) : null;
            })!;
            const data = (node as unknown as { data: Record<string, unknown> }).data;
            if (listIndex >= 0) (data[field] as Node[])[listIndex] = inlined;
            else data[field] = inlined;
            count++;
        });
    };
    visit(program);
    return count;
}

/** field name at schema index (child navigation for the repoint above). */

function print(n: Node): string {
    if (isIdentifier(n.type)) return n.name;
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

const { program } = parse(source, { ts: true, jsx: false });
const sem = createSemantic();
analyze(sem, program);

console.log('— before:');
console.log(printModule(program));

const n = inlineDirectCalls(program, sem);
const sem2 = createSemantic();
analyze(sem2, program);

console.log(`\n— after (${n} calls inlined):`);
const after = printModule(program);
console.log(after);

const a = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const b = await import(`data:text/javascript,${encodeURIComponent(after)}`);
console.log(`\n— execute: original r2=${a.r2}, inlined r2=${b.r2}, equal=${a.r2 === b.r2}`);
