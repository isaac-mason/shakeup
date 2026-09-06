import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parse } from '../src/parser/index.ts';

/** Helpers for tests that EXECUTE bundled output and compare the results of two builds. */

/** Import a bundle's code as a module and hand back its exports. */
export const runModule = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

/**
 * Exported values, with functions reduced to an arity token.
 *
 * Two things about exported FUNCTIONS legitimately differ between two builds and say nothing about
 * behaviour: object identity (each build is a separate module instance, so the functions are never
 * `===`) and `.name` (mangled in a minified build). Comparing raw namespaces therefore fails for
 * reasons unrelated to the transform under test — unless the two builds happen to be byte-identical,
 * in which case Node returns the SAME cached module and the comparison passes trivially. Normalising
 * removes both traps.
 */
export const exportShape = (m: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'function' ? `[fn/${v.length}]` : v]));

/**
 * Write a MULTI-CHUNK build to a real directory and import its entry through Node's own ESM loader.
 *
 * `runModule` cannot do this: a `data:` URL has no base, so a chunk's relative `import './dep-x.js'`
 * does not resolve. That limitation is why the suite text-inspected split output instead of running
 * it — and why four cross-chunk CommonJS failures (a namespace binding never wired across a
 * boundary, so the consumer chunk referenced an undeclared local) sat undetected behind tests that
 * were passing. Text assertions cannot see a dangling reference.
 *
 * Returns the entry's exports. Caller cleans up via the returned `dispose`, or leaves it to the OS.
 */
export const runChunks = async (
    chunks: readonly { fileName: string; code: string }[],
    entry = 'main.js',
): Promise<{ ns: Record<string, unknown>; dir: string; dispose: () => void }> => {
    const dir = mkdtempSync(join(tmpdir(), 'shakeup-chunks-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    // Strip the `sourceMappingURL` comment: the map ASSETS are not written here (only chunks are),
    // so leaving it makes Node's loader — and vitest's — chase a file that is not there and log a
    // read error that has nothing to do with the test. Assertions read `r.code`, not the file.
    for (const c of chunks) writeFileSync(join(dir, c.fileName), c.code.replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
    // EVERY chunk must be a valid module, checked before it is run — see `chunkCheckErrors`. Running
    // does not establish it: under vitest a chunk exporting a name nothing declares loads fine.
    const bad = chunkCheckErrors(chunks);
    if (bad.length > 0) throw new Error(`emitted chunk is not a valid module:\n  ${bad.join('\n  ')}`);
    const ns = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
    return { ns, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * Every emitted chunk, re-parsed and run through shakeup's OWN checker as a module.
 *
 * The failure this exists for is a DANGLING EXPORT — `export { x }` where nothing declares `x`,
 * which is what a cross-chunk binding that was referenced but never wired produces. Node refuses
 * such a module outright (`SyntaxError: Export 'x' is not defined in module`), so it looks like
 * {@link runChunks} would catch it. **It does not, under vitest.** vitest imports through its own
 * module runner, which rewrites ESM into an SSR form where exports are lazy properties — an
 * undeclared one throws only if something READS it, and a consumer that merely imports the name
 * never does. Verified by sabotage: removing the member wiring made all six cross-chunk fixtures
 * throw under plain `tsx` while the same fixtures stayed green under vitest.
 *
 * The checker sees it without executing anything: `Export 'X' is not defined` is already one of its
 * rules (`semantic.ts`), for the same reason oxc reports it and rolldown fails the build on it.
 */
export const chunkCheckErrors = (chunks: readonly { fileName: string; code: string }[]): string[] => {
    const out: string[] = [];
    for (const c of chunks) {
        const { program, errors } = parse(c.code, { ts: false, jsx: false });
        for (const e of errors) out.push(`${c.fileName}: parse: ${e.msg}`);
        const sem = createSemantic();
        analyze(sem, program, true, true);
        for (const e of sem.errors) out.push(`${c.fileName}: ${e.msg}`);
    }
    return out;
};
