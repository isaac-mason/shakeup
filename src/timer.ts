// Threaded, allocation-free profiling. No singleton, no span callbacks — you hold the
// `TimerState` and bracket work with `start(state, name)` / `end(state, name)` (two plain
// calls, no closures). `init(false)` yields a disabled state whose start/end early-return, so
// leaving the calls in a hot path costs a single branch when profiling is off.
//
//   import * as Timer from './timer';
//   const t = Timer.init();
//   Timer.start(t, 'parse'); …; Timer.end(t, 'parse');
//   Timer.report(t); // [{ name, ms, calls }] by total ms

export type TimerState = {
    enabled: boolean;
    /** name → open-span start timestamp (paired start/end; same-name spans don't overlap). */
    open: Map<string, number>;
    /** name → accumulated ms across all its start/end pairs. */
    totals: Map<string, number>;
    counts: Map<string, number>;
};

export type TimerReport = { name: string; ms: number; calls: number }[];

export function init(enabled = true): TimerState {
    return { enabled, open: new Map(), totals: new Map(), counts: new Map() };
}

export function start(state: TimerState, name: string): void {
    if (!state.enabled) return;
    state.open.set(name, performance.now());
}

export function end(state: TimerState, name: string): void {
    if (!state.enabled) return;
    const t0 = state.open.get(name);
    if (t0 === undefined) return;
    state.totals.set(name, (state.totals.get(name) ?? 0) + (performance.now() - t0));
    state.counts.set(name, (state.counts.get(name) ?? 0) + 1);
    state.open.delete(name);
}

/** Accumulated per-name durations, sorted by total ms descending. */
export function report(state: TimerState): TimerReport {
    return [...state.totals.entries()]
        .map(([name, ms]) => ({ name, ms, calls: state.counts.get(name) ?? 0 }))
        .sort((a, b) => b.ms - a.ms);
}
