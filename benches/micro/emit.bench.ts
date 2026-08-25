import { bench, group } from '@pmndrs/labs';

// Output-buffer strategies for the printer, against the MEASURED emission profile.
//
// Instrumenting a real bundle: three.core.js emits 169,790 pushes for 376,544 chars — 2.22 chars per
// push, and **75% of pushes are a SINGLE CHARACTER** (punctuation). crashcat is 78%. So the printer is
// overwhelmingly a stream of one-char writes, which is exactly what oxc's `CodeBuffer` targets:
// one preallocated `Vec<u8>` with `print_ascii_byte`, reserved to `source_text.len()` up front.
//
// Ours is `out: string[]` + `push(s)` per token + `join('')` at the end. This measures whether that
// costs anything against the alternatives available in JS.
//
// Every arm must produce the IDENTICAL string — `expectSame` enforces it, because an arm that drops
// or reorders output would otherwise just look fast.
const PUSHES = 169_790;

/** Token stream matching the measured length distribution: 75% len-1, 15% 2-4, 9% 5-16, 1% >16. */
function tokenStream(): string[] {
    const punct = ['{', '}', '(', ')', ',', ';', '=', '.', '[', ']', '+', '*', ':', '?', '!'];
    const short = ['let', 'if', '=>', '==', 'new', 'var', '&&', '||'];
    const mid = ['function', 'return', 'const x', 'typeof', 'undefined', '.length'];
    const long = ['someLongerIdentifierName', '"a string literal here"', 'anotherPrettyLongName'];
    const out: string[] = new Array(PUSHES);
    let seed = 987654321;
    for (let i = 0; i < PUSHES; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const r = seed % 100;
        out[i] =
            r < 75 ? punct[seed % punct.length]
            : r < 90 ? short[seed % short.length]
            : r < 99 ? mid[seed % mid.length]
            : long[seed % long.length];
    }
    return out;
}

let EXPECTED: string | null = null;
function expectSame(s: string): number {
    if (EXPECTED === null) EXPECTED = s;
    else if (s.length !== EXPECTED.length || s !== EXPECTED) throw new Error(`arm produced different output (${s.length} vs ${EXPECTED.length})`);
    return s.length;
}

group('printer output buffer @micro @emit', () => {
    bench('string[] push + join (today)', function* () {
        const toks = tokenStream();
        yield () => {
            const out: string[] = [];
            for (let i = 0; i < toks.length; i++) out.push(toks[i]);
            return expectSame(out.join(''));
        };
    }).gc(true);

    bench('string += (V8 cons/rope)', function* () {
        const toks = tokenStream();
        yield () => {
            let s = '';
            for (let i = 0; i < toks.length; i++) s += toks[i];
            return expectSame(s);
        };
    }).gc(true);

    bench('preallocated Uint8Array + TextDecoder', function* () {
        const toks = tokenStream();
        const dec = new TextDecoder();
        yield () => {
            const buf = new Uint8Array(600_000);
            let n = 0;
            for (let i = 0; i < toks.length; i++) {
                const t = toks[i];
                if (t.length === 1) buf[n++] = t.charCodeAt(0);
                else for (let j = 0; j < t.length; j++) buf[n++] = t.charCodeAt(j);
            }
            return expectSame(dec.decode(buf.subarray(0, n)));
        };
    }).gc(true);

    bench('chunked: accumulate to string, flush at 8KB', function* () {
        const toks = tokenStream();
        yield () => {
            const chunks: string[] = [];
            let cur = '';
            for (let i = 0; i < toks.length; i++) {
                cur += toks[i];
                if (cur.length >= 8192) { chunks.push(cur); cur = ''; }
            }
            if (cur !== '') chunks.push(cur);
            return expectSame(chunks.join(''));
        };
    }).gc(true);
});
