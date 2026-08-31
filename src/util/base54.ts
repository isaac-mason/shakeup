// Frequency-ordered mangle alphabet — most-used JS identifier chars first, so short names
// bias toward bytes that gzip well. First char from the identifier-START set (54), the rest
// from the full identifier-PART set (adds digits). Ported verbatim from
// `llm/libs/oxc/crates/oxc_mangler/src/base54.rs:31`.
//
// Lives in `util/` rather than beside a renaming pass because it is a digit encoder with no
// renaming semantics: it turns an ordinal into the n-th shortest identifier and knows nothing about
// scopes, chunks or symbols. It used to sit in `deconflict.ts`, which does not call it — the only
// caller is `mangle/program.ts`, and that import was the sole tie from the language toolchain to the
// bundler half of the tree.
const BASE54_CHARS = 'etnriaoscludfpmhg_vybxSCwTEDOkAjMNPFILRzBVHUWGKqJYXZQ$1024368579';

/** The n-th shortest mangled identifier (`0→e`, `53→$`, `54→ee`, …). */
export function base54(n: number): string {
    let out = BASE54_CHARS[n % 54];
    let num = Math.floor(n / 54);
    while (num > 0) {
        num -= 1;
        out += BASE54_CHARS[num % 64];
        num = Math.floor(num / 64);
    }
    return out;
}
