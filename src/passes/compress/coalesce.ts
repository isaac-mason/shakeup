// Variable-name coalescing — a port of Closure's `CoalesceVariableNames`
// (llm/closure/src/com/google/javascript/jscomp/CoalesceVariableNames.java).
//
//     let x = 1; print(x); let y = 2; print(y);
//   → let x = 1; print(x); x = 2; print(x);
//
// `x` and `y` have DISJOINT LIVE RANGES, so one variable can serve both. Closure's stated benefits:
// the removed declaration, fewer unique variables (so renaming does better), and better gzip. It
// "operates similar to a typical register allocator": live ranges → interference graph → graph
// colouring.
//
// WHY THIS IS THE ONE WORTH PORTING: it is the only optimisation in the whole compilecat/Closure audit
// that oxc and esbuild BOTH lack. Their manglers colour the SCOPE TREE — `mangle/slots.ts` has an
// explicit "same-scope bindings never share a slot" test, because oxc's model cannot express anything
// finer. Coalescing colours VARIABLE LIVE RANGES, which is flow-sensitive, so two same-scope variables
// that never overlap CAN share. That is strictly beyond what the scope-tree model can reach.
//
// PLACEMENT (Closure's): once, LATE, after the fixed point — not inside it. Closure follows it with a
// peephole cleanup because coalescing "creates identity assignments and more redundant code", and it
// marks the AST un-normalised from that point on. Here it runs after `substituteAlternateSyntax`, which
// has already rewritten `const`→`let`; that matters because a coalesced binding is ASSIGNED after its
// declaration, which `const` forbids.
//
// SCOPE OF THIS INCREMENT — deliberately narrower than Closure's:
//   • locals only; PARAMETERS are excluded entirely (Closure includes them, with a rule that params
//     never share with each other, and the extra bookkeeping is not worth it before the win is proven)
//   • single-declarator `let`/`var` declarations that are DIRECT STATEMENTS (not a `for` init, not a
//     `for-in`/`for-of` left) — anything else changes the declaration's meaning when rewritten
//   • never function or class declaration names (Closure skips both, having measured a SIZE REGRESSION
//     from coalescing function names)
//   • never an escaped/captured local — a closure may read it at any time
import { buildCfg } from '../../analysis/cfg.ts';
import { computeLiveVars } from '../../analysis/live-vars.ts';
import { N, node, type Node, statementListOf, walk } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** Locals declared in `fn`, and those a nested function can observe. Mirrors dead-store's rule. */
function scopeSymbols(fn: Node): { locals: Set<number>; escaped: Set<number> } {
    const locals = new Set<number>();
    const escaped = new Set<number>();
    walk(fn, (n) => {
        if (n !== fn && isFn(n)) {
            walk(n, (c) => {
                if (c.type === N.IdentifierReference || c.type === N.BindingIdentifier) {
                    const s = (c as { sym: number }).sym;
                    if (s > 0) escaped.add(s);
                }
                return undefined;
            });
            return false;
        }
        if (n.type === N.BindingIdentifier) {
            const s = (n as { sym: number }).sym;
            if (s > 0) locals.add(s);
        }
        return undefined;
    });
    return { locals, escaped };
}

/** A coalescing candidate: a symbol plus the declaration statement that introduces it. */
type Candidate = { sym: number; decl: Node; list: Node[]; init: Node | null; name: string };

/**
 * Candidates in SOURCE ORDER. Order matters: Closure adds nodes "in the order in which they appear in
 * the code because we want the names that appear earlier in the code to be used when coalescing".
 */
