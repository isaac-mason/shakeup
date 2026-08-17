export type TimerState = {
    enabled: boolean;
    open: Map<string, number>;
    totals: Map<string, number>;
    counts: Map<string, number>;
};

export function init(enabled: boolean): TimerState {
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

export type TimerReport = { name: string; ms: number; calls: number }[];

export function report(state: TimerState): TimerReport {
    return [...state.totals.entries()]
        .map(([name, ms]) => ({ name, ms, calls: state.counts.get(name) ?? 0 }))
        .sort((a, b) => b.ms - a.ms);
}
