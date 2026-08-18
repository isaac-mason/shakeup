import { describe, expect, it } from 'vitest';
import { analyze, createSemantic, moduleRunnerTransform, type Node, parse } from '../src/index.ts';
import { assembleRunner, createRunnerCtx, moduleRunnerPass, type RunnerCtx } from '../src/pass/module-runner.ts';
import { runPass } from '../src/pass/traverse.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';
import { astEqual } from './print-helpers.ts';

function passLower(src: string): { code: string; ctx: RunnerCtx } {
    const { program } = parse(src, { ts: false, jsx: false });
    const semantic = createSemantic();
    analyze(semantic, program);
    const ctx = createRunnerCtx(src, semantic);
    runPass(program as Node, moduleRunnerPass, ctx);
    const p = createPrinter({ minify: false });
    printModule(p, program);
    return { code: assembleRunner(ctx, finishPrinter(p)), ctx };
}

// Every construct the edit-based moduleRunnerTransform handles; the pass must produce the same
// statements (astEqual after reparse) and the same deps/dynamicDeps/hmr side outputs.
const CASES = [
    // imports + refs
    'import { a } from "./m";\nconsole.log(a);\n',
    'import a from "./m";\na();\n',
    'import * as ns from "./m";\nns.x(ns.y);\n',
    'import { a as b } from "./m";\nconst z = b + 1;\n',
    'import { "weird-name" as w } from "./m";\nw();\n',
    'import x from "./m";\nconst o = { x };\n',
    'import { tag } from "./m";\nconst t = tag`hi ${1}`;\n',
    'import "./side-effect.js";\nrun();\n',
    // exports — declarations
    'export const a = 1, b = 2;\n',
    'export function f() { return 1; }\n',
    'export class C {}\n',
    'export const { x, y: [z] } = obj;\n',
    // exports — specifiers / re-export / star
    'const a = 1, b = 2;\nexport { a, b as c };\n',
    'import { a } from "./m";\nexport { a };\n',
    'export { x, y as "z-z" } from "./dep";\n',
    'export * from "./dep";\n',
    'export * as ns from "./dep";\n',
    // export default forms
    'export default function () { return 1; }\n',
    'export default function named() {}\n',
    'export default class {}\n',
    'export default 42;\n',
    'import { a } from "./m";\nexport default a;\n',
    // HMR
    'import.meta.hot.accept();\n',
    'import.meta.hot.accept((m) => {});\n',
    'import.meta.hot.accept("./dep", (m) => {});\n',
    'import.meta.hot.accept(["./a", "./b"], (m) => {});\n',
    'import.meta.hot.acceptExports(["x"]);\n',
    // mixed
    'import { a } from "./a";\nimport { b } from "./b";\nexport const u = a(b);\nconst d = import("./d");\n',
];

describe('module-runner pass — full parity vs edit engine', () => {
    for (const src of CASES) {
        it(`matches moduleRunnerTransform: ${JSON.stringify(src)}`, () => {
            const mine = passLower(src);
            const edit = moduleRunnerTransform('/m.js', src);
            const a = parse(mine.code, { ts: false, jsx: false });
            const b = parse(edit.code, { ts: false, jsx: false });
            expect(a.errors).toEqual([]);
            expect(b.errors).toEqual([]);
            expect(astEqual(a.program, b.program)).toBe(true);
            expect(mine.ctx.deps).toEqual(edit.deps);
            expect(mine.ctx.dynamicDeps).toEqual(edit.dynamicDeps);
            expect(mine.ctx.hmr).toEqual(edit.hmr);
        });
    }
});
