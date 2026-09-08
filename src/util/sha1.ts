// SHA-1 and standard base64, for one caller: React Fast Refresh's signature key.
//
// oxc hashes the raw key with SHA-1 and encodes it with `BASE64_STANDARD` (`jsx/refresh.rs`), so
// reproducing its output means reproducing exactly that. shakeup's `util/hash.ts` is xxHash64 with a
// RADIX base64url encoding — a different algorithm and a different alphabet, so it cannot stand in.
//
// Hand-written because shakeup ships zero runtime dependencies. RFC 3174.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** SHA-1 of `text` (UTF-8), as 20 bytes. */
export function sha1(text: string): Uint8Array {
    const msg = new TextEncoder().encode(text);
    // Padded length: message + 0x80 + zeros + 8-byte big-endian bit length, rounded to 64.
    const total = (((msg.length + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(total);
    buf.set(msg);
    buf[msg.length] = 0x80;
    const view = new DataView(buf.buffer);
    // The length is in BITS and 64-bit; messages here are far under 2^32 bytes, so the high word is
    // always zero and only the low one is written.
    view.setUint32(total - 4, msg.length * 8, false);

    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;

    const w = new Int32Array(80);
    for (let i = 0; i < total; i += 64) {
        for (let j = 0; j < 16; j++) w[j] = view.getInt32(i + j * 4, false);
        for (let j = 16; j < 80; j++) {
            const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
            w[j] = (x << 1) | (x >>> 31);
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        for (let j = 0; j < 80; j++) {
            let f: number;
            let k: number;
            if (j < 20) {
                f = (b & c) | (~b & d);
                k = 0x5a827999;
            } else if (j < 40) {
                f = b ^ c ^ d;
                k = 0x6ed9eba1;
            } else if (j < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdc;
            } else {
                f = b ^ c ^ d;
                k = 0xca62c1d6;
            }
            const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0;
            e = d;
            d = c;
            c = (b << 30) | (b >>> 2);
            b = a;
            a = t;
        }
        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0;
    }

    const out = new Uint8Array(20);
    new DataView(out.buffer).setInt32(0, h0, false);
    new DataView(out.buffer).setInt32(4, h1, false);
    new DataView(out.buffer).setInt32(8, h2, false);
    new DataView(out.buffer).setInt32(12, h3, false);
    new DataView(out.buffer).setInt32(16, h4, false);
    return out;
}

/** STANDARD base64 (`+/`, `=` padded) of raw bytes — not `util/hash.ts`'s radix base64url. */
export function base64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        out += BASE64[b0 >> 2];
        out += BASE64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
        out += b1 === undefined ? '=' : BASE64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
        out += b2 === undefined ? '=' : BASE64[b2 & 63];
    }
    return out;
}
