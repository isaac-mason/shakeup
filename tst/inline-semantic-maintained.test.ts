import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { setVerifyExtras, verifySemantic } from '../src/analysis/ref-facts.ts';
import { parseProgram } from '../src/parser/index.ts';
import { runCompress } from '../src/passes/compress/index.ts';
import { inlineFunctions } from '../src/passes/optimize/inline-functions.ts';

// `inlineFunctions` MAINTAINS the semantic rather than rebuilding it, so every splice has to leave
// the symbol table agreeing with the tree. scan.ts checks this on a whole bundle under
// SEMANTIC_VERIFY; these pin the individual splice shapes that can break it, which is where a
// corpus-level failure is impossible to localise from.
setVerifyExtras(true);

/** Inline `src`, then ask whether the maintained semantic still matches the tree. */
function problemsAfterInlining(src: string): string[] {
    const program = parseProgram(src, { ts: false, jsx: false }) as never;
    const semantic = createSemantic();
    analyze(semantic, program);
    inlineFunctions(program, semantic, src);
    return verifySemantic(semantic, program);
}

/** The real per-module order: the optimize tier, then the compress fixed point. A splice can leave
 *  the semantic self-consistent yet carry state compress then resolves differently, which only
 *  shows up once both have run. */
function problemsAfterInliningAndCompress(src: string): string[] {
    const program = parseProgram(src, { ts: false, jsx: false }) as never;
    let semantic = createSemantic();
    analyze(semantic, program);
    inlineFunctions(program, semantic, src);
    const refreshed = runCompress(program, semantic, 'full');
    if (refreshed !== null) semantic = refreshed;
    return verifySemantic(semantic, program);
}

const cases: Record<string, string> = {
    'simple flatten': `
function addTo(out, a, b) { out[0] = a[0] + b[0]; }
/* @flatten */
export function caller(out, a, b) { addTo(out, a, b); }`,

    // the shape that broke first: two bindings of one name in SIBLING scopes
    'donor binds one name in sibling scopes': `
function alloc(pool) {
    if (pool.free.length > 0) { const n = pool.free.pop(); return n; }
    const n = pool.size;
    return n;
}
/* @flatten */
export function caller(pool) { return alloc(pool); }`,

    'donor contains a loop': `
function sum(out, xs) { let t = 0; for (let i = 0; i < xs.length; i++) t += xs[i]; out[0] = t; }
/* @flatten */
export function caller(out, xs) { sum(out, xs); }`,

    'donor contains a catch': `
function guard(out, f) { try { out[0] = f(); } catch (e) { out[0] = e; } }
/* @flatten */
export function caller(out, f) { guard(out, f); }`,

    'same donor inlined twice in one body': `
function addTo(out, a, b) { const t = a[0] + b[0]; out[0] = t; }
/* @flatten */
export function caller(out, a, b) { addTo(out, a, b); addTo(out, b, a); }`,

    // the suspected flatten bug: a splice introduces calls that are then spliced again
    'transitive - donor calls another donor': `
function inner(out, v) { out[0] = v[0] * 2; }
function outer(out, v) { inner(out, v); out[1] = out[0]; }
/* @flatten */
export function caller(out, v) { outer(out, v); }`,

    'transitive three deep': `
function a3(o, v) { o[0] = v[0]; }
function a2(o, v) { a3(o, v); o[1] = o[0]; }
function a1(o, v) { a2(o, v); o[2] = o[1]; }
/* @flatten */
export function caller(o, v) { a1(o, v); }`,

    // the dbvt shape: caller and donor each bind the same local name, and the splice nests one
    // inside the other
    'donor local collides with a caller local': `
function mark(dbvt, n) { const topo = dbvt.topo; topo[n] = 1; }
/* @flatten */
export function caller(dbvt, n) { const topo = dbvt.topo; mark(dbvt, n); topo[n] = 2; }`,

    'donor local collides, donor inlined twice': `
function mark(dbvt, n) { const topo = dbvt.topo; topo[n] = 1; }
/* @flatten */
export function caller(dbvt, a, b) { const topo = dbvt.topo; mark(dbvt, a); mark(dbvt, b); topo[a] = 2; }`,

    'two donors sharing a local name, both inlined': `
function markA(dbvt, n) { const topo = dbvt.topo; topo[n] = 1; }
function markB(dbvt, n) { const topo = dbvt.topo; topo[n] = 2; }
/* @flatten */
export function caller(dbvt, n) { markA(dbvt, n); markB(dbvt, n); }`,

    'argument names collide with donor params': `
function addTo(out, a, b) { out[0] = a[0] + b[0]; }
/* @flatten */
export function caller(out, a, b) { addTo(out, a, b); }`,
};

describe('inlineFunctions maintains the semantic', () => {
    for (const [name, src] of Object.entries(cases)) {
        it(name, () => {
            expect(problemsAfterInlining(src)).toEqual([]);
        });
    }
});

describe('the semantic survives inlining followed by compress', () => {
    for (const [name, src] of Object.entries(cases)) {
        it(name, () => {
            expect(problemsAfterInliningAndCompress(src)).toEqual([]);
        });
    }
});