function collectCandidates(body: Node, tracked: ReadonlySet<number>, params: ReadonlySet<number>): Candidate[] {
    const out: Candidate[] = [];
    walk(body, (n) => {
        if (n !== body && isFn(n)) return false; // a nested function's declarations are its own problem
        const list = statementListOf(n);
        if (list === null) return undefined;
        for (const stmt of list) {
            if (stmt.type !== N.VariableDeclaration) continue;
            const d = stmt.data as { kind: string; declarations: Node[] };
            // `const` cannot be assigned after its declaration, and a multi-declarator statement cannot
            // be split without changing meaning (Closure skips these too — see `isInMultipleLvalueDecl`).
            if (d.kind === 'const' || d.declarations.length !== 1) continue;
            const dec = d.declarations[0].data as { id: Node; init: Node | null };
            if (dec.id.type !== N.BindingIdentifier) continue; // destructuring
            const sym = (dec.id as { sym: number }).sym;
            if (sym === 0 || !tracked.has(sym) || params.has(sym)) continue;
            out.push({ sym, decl: stmt, list: list as Node[], init: dec.init, name: dec.id.name });
        }
        return undefined;
    });
    return out;
}


const coalesceFn = (fn: Node, ctx: TransformCtx): void => {
    const body = (fn.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return;

    const { locals, escaped } = scopeSymbols(fn);
    const tracked = new Set([...locals].filter((s) => !escaped.has(s)));
    if (tracked.size < 2) return;

    const params = new Set<number>();
    for (const p of (fn.data as { params: Node[] }).params ?? [])
        walk(p, (m) => {
            if (m.type === N.BindingIdentifier && (m as { sym: number }).sym > 0) params.add((m as { sym: number }).sym);
            return undefined;
        });

    const cands = collectCandidates(body, tracked, params);
    if (cands.length < 2) return;

    const cfg = buildCfg(body);
    const live = computeLiveVars(cfg, tracked, new Set());
    const W = live.words;

    // Candidate k ↔ its bit index in the lattice.
    const bitOf: number[] = [];
    for (const c of cands) {
        const b = live.index.get(c.sym);
        if (b === undefined) return; // tracked/lattice disagree — bail rather than guess
        bitOf.push(b);
    }

    // ── interference ─────────────────────────────────────────────────────────────────────────────
    // Two variables interfere when their live ranges overlap.
    const nC = cands.length;
    const inter: boolean[] = new Array(nC * nC).fill(false);
    const mark = (a: number, b: number): void => {
        if (a === b) return;
        inter[a * nC + b] = true;
        inter[b * nC + a] = true;
    };

    // Bit index → candidate index (-1 for a tracked symbol that is not a candidate).
    const candOfBit = new Int32Array(live.index.size).fill(-1);
    for (let k = 0; k < nC; k++) candOfBit[bitOf[k]] = k;

    // Closure iterates the SET BITS of each node's live-in and live-out (`nextSetBit`) and marks every
    // pair. That is O(live²) per node. Scanning all candidates instead is O(candidates²) per node, which
    // is the same answer but drastically more work — typically only a handful of variables are live at
    // any point while a function may declare dozens. Measured: switching to set-bit iteration took the
    // pass from +28.8% to +22.2% of build time, i.e. it was ~23% of the cost, not the bulk.
    const livePair = (bits: Uint32Array, base: number, out: number[]): number => {
        let count = 0;
        for (let w = 0; w < W; w++) {
            let word = bits[base + w];
            while (word !== 0) {
                const lsb = word & -word;
                const i = (w << 5) + (31 - Math.clz32(lsb));
                word ^= lsb;
                const c = candOfBit[i];
                if (c >= 0) out[count++] = c;
            }
        }
        return count;
    };

    const bufA: number[] = [];
    const bufB: number[] = [];
    for (let id = 1; id < cfg.value.length; id++) {
        const base = id * W;
        const nIn = livePair(live.inBits, base, bufA);
        for (let i = 0; i < nIn; i++) for (let j = i + 1; j < nIn; j++) mark(bufA[i], bufA[j]);

        const nOut = livePair(live.outBits, base, bufB);
        for (let i = 0; i < nOut; i++) for (let j = i + 1; j < nOut; j++) mark(bufB[i], bufB[j]);

        // A variable DEFINED here overlaps everything live across this node — the "crossing" case
        // Closure recovers with `LiveRangeChecker`, which live-in/live-out pairs alone would miss.
        const killed: number[] = [];
        const nKill = livePair(live.killBits, base, killed);
        for (let i = 0; i < nKill; i++) for (let j = 0; j < nOut; j++) mark(killed[i], bufB[j]);
    }

    // ── greedy colouring, in source order ────────────────────────────────────────────────────────
    const colour: number[] = new Array(nC).fill(-1);
    let colours = 0;
    for (let i = 0; i < nC; i++) {
        const used = new Set<number>();
        for (let j = 0; j < nC; j++) if (j !== i && colour[j] >= 0 && inter[i * nC + j]) used.add(colour[j]);
        let c = 0;
        while (used.has(c)) c++;
        colour[i] = c;
        if (c + 1 > colours) colours = c + 1;
    }
    if (colours === nC) return; // nothing shares — every candidate needs its own name

    // The first candidate of each colour (source order) is the survivor; the rest merge into it.
    const survivor: number[] = new Array(colours).fill(-1);
    for (let i = 0; i < nC; i++) if (survivor[colour[i]] < 0) survivor[colour[i]] = i;

    const rename = new Map<number, Candidate>(); // merged symbol → the candidate it becomes
    for (let i = 0; i < nC; i++) {
        const s = survivor[colour[i]];
        if (s !== i) rename.set(cands[i].sym, cands[s]);
    }
    if (rename.size === 0) return;

    // ── rewrite ──────────────────────────────────────────────────────────────────────────────────
    // Every reference to a merged symbol becomes the survivor's name+symbol.
    walk(body, (n) => {
        if (n !== body && isFn(n)) return false;
        if (n.type === N.IdentifierReference || n.type === N.BindingIdentifier) {
            const t = rename.get((n as { sym: number }).sym);
            if (t !== undefined) {
                (n as { name: string }).name = t.name;
                (n as { sym: number }).sym = t.sym;
            }
        }
        return undefined;
    });

    // The merged declarations are no longer declarations: an initialised one becomes a plain
    // assignment to the survivor, an uninitialised one disappears. (This is the step Closure warns
    // "creates identity assignments and more redundant code"; a following cleanup pass removes them.)
    for (let i = 0; i < nC; i++) {
        const c = cands[i];
        if (!rename.has(c.sym) && survivor[colour[i]] === i) continue;
        const t = rename.get(c.sym);
        if (t === undefined) continue;
        const idx = c.list.indexOf(c.decl);
        if (idx < 0) continue;
        // `let y = x;` where y coalesces into x becomes `x = x` — a no-op. It CAN arise: at y's
        // declaration x is live-in and y is live-out, and this pass compares live-in pairs and live-out
        // pairs separately, so the two need not interfere. Dropping it here is why no cleanup traversal
        // is needed. (Closure instead re-runs peephole passes afterwards, which costs a whole extra
        // walk of the program — measured at more than half this pass's total cost.)
        const selfAssign =
            c.init !== null && c.init.type === N.IdentifierReference && (c.init as { sym: number }).sym === t.sym;
        if (c.init === null || selfAssign) {
            c.list.splice(idx, 1);
        } else {
            const ref = node(N.IdentifierReference, c.decl.start, c.decl.start, t.name, null);
            (ref as { sym: number }).sym = t.sym;
            c.list[idx] = create.ExpressionStatement(
                c.decl.start,
                c.decl.end,
                0,
                create.AssignmentExpression(c.decl.start, c.decl.end, '=', ref, c.init),
            );
        }
    }
    ctx.changed = true;
};

export const coalesceVariableNames: Visitor = {
    name: 'coalesceVariableNames',
    enter: hookTable({
        [N.FunctionDeclaration]: coalesceFn,
        [N.FunctionExpression]: coalesceFn,
        [N.ArrowFunctionExpression]: coalesceFn,
    }),
    exit: null,
};
