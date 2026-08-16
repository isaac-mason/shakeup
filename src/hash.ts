// --- xxHash64 (64-bit) ------------------------------------------------------
// A faithful, allocation-light xxHash64 over BigInt (browser-safe; no 64-bit intrinsics).
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const MASK = 0xffffffffffffffffn;

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK;
const round = (acc: bigint, input: bigint): bigint => (rotl((acc + input * P2) & MASK, 31n) * P1) & MASK;
const mergeRound = (acc: bigint, val: bigint): bigint => {
    val = round(0n, val);
    acc = (acc ^ val) & MASK;
    return (acc * P1 + P4) & MASK;
};

/** xxHash64 of `bytes` (seed 0) returning a 64-bit unsigned {@link bigint}. */
function xxh64(bytes: Uint8Array): bigint {
    const len = bytes.length;
    // Little-endian readers over the byte view.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 0;
    let h: bigint;
    if (len >= 32) {
        let v1 = (P1 + P2) & MASK;
        let v2 = P2;
        let v3 = 0n;
        let v4 = (0n - P1) & MASK;
        const limit = len - 32;
        do {
            v1 = round(v1, view.getBigUint64(i, true));
            i += 8;
            v2 = round(v2, view.getBigUint64(i, true));
            i += 8;
            v3 = round(v3, view.getBigUint64(i, true));
            i += 8;
            v4 = round(v4, view.getBigUint64(i, true));
            i += 8;
        } while (i <= limit);
        h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
        h = mergeRound(h, v1);
        h = mergeRound(h, v2);
        h = mergeRound(h, v3);
        h = mergeRound(h, v4);
    } else {
        h = (P5 + BigInt(len)) & MASK;
    }
    h = (h + BigInt(len)) & MASK;

    while (i + 8 <= len) {
        const k1 = round(0n, view.getBigUint64(i, true));
        h = (h ^ k1) & MASK;
        h = (rotl(h, 27n) * P1 + P4) & MASK;
        i += 8;
    }
    if (i + 4 <= len) {
        h = (h ^ ((BigInt(view.getUint32(i, true)) * P1) & MASK)) & MASK;
        h = (rotl(h, 23n) * P2 + P3) & MASK;
        i += 4;
    }
    while (i < len) {
        h = (h ^ ((BigInt(bytes[i]) * P5) & MASK)) & MASK;
        h = (rotl(h, 11n) * P1) & MASK;
        i += 1;
    }
    // Avalanche.
    h = (h ^ (h >> 33n)) & MASK;
    h = (h * P2) & MASK;
    h = (h ^ (h >> 29n)) & MASK;
    h = (h * P3) & MASK;
    h = (h ^ (h >> 32n)) & MASK;
    return h & MASK;
}

let textEncoder: TextEncoder;
const toBytes = (input: string | Uint8Array): Uint8Array => {
    if (typeof input !== 'string') return input;
    textEncoder ??= new TextEncoder();
    return textEncoder.encode(input);
};

// --- encodings --------------------------------------------------------------
// url-safe base64 alphabet (matches rolldown's base64url output for [hash] tokens).
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Encode a 64-bit value big-endian in `radix`-char groups of the given `alphabet`. */
function encodeRadix(value: bigint, alphabet: string): string {
    const base = BigInt(alphabet.length);
    if (value === 0n) return alphabet[0];
    let out = '';
    let v = value;
    while (v > 0n) {
        out = alphabet[Number(v % base)] + out;
        v /= base;
    }
    return out;
}

/** Full hash encodings for one input, over a widened 128-bit space (two xxh64 rounds) so the
 *  string is long enough for `MAX_HASH_SIZE` (21) slices without exhausting entropy. */
export type Hashes = { base64: string; base36: string; hex: string };

const SALT = new Uint8Array([0x9e, 0x37, 0x79, 0xb1]);

export function hashAll(input: string | Uint8Array): Hashes {
    const bytes = toBytes(input);
    const h1 = xxh64(bytes);
    // Second, salted round widens the space to ~128 bits so 21-char base64 slices stay populated.
    const salted = new Uint8Array(bytes.length + SALT.length);
    salted.set(SALT, 0);
    salted.set(bytes, SALT.length);
    const h2 = xxh64(salted);
    const combined = (h1 << 64n) | h2;
    // hex is fixed-width (32 nibbles) — pad so short values don't shrink; the two 64-bit halves.
    const hex = h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0');
    return {
        base64: encodeRadix(combined, B64URL),
        base36: encodeRadix(combined, B36),
        hex,
    };
}

export type HashCharacters = 'base64' | 'base36' | 'hex';
export type GetHash = (input: string | Uint8Array) => string;

/** A hasher for one encoding, mirroring rollup `crypto.ts` `hasherByType`. Output is always
 *  long enough to be sliced to `MAX_HASH_SIZE` (21). */
export const hasherByType: Record<HashCharacters, GetHash> = {
    base64: (input) => hashAll(input).base64.padEnd(21, '0'),
    base36: (input) => hashAll(input).base36.padEnd(21, '0'),
    hex: (input) => hashAll(input).hex,
};
