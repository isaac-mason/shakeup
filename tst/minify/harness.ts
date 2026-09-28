// Port of oxc_minifier/tests/mod.rs: `test(source, expected)` compresses `source` in full mode and
// compares it with `expected` printed as it is, then compresses the result again to check it is stable.
import { expect } from 'vitest';
import { resolveNoSideEffects } from '../../src/analysis/purity.ts';
import { analyze, createSemantic } from '../../src/analysis/semantic.ts';
import { type Node, parse } from '../../src/ast.ts';
import { buildWithScoping } from '../../src/passes/minifier/compressor.ts';
import { type CompressOptions, type CompressTargets, smallestOptions } from '../../src/passes/minifier/options.ts';
import { printModule } from '../../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../../src/print/printer.ts';

/** oxc `default_options()`: `smallest()` keeping `debugger` and unused code. */
export function defaultOptions(): CompressOptions {
    return { ...smallestOptions(), dropDebugger: false, unused: 'keep' };
}

const featureYear = (feature: string): number => Number(/^ES(\d{4})/.exec(feature)?.[1] ?? 0);

/** `EngineTargets::from_target("esNNNN")`. */
export function esTargets(year: number): CompressTargets {
    return {
        hasFeature: (feature) => featureYear(feature) > year,
        supportsEsFeature: (feature) => featureYear(feature) <= year,
    };
}

function print(program: Node): string {
    const printer = createPrinter({ minify: false });
    printModule(printer, program);
    return finishPrinter(printer);
}

/** oxc `SourceType`: `mjs()`, `script()`, `cjs()`, `ts()` (a TypeScript module) or `ts().with_script(true)`. */
export type TestSourceType = 'module' | 'script' | 'commonjs' | 'typescript' | 'typescript-script';

/** oxc `run`: parse (top-level `return` allowed), compress when `options` is given, print. */
export const run = (source: string, options: CompressOptions | null, sourceType: TestSourceType = 'module'): string =>
    runWithIterations(source, options, sourceType).code;

/** oxc `run_with_iterations`: `run`, also returning the compressor's iteration count (0 when not compressed). */
export function runWithIterations(
    source: string,
    options: CompressOptions | null,
    sourceType: TestSourceType = 'module',
): { code: string; iterations: number } {
    const kind = sourceType === 'typescript' ? 'module' : sourceType === 'typescript-script' ? 'script' : sourceType;
    const { program, errors, noSideEffectsAt } = parse(source, {
        ts: sourceType === 'typescript' || sourceType === 'typescript-script',
        jsx: false,
        kind,
        allowReturnOutsideFunction: true,
    });
    if (errors !== undefined && errors.length > 0) throw new Error(`does not parse: ${source}\n${errors.join('\n')}`);
    let iterations = 0;
    if (options !== null) {
        const semantic = createSemantic();
        analyze(semantic, program, kind === 'module');
        const noSideEffects = resolveNoSideEffects(program, noSideEffectsAt);
        iterations = buildWithScoping(program, semantic, options, kind, noSideEffects, true).iterations;
    }
    return { code: print(program), iterations };
}

export function testOptions(
    source: string,
    expected: string,
    options: CompressOptions,
    sourceType: TestSourceType = 'module',
): void {
    const first = run(source, options, sourceType);
    expect(first, `for source\n${source}`).toBe(run(expected, null, sourceType));
    expect(run(first, options, sourceType), `idempotency for source\n${source}`).toBe(first);
}

/** oxc `test_options_with_iterations`: output, iteration count, and the idempotency check. */
export function testOptionsWithIterations(
    source: string,
    expected: string,
    expectedIterations: number,
    options: CompressOptions,
): void {
    const first = runWithIterations(source, options);
    expect(first.code, `for source\n${source}`).toBe(run(expected, null));
    expect(first.iterations, `iteration count for source\n${source}`).toBe(expectedIterations);
    expect(run(first.code, options), `idempotency for source\n${source}`).toBe(first.code);
}

/** oxc `test_options_once_with_iterations`: one capped run, without the idempotency check. */
export function testOptionsOnceWithIterations(
    source: string,
    expected: string,
    expectedIterations: number,
    options: CompressOptions,
): void {
    const actual = runWithIterations(source, options);
    expect(actual.code, `for source\n${source}`).toBe(run(expected, null));
    expect(actual.iterations, `iteration count for source\n${source}`).toBe(expectedIterations);
}

export const test = (source: string, expected: string): void => testOptions(source, expected, defaultOptions());

export const testSame = (source: string): void => test(source, source);

export const testSmallest = (source: string, expected: string): void => testOptions(source, expected, smallestOptions());

export const testSameSmallest = (source: string): void => testSmallest(source, source);

export const testSameOptions = (source: string, options: CompressOptions): void => testOptions(source, source, options);

export const testTarget = (source: string, expected: string, year: number): void =>
    testOptions(source, expected, { ...defaultOptions(), target: esTargets(year) });
