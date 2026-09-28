/** A primitive value an expression is known to evaluate to. oxc's `ConstantValue`
 *  (`oxc_ecmascript/src/value.rs`). */
export type ConstantValue =
    | { kind: 'number'; value: number }
    | { kind: 'bigint'; value: bigint }
    | { kind: 'string'; value: string }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'undefined' }
    | { kind: 'null' };
