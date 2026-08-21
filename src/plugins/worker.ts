import { bundle } from '../bundle';
import type { JSXOptions } from '../resolve';
import type { Plugin } from '../plugin';

/** Virtual-id prefixes for a resolved `?worker` entry — inline (blob) vs chunk (emitted file). */
const INLINE_PREFIX = '\0worker-inline:';
const CHUNK_PREFIX = '\0worker-chunk:';

export type WorkerOptions = {
    /** Transform plugins for the worker's OWN graph — normally the same set as the main build
     *  (capture / asset / css), MINUS this worker plugin (a worker importing a worker would
     *  otherwise recurse). Defaults to none. */
    plugins?: Plugin[];
    jsx?: JSXOptions;
};

/** `import W from './render.worker.ts?worker'` → a module whose default export constructs a Worker.
 *
 *  The worker runs in its own thread with no dev-server runner, so its graph is bundled into ONE
 *  self-contained ESM chunk (via shakeup's OWN `bundle()` with `inlineDynamicImports` — no rolldown).
 *  `?worker&inline` blobs that code into the module (Vite's `?worker&inline`); a plain `?worker`
 *  emits it as a separate chunk and `new Worker`s its URL. Inline-vs-chunk is decided per import by
 *  the query, not a plugin option — matching Vite. */
export function worker(options: WorkerOptions = {}): Plugin {
    // resolved virtual id → wrapper module. The nested bundle is expensive; cache it (a worker's
    // graph is usually immutable seed/engine code — HMR of worker source is not invalidated here).
    const cache = new Map<string, string>();
    return {
        name: 'worker',
        resolveId: {
            filter: { id: /[?&]worker(&|$)/ },
            handler: async (ctx, spec, importer) => {
                const q = spec.indexOf('?');
                const inline = /[?&]inline(&|$)/.test(spec.slice(q));
                const resolved = await ctx.resolve(spec.slice(0, q), importer);
                return (inline ? INLINE_PREFIX : CHUNK_PREFIX) + (resolved?.id ?? spec.slice(0, q));
            },
        },
        load: {
            filter: { id: /^\0worker-(inline|chunk):/ },
            handler: async (ctx, id) => {
                const hit = cache.get(id);
                if (hit !== undefined) return { code: hit, moduleType: 'js' };
                const inline = id.startsWith(INLINE_PREFIX);
                const path = id.slice((inline ? INLINE_PREFIX : CHUNK_PREFIX).length);

                const result = await bundle({
                    input: path,
                    fs: ctx.fs,
                    plugins: options.plugins ?? [],
                    jsx: options.jsx,
                    external: (s) => s.startsWith('node:'),
                    output: { inlineDynamicImports: true },
                });
                if (result.errors.length > 0) {
                    return ctx.error(`worker bundle failed for ${path}:\n${result.errors.join('\n')}`);
                }

                let wrapper: string;
                if (inline) {
                    wrapper = inlineWrapperModule(result.code);
                } else {
                    // Emit a sibling chunk + `new Worker(new URL(fileName, import.meta.url))`. The dev
                    // server has no output sink (emitFile throws), so fall back to an inline blob.
                    try {
                        const fileName = ctx.emitFile({ type: 'asset', name: workerName(path), source: result.code });
                        wrapper = urlWrapperModule(fileName);
                    } catch {
                        wrapper = inlineWrapperModule(result.code);
                    }
                }
                cache.set(id, wrapper);
                return { code: wrapper, moduleType: 'js' };
            },
        },
    };
}

/** `<stem>.js` — the emitted worker chunk keeps its base name with a `.js` extension. */
function workerName(path: string): string {
    const slash = path.lastIndexOf('/');
    const base = slash === -1 ? path : path.slice(slash + 1);
    return `${base.replace(/\.[^.]+$/, '')}.js`;
}

/** Blob a self-contained worker bundle + `new Worker` it, with a data-URL fallback (Vite
 *  `?worker&inline`). */
function inlineWrapperModule(code: string): string {
    return `const __code = ${JSON.stringify(code)};
const __blob = typeof self !== 'undefined' && self.Blob && new Blob([__code], { type: 'text/javascript;charset=utf-8' });
export default function WorkerWrapper(options) {
    let __url;
    try {
        __url = __blob && (self.URL || self.webkitURL).createObjectURL(__blob);
        if (!__url) throw new Error('no object URL');
        const worker = new Worker(__url, { type: 'module', name: options && options.name });
        worker.addEventListener('error', () => { (self.URL || self.webkitURL).revokeObjectURL(__url); });
        return worker;
    } catch (e) {
        return new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(__code), { type: 'module', name: options && options.name });
    }
}
`;
}

/** `new Worker(new URL(fileName, import.meta.url))` — the emitted-chunk worker (Vite `?worker`). */
function urlWrapperModule(fileName: string): string {
    return `export default function WorkerWrapper(options) {
    return new Worker(new URL(${JSON.stringify(fileName)}, import.meta.url), { type: 'module', name: options && options.name });
}
`;
}
