import type { DevServer, FetchResult, ResolveResult } from './dev-server.ts';
import { createEnvironment, type Environment, type EnvironmentOptions } from './environment.ts';

export type TransportFrame =
    | { __bundler: 'invoke'; id: number; call: string; args: unknown[] }
    | { __bundler: 'result'; id: number; result?: unknown; error?: string }
    | { __bundler: 'push'; payload: unknown };

export function attachEnvironment(
    server: DevServer,
    name: string,
    post: (frame: TransportFrame) => void,
): { handleFrame(frame: TransportFrame): void; close(): void } {
    // The server-side handle: an edit fans out as a `push` frame; the remote env
    // applies it locally, so the result here is a noop.
    const close = server.register({
        name,
        applyEdit: async (id) => {
            post({ __bundler: 'push', payload: { changed: id } });
            return { type: 'noop' };
        },
    });
    const respond = (id: number, result?: unknown, error?: string) => post({ __bundler: 'result', id, result, error });
    return {
        handleFrame(frame) {
            if (frame.__bundler !== 'invoke') return;
            void (async () => {
                try {
                    if (frame.call === 'fetchModule') respond(frame.id, await server.fetchModule(frame.args[0] as string));
                    else if (frame.call === 'resolveId')
                        respond(frame.id, await server.resolveId(frame.args[0] as string, frame.args[1] as string | null));
                    else respond(frame.id, undefined, `unknown call: ${frame.call}`);
                } catch (e) {
                    respond(frame.id, undefined, e instanceof Error ? e.message : String(e));
                }
            })();
        },
        close,
    };
}

export type EnvironmentBridge = {
    handleFrame(frame: TransportFrame): void;
    invoke(call: string, ...args: unknown[]): Promise<unknown>;
    onPush(cb: (payload: unknown) => void): void;
    /** Fail every in-flight call and every later one. For a host that KNOWS the far side is gone
     *  (it tore the conduit down itself) — otherwise `timeoutMs` is what notices. */
    fail(reason: string): void;
};

export type EnvironmentBridgeOptions = {
    /** Fail a call that goes unanswered for this long. A port whose far side died delivers no
     *  event — a terminated worker just stops replying — so without this an in-flight fetchModule
     *  never settles and the realm's `import()` waits forever, with nothing to report. The FIRST
     *  timeout fails the whole bridge: once the conduit is proven dead, later calls fail
     *  immediately rather than each stalling for the full duration. Omit for no timeout. */
    timeoutMs?: number;
};

export function createEnvironmentBridge(
    post: (frame: TransportFrame) => void,
    options: EnvironmentBridgeOptions = {},
): EnvironmentBridge {
    type Pending = {
        resolve: (v: unknown) => void;
        reject: (e: unknown) => void;
        timer: ReturnType<typeof setTimeout> | undefined;
    };
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let pushCb: ((payload: unknown) => void) | null = null;
    let failure: string | null = null;

    function fail(reason: string): void {
        if (failure !== null) return;
        failure = reason;
        const inFlight = [...pending.values()];
        pending.clear();
        for (const p of inFlight) {
            if (p.timer !== undefined) clearTimeout(p.timer);
            p.reject(new Error(reason));
        }
    }

    return {
        handleFrame(frame) {
            if (frame.__bundler === 'result') {
                const p = pending.get(frame.id);
                if (p === undefined) return;
                if (p.timer !== undefined) clearTimeout(p.timer);
                pending.delete(frame.id);
                if (frame.error !== undefined) p.reject(new Error(frame.error));
                else p.resolve(frame.result);
            } else if (frame.__bundler === 'push') {
                pushCb?.(frame.payload);
            }
        },
        invoke(call, ...args) {
            if (failure !== null) return Promise.reject(new Error(failure));
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timer =
                    options.timeoutMs === undefined
                        ? undefined
                        : setTimeout(
                              () => fail(`bundler conduit stopped responding (${call} exceeded ${options.timeoutMs}ms)`),
                              options.timeoutMs,
                          );
                pending.set(id, { resolve, reject, timer });
                post({ __bundler: 'invoke', id, call, args });
            });
        },
        onPush(cb) {
            pushCb = cb;
        },
        fail,
    };
}

export function connectEnvironment(
    bridge: EnvironmentBridge,
    options: Omit<EnvironmentOptions, 'fetchModule' | 'resolveId'>,
): Environment {
    const env = createEnvironment({
        ...options,
        fetchModule: (id) => bridge.invoke('fetchModule', id) as Promise<FetchResult>,
        resolveId: (spec, importer) => bridge.invoke('resolveId', spec, importer) as Promise<ResolveResult>,
    });
    bridge.onPush((payload) => {
        const changed = (payload as { changed?: string }).changed;
        if (changed !== undefined) void env.applyEdit(changed);
    });
    return env;
}
