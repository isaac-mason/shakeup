/** Expression precedence ladder, ascending (higher binds tighter). Ported from
 *  `oxc_syntax::precedence::Precedence` (referenced in
 *  `llm/libs/oxc/crates/oxc_codegen/src/lib.rs:22`). The printer wraps a child in
 *  parentheses iff the child's precedence is below what its position requires. */
export enum Prec {
    Lowest = 0,
    Comma, // sequence ,
    Assign, // = += … , yield, arrow  (right-assoc)
    Conditional, // ?:  (right-assoc)
    NullishCoalescing, // ??
    LogicalOr, // ||
    LogicalAnd, // &&
    BitOr, // |
    BitXor, // ^
    BitAnd, // &
    Equality, // == != === !==
    Relational, // < > <= >= instanceof in
    Shift, // << >> >>>
    Additive, // + -
    Multiplicative, // * / %
    Exponent, // **  (right-assoc)
    Unary, // ! ~ + - typeof void delete await, prefix ++/--
    Postfix, // postfix ++/--
    New, // new without arguments
    Call, // call, member access, new with arguments
    Primary, // literals, identifiers, parenthesised, this, array/object literals
}

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
