import { bench, group } from '@pmndrs/labs';
import { parse } from '../../src/parser';

/** A single large TS module: `n` declarations mixing types, generics, functions and expressions —
 *  the parser's steady-state workload (type-stripping needs the full type grammar parsed). */
function bigTs(n: number): string {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        out.push(`interface Shape${i}<T> { id: number; value: T; next?: Shape${i}<T>; }`);
        out.push(`type Unwrap${i}<T> = T extends Promise<infer U> ? U : T extends Array<infer E> ? E : T;`);
        out.push(`const fn${i} = <A, B>(a: A, b: B): [A, B] => [a, b];`);
        out.push(`export function calc${i}(x: number, y: number = ${i}): number { const z = x * y + ${i}; return z > 0 ? z : -z; }`);
        out.push(`export const data${i} = [1, 2, 3].map((k) => ({ k, sq: k * k, label: \`item-\${k}-${i}\` }));`);
    }
    return out.join('\n');
}

group('parse @parse', () => {
    for (const n of [200, 1000]) {
        bench(`parse+analyze ~${n * 5} decls TS`, function* () {
            const src = bigTs(n);
            yield () => {
                parse(src, { ts: true, jsx: false });
            };
        });
    }
});
