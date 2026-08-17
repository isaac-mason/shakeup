import type { Plugin } from '../plugin';

/** Virtual-id prefix for a resolved `?url` asset. The `load` hook serves these as a JS module whose
 *  default export is the asset's URL, so the `.png`/`.svg`/… in the tail never reaches the fs or a
 *  parser. */
const PREFIX = '\0asset-url:';

export type AssetOptions = {
    /** Map a resolved asset path to a runtime URL. Provide in DEV — the host serves the file (e.g. a
     *  service worker over the project vfs), so a `?url` import becomes that URL with no emission.
     *  Omit in a bundle build: the bytes are read + emitted via `ctx.emitFile` and the import
     *  resolves to the emitted fileName instead. */
    url?: (path: string) => string;
};

/** `import u from './logo.png?url'` → a module whose default export is a URL for the asset.
 *
 *  This is the web-semantics half a Rollup/Vite-shaped core leaves to a plugin: core classifies JS
 *  edges, the host supplies policy (the `url()` mapper / the emit sink). DEV maps the vfs path to a
 *  served URL; BUILD emits the bytes and exports the emitted fileName. */
export function asset(options: AssetOptions = {}): Plugin {
    return {
        name: 'asset',
        // Strip the `?url` query, resolve the base to a real id, tag it. `[?&]url(&|$)` matches
        // `?url`, `?url&v=1`, `?foo&url` — but not `?foo=url`.
        resolveId: {
            filter: { id: /[?&]url(&|$)/ },
            handler: async (ctx, spec, importer) => {
                const base = spec.slice(0, spec.indexOf('?'));
                const resolved = await ctx.resolve(base, importer);
                return PREFIX + (resolved?.id ?? base);
            },
        },
        load: {
            filter: { id: /^\0asset-url:/ },
            handler: async (ctx, id) => {
                const path = id.slice(PREFIX.length);
                // moduleType 'js' forces JS handling despite the asset extension in the id tail.
                if (options.url !== undefined) {
                    return { code: `export default ${JSON.stringify(options.url(path))};`, moduleType: 'js' };
                }
                const source = await ctx.fs.read(path);
                if (source === null) return ctx.error(`asset not found: ${path}`);
                const fileName = ctx.emitFile({ type: 'asset', name: baseName(path), source });
                return { code: `export default ${JSON.stringify(fileName)};`, moduleType: 'js' };
            },
        },
    };
}

function baseName(p: string): string {
    const slash = p.lastIndexOf('/');
    return slash === -1 ? p : p.slice(slash + 1);
}
