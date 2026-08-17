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
