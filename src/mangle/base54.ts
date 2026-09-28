// Port of `oxc_mangler/src/base54.rs`.

/** In character-frequency order, so the most used characters come first (oxc's list, digits moved last). */
const BASE54_CHARS = 'etnriaoscludfpmhg_vybxSCwTEDOkAjMNPFILRzBVHUWGKqJYXZQ$1024368579';

/** The shortest mangled name for `n`: `0` is `e`, `53` is `$`, `54` is `ee`. */
export function base54(n: number): string {
    let num = n;
    // Base 54 first: the characters that may start an identifier.
    const FIRST_BASE = 54;
    let str = BASE54_CHARS[num % FIRST_BASE];
    num = Math.floor(num / FIRST_BASE);
    // Base 64 for the rest, which may also be digits.
    const REST_BASE = 64;
    while (num > 0) {
        num -= 1;
        str += BASE54_CHARS[num % REST_BASE];
        num = Math.floor(num / REST_BASE);
    }
    return str;
}
