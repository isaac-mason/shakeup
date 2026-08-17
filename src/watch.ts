/**
 * The change seam — the counterpart to {@link Fs}. `Fs` is how core READS the environment;
 * `Watcher` is how core learns the environment CHANGED. Both are host-injected so the core stays
 * environment-agnostic (node, browser, an in-memory test, or makecat's vfs overlay).
 *
 * The `create | update | delete` vocabulary is grounded in rollup's `watchChange` plugin hook
 * (`ChangeEvent = 'create' | 'update' | 'delete'`) and `@parcel/watcher` (`event.type`). The
 * KIND is load-bearing for incremental rebuilds: an `update` is source-only (resolution of other
 * modules is unaffected), whereas a `create`/`delete` can change resolution — a newly-created
 * `./foo.ts` shadows an unchanged importer's `./foo` that resolved to `./foo/index.ts`. A watcher
 * that reported bare paths could not drive a sound resolution cache.
 */

/** A single filesystem change. `id` is a posix path, matching the ids the graph keys modules by. */
export type FileChangeKind = 'create' | 'update' | 'delete';
export type FileEvent = { kind: FileChangeKind; id: string };

/**
 * A host wires its native watcher to `emit` and returns an unsubscribe (or nothing). Node backs
 * this with `fs.watch`/chokidar/@parcel/watcher; the browser with a project-fs change stream; a
 * test with a hand-driven emitter. Core never imports any of them — it only consumes `FileEvent`s.
 */
export type Watcher = (emit: (events: FileEvent[]) => void) => (() => void) | void;

export type WatchDriver = { close(): void };

/**
 * Batch + de-dup a {@link Watcher}'s events over a debounce window, then invoke `onChange` once
 * per settled batch. Within a batch the LAST kind observed for an id wins (an editor's
 * write-temp→rename storm collapses to one net event), except a `create` followed by a `delete`
 * cancels to nothing. Mirrors the coalescing rollup/chokidar do before a rebuild.
 */
export function driveWatch(
    watcher: Watcher,
    onChange: (events: FileEvent[]) => void | Promise<void>,
    opts: { debounceMs?: number; onError?: (e: unknown) => void } = {},
): WatchDriver {
    const debounceMs = opts.debounceMs ?? 0;
    const pending = new Map<string, FileChangeKind>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
        timer = null;
        const events: FileEvent[] = [];
        for (const [id, kind] of pending) events.push({ id, kind });
        pending.clear();
        if (events.length === 0) return;
        try {
            const r = onChange(events);
            if (r instanceof Promise) r.catch((e) => opts.onError?.(e));
        } catch (e) {
            opts.onError?.(e);
        }
    };

    const record = (e: FileEvent): void => {
        const prior = pending.get(e.id);
        // create→delete within one batch means the file never really existed for us: drop it.
        if (prior === 'create' && e.kind === 'delete') pending.delete(e.id);
        else pending.set(e.id, e.kind);
    };

    const unsub = watcher((events) => {
        for (const e of events) record(e);
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
    });

    return {
        close() {
            if (timer !== null) clearTimeout(timer);
            unsub?.();
        },
    };
}
