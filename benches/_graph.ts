import type { Fs } from '../src/fs';

export type SyntheticGraph = {
    files: Record<string, string>;
    fs: Fs;
    opts: () => { entry: string; fs: Fs; external: string[] };
    /** Body-only edit to module `i` (changes its source hash without touching its export surface). */
    editBody: (i: number, v: number) => void;
};

/** An in-memory module graph of `N` TS modules, each importing the next few and carrying enough
 *  type/JSX-free syntax (functions, interfaces, arrays) to exercise parse, link, tree-shake,
 *  chunk and render without any disk or plugin involvement. Deterministic. */
export function makeGraph(N: number): SyntheticGraph {
    const files: Record<string, string> = {};
    for (let i = 0; i < N; i++) {
        const deps = [i + 1, i + 2, i + 3].filter((d) => d < N);
        const imports = deps.map((d) => `import { e${d} } from './m${d}';`).join('\n');
        const uses = deps.map((d) => `e${d}`).join(' + ') || '0';
        files[`/m${i}.ts`] = `${imports}
export const e${i} = ${uses} + ${i};
let tweak${i} = 1;
const local${i} = () => e${i} * tweak${i};
export function use${i}(x: number): number { return local${i}() + x; }
export const arr${i} = [1, 2, 3, 4, 5].map((n) => n + ${i});
export interface Shape${i} { a: number; b: string }
`;
    }
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const opts = () => ({ entry: '/m0.ts', fs, external: [] as string[] });
    const editBody = (i: number, v: number): void => {
        files[`/m${i}.ts`] = files[`/m${i}.ts`].replace(/let tweak\d+ = \d+;/, `let tweak${i} = ${2 + v};`);
    };
    return { files, fs, opts, editBody };
}

/** ONE module whose function bodies hold LONG statement lists (`stmts` statements each, in `fns`
 *  functions), built from single-use `const` bindings so the statement-list passes have real work.
 *
 *  `makeGraph` deliberately models module-graph WIDTH — 100-600 modules of ~7 statements each — so it
 *  cannot see any cost that is superlinear in STATEMENT-LIST LENGTH. A quadratic in `inline` that CPU
 *  profiling put at ~17% of the compress tier on three.core.js was completely invisible to it: at
 *  n=7, n^2 is nothing. Real modules have function bodies hundreds of statements long, so this is the
 *  shape that catches that class, and it stays deterministic and in-memory like the rest. */
export function makeDeepModule(fns: number, stmts: number): SyntheticGraph {
    const files: Record<string, string> = {};
    const body = (f: number): string => {
        const lines: string[] = [`export function f${f}(seed: number): number {`, `  let acc = seed;`];
        // (a) single-use consts consumed by the NEXT statement — the ADJACENT shape, which is what
        //     `inline` actually fires on (measured: 119/119 real substitutions were adjacent).
        for (let i = 0; i < stmts; i++) {
            lines.push(`  const t${i} = acc + ${i};`);
            lines.push(`  acc = t${i} * 2 - ${i};`);
        }
        // (b) intermediates whose single use is FAR AWAY, all combined in the final expression, so the
        //     list also covers the non-adjacent case rather than only the best case for a
        //     forward-scanning implementation.
        //
        //     HONEST LIMIT, measured, so nobody reads more into this bench than it earns: it does NOT
        //     reproduce the O(statements x subtree) `inline` quadratic that CPU profiling found at ~17%
        //     of the compress tier on three.core.js. A/B-ing the fix across this bench moved nothing
        //     (|Cliff's d| <= 0.25 at both sizes). The reason is the SUBTREE half of that product: the
        //     statements crossed here are `const uN = acc * K`, four nodes each, so the scan is
        //     quadratic with a trivial constant. Real code crosses whole function bodies. Catching
        //     that class needs a large REAL module, which the in-memory-only rule here excludes.
        const far: string[] = [];
        for (let i = 0; i < stmts; i++) {
            lines.push(`  const u${i} = acc * ${i + 1};`);
            far.push(`u${i}`);
        }
        lines.push(`  return acc + ${far.join(' + ')};`, '}');
        return lines.join('\n');
    };
    const fnSrc: string[] = [];
    for (let f = 0; f < fns; f++) fnSrc.push(body(f));
    files['/deep.ts'] = fnSrc.join('\n');
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const opts = () => ({ entry: '/deep.ts', fs, external: [] as string[] });
    const editBody = (): void => {};
    return { files, fs, opts, editBody };
}
