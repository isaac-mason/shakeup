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
