import { existsSync, mkdirSync, readFileSync, realpathSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type BundleOptions, type BundleResult, bundle, createBuildContext } from '../bundle';
import { type Fs, normalizePath } from '../fs';
import { driveWatch, type FileChangeKind, type FileEvent, type Watcher } from '../watch';

/** Fs backed by the real node filesystem. */
export function createNodeFs(): Fs {
    return {
        read: (id) => {
            try {
                return readFileSync(id, 'utf8');
            } catch {
                return null;
            }
        },
        exists: (id) => existsSync(id),
        realpath: (id) => {
            try {
                return realpathSync(id);
            } catch {
                return id;
            }
        },
    };
}

/**
 * Watch node paths (files or directories, recursive) and emit posix {@link FileEvent}s. `fs.watch`
 * reports coarse `rename`/`change`; we map `change → update` and `rename → create|delete` by
 * probing existence. Ids are absolute posix paths, matching the graph's module ids for a project
 * without symlinks in the watched tree (a symlinked source dir would need per-event realpathing).
 */
export function createNodeWatcher(paths: string | string[]): Watcher {
    const roots = (Array.isArray(paths) ? paths : [paths]).map((p) => resolve(p));
    return (emit) => {
        const handles = roots.map((root) =>
            fsWatch(root, { recursive: true }, (type, filename) => {
                if (filename === null) return;
                const id = normalizePath(join(root, filename.toString()));
                const kind: FileChangeKind = type === 'change' ? 'update' : existsSync(id) ? 'create' : 'delete';
                emit([{ kind, id }]);
            }),
        );
        return () => {
            for (const h of handles) h.close();
        };
    };
}

/** Bundle options plus where to write the result on the node fs. `fs` is optional here — it
 *  defaults to {@link createNodeFs} — unlike the core `bundle()` where it is required. */
export type NodeBuildOptions = Omit<BundleOptions, 'fs'> & {
    fs?: Fs;
    /** Directory to write chunks + `.map` assets into. */
    outDir?: string;
    /** Write output to `outDir`. Defaults to true when `outDir` is set. */
    write?: boolean;
};

function writeOutput(result: BundleResult, outDir: string): void {
    for (const chunk of result.chunks) {
        const path = join(outDir, chunk.fileName);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, chunk.code);
    }
    for (const asset of result.assets ?? []) {
        const path = join(outDir, asset.fileName);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, asset.source);
    }
}

/** The entry path a watch root defaults to, from either `entry` (string) or the first `input`. */
function entryOf(options: Pick<NodeBuildOptions, 'entry' | 'input'>): string | null {
    if (typeof options.entry === 'string') return options.entry;
    const input = options.input;
    if (typeof input === 'string') return input;
    if (Array.isArray(input) && input.length > 0) return input[0];
    if (input !== undefined && typeof input === 'object') {
        const first = Object.values(input)[0];
        if (typeof first === 'string') return first;
    }
    return null;
}

/** One-shot build. Uses the node fs by default; writes to `outDir` when set. */
export async function build(options: NodeBuildOptions): Promise<BundleResult> {
    const { outDir, write, ...bundleOptions } = options;
    const fs = bundleOptions.fs ?? createNodeFs();
    const result = await bundle({ ...bundleOptions, fs });
    if (outDir !== undefined && write !== false) writeOutput(result, outDir);
    return result;
}

export type WatchHandle = {
    /** Force a rebuild now, as if a change fired. */
    rebuild(): Promise<BundleResult>;
    /** Stop watching and release caches. */
    close(): void;
};

export type WatchOptions = NodeBuildOptions & {
    /** Paths (files or dirs) to watch. Defaults to the entry's directory. */
    watch?: string | string[];
    /** Coalesce rapid edits within this window (ms). Default 30. */
    debounceMs?: number;
    /** Called after every build, including the initial one (`events` is null for that). */
    onRebuild?: (result: BundleResult, events: FileEvent[] | null) => void;
    onError?: (error: unknown) => void;
};

/**
 * A warm, incremental watch-build loop: build once, then rebuild on change reusing the parse /
 * link / tree-shake / render caches. This is the programmatic "config as script" entry — no CLI
 * and no config file; a build script imports `watch` and passes its options directly. Lineage:
 * rollup's `rollup.watch` JS API and esbuild's `context.watch`.
 */
export function watch(options: WatchOptions): WatchHandle {
    const { outDir, write, watch: watchPaths, debounceMs, onRebuild, onError, ...bundleOptions } = options;
    const fs = bundleOptions.fs ?? createNodeFs();
    const ctx = createBuildContext({ ...bundleOptions, fs });

    const run = async (events: FileEvent[] | null): Promise<BundleResult> => {
        const result = await ctx.rebuild(events ?? undefined);
        if (outDir !== undefined && write !== false) writeOutput(result, outDir);
        onRebuild?.(result, events);
        return result;
    };

    void run(null).catch((e) => onError?.(e)); // initial build (fire-and-forget; onRebuild reports done)

    let roots = watchPaths;
    if (roots === undefined) {
        const entry = entryOf(bundleOptions);
        if (entry === null) throw new Error('watch(): pass `watch` paths (could not derive a root from the entry)');
        roots = dirname(resolve(entry));
    }
    const driver = driveWatch(createNodeWatcher(roots), (events) => void run(events).catch((e) => onError?.(e)), {
        debounceMs: debounceMs ?? 30,
        onError,
    });

    return {
        rebuild: () => run(null),
        close: () => {
            driver.close();
            ctx.close();
        },
    };
}
