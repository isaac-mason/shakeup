// Arms for `list-helper.paired.ts`: does extracting shakeup's ~20 hand-written delimited-list loops
// into ONE shared helper cost anything?
//
// oxc has exactly one `parse_delimited_list_into` (`cursor.rs:486`) shared by 17 call sites, which is
// why its recovery-loop bug class cannot exist. Porting that shape to JS means the element parser
// becomes a CALLBACK. Rust monomorphises `F: FnMut` per call site — free. JS does not, and this
// repo's own log says "reshape the same work" changes usually wash or regress, so the question has to
// be measured before any src edit.
//
// The arms parse a synthetic token stream, not real source: the question is purely loop shape +
// call overhead, and using the real parser would bury it under lexing and node allocation.

/** A token stream: 0 = element, 1 = separator, 2 = closer. Mimics `a, b, c )` repeated. */
const N = 40_000;
const TOKENS = new Uint8Array(N);
for (let i = 0; i < N; i++) TOKENS[i] = i % 8 === 7 ? 2 : i % 2 === 0 ? 0 : 1;

type Node = { id: number; v: number };
let counter = 0;
/** Stand-in for `create.X(...)` — one allocation, same shape every time. */
const mk = (v: number): Node => ({ id: ++counter, v });

/** A — today's shape: the loop is written inline at the call site. */
export function inlineLoop(): number {
    let total = 0;
    for (let start = 0; start < N; start += 8) {
        const out: Node[] = [];
        let p = start;
        while (p < N && TOKENS[p] !== 2) {
            out.push(mk(p));
            p++;
            if (p < N && TOKENS[p] === 1) p++;
        }
        total += out.length;
    }
    return total;
}

/** A' — byte-identical copy of A. NEGATIVE CONTROL. */
export function inlineLoop2(): number {
    let total = 0;
    for (let start = 0; start < N; start += 8) {
        const out: Node[] = [];
        let p = start;
        while (p < N && TOKENS[p] !== 2) {
            out.push(mk(p));
            p++;
            if (p < N && TOKENS[p] === 1) p++;
        }
        total += out.length;
    }
    return total;
}

/** B — oxc's shape: one shared helper taking the element parser as a callback. */
function parseDelimited(from: number, parseElement: (p: number) => Node, out: Node[]): number {
    let p = from;
    while (p < N && TOKENS[p] !== 2) {
        out.push(parseElement(p));
        p++;
        if (p < N && TOKENS[p] === 1) p++;
    }
    return p;
}
export function sharedHelper(): number {
    let total = 0;
    for (let start = 0; start < N; start += 8) {
        const out: Node[] = [];
        parseDelimited(start, mk, out);
        total += out.length;
    }
    return total;
}

/** C — shared helper, but the callback is a FRESH closure per call, which is what a real call site
 *  needs (it captures parser state). This is the honest port, not B. */
export function sharedHelperClosure(): number {
    let total = 0;
    for (let start = 0; start < N; start += 8) {
        const out: Node[] = [];
        const el = (p: number): Node => mk(p + 0);
        parseDelimited(start, el, out);
        total += out.length;
    }
    return total;
}

/** D — the REALISTIC port: one shared helper called from many sites, each passing a DIFFERENT
 *  module-level element parser. Arm B has a single callee, so V8 keeps that call site monomorphic and
 *  inlines it — an outcome no real port gets. With ~20 distinct element parsers the call site inside
 *  the helper goes megamorphic, which is the property that actually decides this. */
const mkA = (v: number): Node => ({ id: ++counter, v });
const mkB = (v: number): Node => ({ id: ++counter, v: v + 1 });
const mkC = (v: number): Node => ({ id: ++counter, v: v + 2 });
const mkD = (v: number): Node => ({ id: ++counter, v: v + 3 });
const mkE = (v: number): Node => ({ id: ++counter, v: v + 4 });
const mkF = (v: number): Node => ({ id: ++counter, v: v + 5 });
const ELEMENT_PARSERS = [mkA, mkB, mkC, mkD, mkE, mkF];

export function sharedHelperMegamorphic(): number {
    let total = 0;
    let k = 0;
    for (let start = 0; start < N; start += 8) {
        const out: Node[] = [];
        // Rotate which element parser this call site uses, as ~20 real call sites would.
        parseDelimited(start, ELEMENT_PARSERS[k++ % ELEMENT_PARSERS.length], out);
        total += out.length;
    }
    return total;
}
