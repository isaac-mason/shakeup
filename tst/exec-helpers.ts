import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    for (const c of chunks) writeFileSync(join(dir, c.fileName), c.code);
    const ns = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
    return { ns, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
};
