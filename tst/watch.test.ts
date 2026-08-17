import { describe, expect, it, vi } from 'vitest';
import { bundle, createBuildContext } from '../src/bundle.ts';
import type { Fs } from '../src/fs.ts';
import { driveWatch, type FileEvent, type Watcher } from '../src/watch.ts';

/** A watcher whose `emit` we drive by hand — no real filesystem, fully deterministic. */
function manualWatcher(): { watcher: Watcher; emit: (events: FileEvent[]) => void; closed: () => boolean } {
    let sink: ((events: FileEvent[]) => void) | null = null;
    let unsubbed = false;
    const watcher: Watcher = (emit) => {
        sink = emit;
        return () => {
            unsubbed = true;
        };
    };
    return { watcher, emit: (e) => sink?.(e), closed: () => unsubbed };
}

describe('driveWatch', () => {
    it('batches events within the debounce window into a single onChange', () => {
        vi.useFakeTimers();
        const { watcher, emit } = manualWatcher();
        const batches: FileEvent[][] = [];
        const d = driveWatch(watcher, (evs) => void batches.push(evs), { debounceMs: 20 });
        emit([{ kind: 'update', id: '/a' }]);
        emit([{ kind: 'update', id: '/b' }]);
        vi.advanceTimersByTime(19);
        expect(batches).toHaveLength(0); // still within the window
        vi.advanceTimersByTime(1);
        expect(batches).toHaveLength(1);
        expect(batches[0].map((e) => e.id).sort()).toEqual(['/a', '/b']);
        d.close();
        vi.useRealTimers();
    });

    it('coalesces repeated events for one id (last kind wins)', () => {
        vi.useFakeTimers();
        const { watcher, emit } = manualWatcher();
        const batches: FileEvent[][] = [];
        const d = driveWatch(watcher, (evs) => void batches.push(evs), { debounceMs: 10 });
        emit([{ kind: 'create', id: '/x' }]);
        emit([{ kind: 'update', id: '/x' }]);
        vi.advanceTimersByTime(10);
        expect(batches[0]).toEqual([{ kind: 'update', id: '/x' }]);
        d.close();
        vi.useRealTimers();
    });

    it('a create followed by a delete cancels out — no rebuild fires', () => {
        vi.useFakeTimers();
        const { watcher, emit } = manualWatcher();
        const batches: FileEvent[][] = [];
        const d = driveWatch(watcher, (evs) => void batches.push(evs), { debounceMs: 10 });
        emit([{ kind: 'create', id: '/scratch' }, { kind: 'delete', id: '/scratch' }]);
        vi.advanceTimersByTime(10);
        expect(batches).toHaveLength(0);
        d.close();
        vi.useRealTimers();
    });

    it('close() unsubscribes from the watcher', () => {
        const { watcher, closed } = manualWatcher();
        const d = driveWatch(watcher, () => {});
        expect(closed()).toBe(false);
        d.close();
        expect(closed()).toBe(true);
    });
});

describe('rebuild(events)', () => {
    it('prunes a deleted module and stays byte-identical to a cold build', async () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { a } from './a';\nexport const t = a + 1;",
            '/a.ts': 'export const a = 1;',
        };
        const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
        const opts = () => ({ entry: '/entry.ts', fs, external: [] as string[] });
        const ctx = createBuildContext(opts());
        await ctx.rebuild(); // prime caches with a.ts present

        // entry stops importing a; a.ts is removed from the project.
        files['/entry.ts'] = 'export const t = 2;';
        delete files['/a.ts'];
        const r = await ctx.rebuild([
            { kind: 'update', id: '/entry.ts' },
            { kind: 'delete', id: '/a.ts' },
        ]);
        expect(r.errors).toEqual([]);

        const cold = await bundle(opts());
        expect(r.chunks[0].code).toBe(cold.chunks[0].code);
    });
});
