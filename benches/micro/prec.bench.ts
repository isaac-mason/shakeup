import { bench, group } from '@pmndrs/labs';

// `precOf` — a ~20-case switch over 151 node types, called once per EXPRESSION from `printExpr`.
// 1.40% of a crashcat bundling profile.
//
// Unlike the `parens` arm in `emit.bench.ts`, this is NOT a wrapper around other work — `precOf` IS
// the work, so measuring it standalone is representative. What has to be realistic is the INPUT
// DISTRIBUTION, taken from three.core.js: IdentifierReference 18.7%, IdentifierName 14.1%,
// StaticMemberExpression 12.0%, ExpressionStatement 5.6%, BindingIdentifier 5.3%, ThisExpression 5.2%,
// BinaryExpression 4.6%, NumericLiteral 4.2%, AssignmentExpression 3.7%, CallExpression 3.6%.
//
// So the COMMON path is `default` (identifiers, literals, `this`) and the constant cases; only ~4.6%
// of calls reach the string-keyed `BINARY_PREC[operator]` lookup. The question is whether the switch
// dispatch itself is worth replacing with a table indexed by node type.
const enum Prec { Comma = 1, Assign = 2, Conditional = 3, Unary = 12, Postfix = 13, New = 14, Call = 15, Primary = 16 }

// Node type ids, mirroring the real enum's shape (dense small integers, ~151 of them).
const T = {
    IdentifierReference: 10, IdentifierName: 11, StaticMember: 20, ExpressionStatement: 30,
    BindingIdentifier: 12, ThisExpression: 13, Binary: 40, Numeric: 14, Assignment: 41,
    Call: 21, Sequence: 42, Conditional: 43, Logical: 44, Unary: 45, Update: 46, New: 47, Arrow: 48,
} as const;
const NTYPES = 151;

const BINARY_PREC: Record<string, number> = { '+': 9, '-': 9, '*': 10, '/': 10, '===': 6, '<': 7, '&&': 4 };
const LOGICAL_PREC: Record<string, number> = { '&&': 4, '||': 3, '??': 3 };

type BNode = { type: number; op: string; prefix: boolean; argc: number };

/** Weighted stream matching the measured distribution. */
function nodeStream(n: number): BNode[] {
    const weights: [number, number][] = [
        [T.IdentifierReference, 18.7], [T.IdentifierName, 14.1], [T.StaticMember, 12.0],
        [T.ExpressionStatement, 5.6], [T.BindingIdentifier, 5.3], [T.ThisExpression, 5.2],
        [T.Binary, 4.6], [T.Numeric, 4.2], [T.Assignment, 3.7], [T.Call, 3.6],
        [T.Sequence, 1.0], [T.Conditional, 1.5], [T.Logical, 2.0], [T.Unary, 2.5],
        [T.Update, 1.0], [T.New, 0.8], [T.Arrow, 1.2],
    ];
    const bag: number[] = [];
    for (const [t, w] of weights) for (let i = 0; i < Math.round(w * 10); i++) bag.push(t);
    const ops = ['+', '-', '*', '/', '===', '<'];
    const logs = ['&&', '||', '??'];
    const out: BNode[] = new Array(n);
    let seed = 424242;
    for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const t = bag[seed % bag.length];
        out[i] = {
            type: t,
            op: t === T.Logical ? logs[seed % logs.length] : ops[seed % ops.length],
            prefix: (seed & 1) === 0,
            argc: seed % 3,
        };
    }
    return out;
}

/** Today's shape. */
function precSwitch(n: BNode): number {
    switch (n.type) {
        case T.Sequence: return Prec.Comma;
        case T.Assignment: case T.Arrow: return Prec.Assign;
        case T.Conditional: return Prec.Conditional;
        case T.Logical: return LOGICAL_PREC[n.op];
        case T.Binary: return BINARY_PREC[n.op];
        case T.Unary: return Prec.Unary;
        case T.Update: return n.prefix ? Prec.Unary : Prec.Postfix;
        case T.New: return n.argc > 0 ? Prec.Call : Prec.New;
        case T.Call: case T.StaticMember: return Prec.Call;
        default: return Prec.Primary;
    }
}

/** Table indexed by node type; -1 marks the four data-dependent types. */
const PREC_TABLE = (() => {
    const t = new Int8Array(NTYPES).fill(Prec.Primary);
    t[T.Sequence] = Prec.Comma;
    t[T.Assignment] = Prec.Assign; t[T.Arrow] = Prec.Assign;
    t[T.Conditional] = Prec.Conditional;
    t[T.Unary] = Prec.Unary;
    t[T.Call] = Prec.Call; t[T.StaticMember] = Prec.Call;
    t[T.Logical] = -1; t[T.Binary] = -1; t[T.Update] = -1; t[T.New] = -1;
    return t;
})();

function precTable(n: BNode): number {
    const p = PREC_TABLE[n.type];
    if (p >= 0) return p;
    switch (n.type) {
        case T.Logical: return LOGICAL_PREC[n.op];
        case T.Binary: return BINARY_PREC[n.op];
        case T.Update: return n.prefix ? Prec.Unary : Prec.Postfix;
        default: return n.argc > 0 ? Prec.Call : Prec.New;
    }
}

let EXPECT = -1;
function same(v: number): number {
    if (EXPECT === -1) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
}

const NODES = nodeStream(300_000);

group('precOf: switch vs type-indexed table @micro @prec', () => {
    bench('switch on node type (today)', function* () {
        yield () => {
            let acc = 0;
            for (let i = 0; i < NODES.length; i++) acc += precSwitch(NODES[i]);
            return same(acc);
        };
    }).gc(true);

    bench('Int8Array table + fallthrough', function* () {
        yield () => {
            let acc = 0;
            for (let i = 0; i < NODES.length; i++) acc += precTable(NODES[i]);
            return same(acc);
        };
    }).gc(true);
});
