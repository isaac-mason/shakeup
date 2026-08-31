/** Expression precedence ladder, ascending (higher binds tighter). Ported from
 *  `oxc_syntax::precedence::Precedence` (referenced in
 *  `llm/libs/oxc/crates/oxc_codegen/src/lib.rs:22`). The printer wraps a child in
 *  parentheses iff the child's precedence is below what its position requires. */
export const Prec = {
    Lowest: 0,
    Comma: 1, // sequence ,
    Assign: 2, // = += … , yield, arrow  (right-assoc)
    Conditional: 3, // ?:  (right-assoc)
    NullishCoalescing: 4, // ??
    LogicalOr: 5, // ||
    LogicalAnd: 6, // &&
    BitOr: 7, // |
    BitXor: 8, // ^
    BitAnd: 9, // &
    Equality: 10, // == != === !==
    Relational: 11, // < > <= >= instanceof in
    Shift: 12, // << >> >>>
    Additive: 13, // + -
    Multiplicative: 14, // * / %
    Exponent: 15, // **  (right-assoc)
    Unary: 16, // ! ~ + - typeof void delete await, prefix ++/--
    Postfix: 17, // postfix ++/--
    New: 18, // new without arguments
    Call: 19, // call, member access, new with arguments
    Primary: 20, // literals, identifiers, parenthesised, this, array/object literals
} as const;
export type Prec = (typeof Prec)[keyof typeof Prec];

/** Binary (non-logical) operator → precedence. */
export const BINARY_PREC: Record<string, Prec> = {
    '**': Prec.Exponent,
    '*': Prec.Multiplicative,
    '/': Prec.Multiplicative,
    '%': Prec.Multiplicative,
    '+': Prec.Additive,
    '-': Prec.Additive,
    '<<': Prec.Shift,
    '>>': Prec.Shift,
    '>>>': Prec.Shift,
    '<': Prec.Relational,
    '>': Prec.Relational,
    '<=': Prec.Relational,
    '>=': Prec.Relational,
    instanceof: Prec.Relational,
    in: Prec.Relational,
    '==': Prec.Equality,
    '!=': Prec.Equality,
    '===': Prec.Equality,
    '!==': Prec.Equality,
    '&': Prec.BitAnd,
    '^': Prec.BitXor,
    '|': Prec.BitOr,
};

/** Logical operator → precedence. */
export const LOGICAL_PREC: Record<string, Prec> = {
    '||': Prec.LogicalOr,
    '&&': Prec.LogicalAnd,
    '??': Prec.NullishCoalescing,
};

/** `**` is right-associative; every other binary/logical operator is left-associative. */
export const isRightAssoc = (operator: string): boolean => operator === '**';
