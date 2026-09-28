// Port of oxc_minifier/src/symbol_value.rs.

import type { ConstantValue } from '../../analysis/constant-value.ts';
import { ReferenceFlags } from './syntax.ts';

/** The kind of fresh value a binding was initialized with, or `'none'` when the value may alias
 *  another binding (or is untracked). */
export type FreshValueKind = 'none' | 'function' | 'class' | 'object' | 'array';

/** Cached counts for the resolved references to a symbol. */
export type ReferenceCounts = { reads: number; writes: number; memberWriteTargetReads: number };

export function createReferenceCounts(): ReferenceCounts {
    return { reads: 0, writes: 0, memberWriteTargetReads: 0 };
}

export function recordReferenceCount(counts: ReferenceCounts, flags: number): void {
    if ((flags & ReferenceFlags.Read) !== 0) counts.reads++;
    if ((flags & ReferenceFlags.Write) !== 0) counts.writes++;
    if ((flags & ReferenceFlags.MemberWriteTarget) !== 0) counts.memberWriteTargetReads++;
}

export const countsHaveReads = (counts: ReferenceCounts): boolean => counts.reads > 0;
export const countsHaveWrites = (counts: ReferenceCounts): boolean => counts.writes > 0;
export const countsHaveSingleRead = (counts: ReferenceCounts): boolean => counts.reads === 1;
export const countsHaveMultipleReads = (counts: ReferenceCounts): boolean => counts.reads > 1;
export const countsHaveOnlyMemberWriteTargetReads = (counts: ReferenceCounts): boolean =>
    counts.writes === 0 && counts.reads === counts.memberWriteTargetReads;

export type SymbolValue = {
    /** Initialized constant value evaluated from expressions, or null when not a constant. */
    initializedConstant: ConstantValue | null;
    /** `initializedConstant` is the implicit `undefined` of a declaration with no initializer. */
    implicitUndefined: boolean;
    references: ReferenceCounts;
    kind: FreshValueKind;
    /** Provably falsy in boolean context, though not foldable in value context. */
    booleanFalsy: boolean;
};

/** Byte length of the string's UTF-8 encoding, which is what Rust's `str::len` measures. */
function utf8Length(value: string): number {
    let length = 0;
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit < 0x80) length += 1;
        else if (unit < 0x800) length += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                length += 4;
                index++;
            } else length += 3;
        } else length += 3;
    }
    return length;
}

/** oxc `SymbolValue::can_inline_initialized_constant`. */
export function canInlineInitializedConstant(value: SymbolValue): boolean {
    if (countsHaveWrites(value.references) || value.implicitUndefined) return false;
    const constant = value.initializedConstant;
    if (constant === null) return false;
    if (countsHaveSingleRead(value.references)) return true;
    switch (constant.kind) {
        case 'number':
            return constant.value % 1 === 0 && constant.value >= -99 && constant.value <= 999;
        case 'bigint':
            return false;
        case 'string':
            return utf8Length(constant.value) <= 3;
        case 'boolean':
        case 'undefined':
        case 'null':
            return true;
    }
}
