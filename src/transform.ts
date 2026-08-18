import { analyze, createSemantic } from './analysis/semantic';
import type { Node } from './ast';
import type { JSXLower } from './jsx-text';
import { collectUnsupported, type JSXOptions, resolveJSXOptions, scanJSX } from './module-graph';
import { parse } from './parser';
import {
    assembleRunner as buildRunnerCode,
    assembleRunnerMapped as buildRunnerMapped,
    createRunnerCtx,
    linkRuntime,
    moduleRunnerPass,
} from './pass/module-runner';
import { runPass } from './pass/traverse';
import { printModule } from './print/print-js';
import { createPrinter, finishPrinter, printerPart } from './print/printer';
import { buildLineTable, type SourceMap } from './sourcemap';

/** Source language; selects TS-strip + JSX-lower behavior. Inferred from the
 *  filename extension when omitted. */
export type TransformLang = 'ts' | 'tsx' | 'js' | 'jsx';

/** HMR-accept metadata, detected statically from `import.meta.hot.accept(...)` so
 *  the dev server learns accept boundaries WITHOUT evaluating. `selfAccepts`: the
 *  module accepts its own updates (`accept()` / `accept(cb)`). `acceptedDeps`:
 *  specifiers from `accept('dep', cb)` / `accept([deps], cb)`. */
export type HmrInfo = { selfAccepts: boolean; acceptedDeps: string[] };

/** `map` is present iff `sourcemap` was set — it maps the runner output back to the
 *  original `source`. */
export type ModuleRunnerResult = {
    code: string;
    deps: string[];
    dynamicDeps: string[];
    errors: string[];
    hmr: HmrInfo;
    map?: SourceMap;
};

const TS_EXT = /\.(ts|mts|cts)$/;
const TSX_EXT = /\.tsx$/;
const JSX_EXT = /\.jsx$/;

function inferLang(filename: string): TransformLang {
    if (TSX_EXT.test(filename)) return 'tsx';
    if (TS_EXT.test(filename)) return 'ts';
    if (JSX_EXT.test(filename)) return 'jsx';
    return 'js';
}

const emptyResult = (errors: string[]): ModuleRunnerResult => ({
    code: '',
    deps: [],
    dynamicDeps: [],
    errors,
    hmr: { selfAccepts: false, acceptedDeps: [] },
});

export type DevTransformOptions = { lang?: TransformLang; jsx?: JSXOptions; sourcemap?: boolean };

/**
 * The dev-path transform (Branch A): ONE parse → analyze → module-runner mutation pass → print.
 * TS-stripping and JSX-lowering are printer concerns (config over the immutable AST); the
 * structural runner rewrite (`import`→`link`, exports→`live`, refs→member) is the AST mutation
 * pass. JSX is not a special case: the pass rewrites component-tag references and the runtime is
 * linked + referenced as member text, so JSX/TSX costs a single parse+pass+print.
 */
export function devTransform(filename: string, source: string, options: DevTransformOptions = {}): ModuleRunnerResult {
    const lang = options.lang ?? inferLang(filename);
    const ts = lang === 'ts' || lang === 'tsx';
    const jsx = lang === 'jsx' || lang === 'tsx';

    const { program, errors: parseErrors } = parse(source, { ts, jsx });
    const errors = parseErrors.map((e) => `${filename}:${e.pos}: ${e.msg}`);
    // Only TS can carry the unsupported node (a value `namespace`); JS/JSX can't, so skip the walk.
    if (ts) collectUnsupported(program, filename, errors);
    if (errors.length > 0) return emptyResult(errors);

    const semantic = createSemantic();
    analyze(semantic, program);
    const scan = jsx ? scanJSX(program) : { hasJSX: false, needsCreateElement: false };

    const ctx = createRunnerCtx(source, semantic);
    runPass(program as Node, moduleRunnerPass, ctx);

    // JSX runtime: linked post-pass; the printer's lowering references it as member text.
    let jsxLower: JSXLower | null = null;
    if (scan.hasJSX) {
        const { importSource } = resolveJSXOptions(options.jsx);
        const rt = linkRuntime(ctx, `${importSource}/jsx-runtime`);
        const ce = scan.needsCreateElement ? linkRuntime(ctx, importSource) : '';
        jsxLower = {
            renameIdent: () => null,
            runtimeName: (k) => (k === 'createElement' ? `${ce}.createElement` : `${rt}.${k}`),
        };
    }

    const wantMap = options.sourcemap ?? false;
    const p = createPrinter(
        { minify: false },
        { jsx: jsxLower, srcLines: wantMap ? Uint32Array.from(buildLineTable(source)) : undefined, sourceIdx: 0 },
    );
    printModule(p, program);

    if (wantMap) {
        const { code, map } = buildRunnerMapped(ctx, filename, printerPart(p));
        return { code, deps: ctx.deps, dynamicDeps: ctx.dynamicDeps, errors, hmr: ctx.hmr, map };
    }
    return { code: buildRunnerCode(ctx, finishPrinter(p)), deps: ctx.deps, dynamicDeps: ctx.dynamicDeps, errors, hmr: ctx.hmr };
}
