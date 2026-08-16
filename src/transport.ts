import type { DevServer, FetchResult, ResolveResult } from './dev-server.ts';
import { createEnvironment, type Environment, type EnvironmentOptions } from './environment.ts';

/** A frame crossing the transport. `invoke`/`result` carry fetchModule/resolveId
 *  request/response; `push` carries an HMR change from server → environment. */
export type TransportFrame =
    | { __bundler: 'invoke'; id: number; call: string; args: unknown[] }
    | { __bundler: 'result'; id: number; result?: unknown; error?: string }
    | { __bundler: 'push'; payload: unknown };

/** SERVER side: connect one (possibly remote) environment to the dev server.
 *  `post` sends a frame to the environment; feed incoming frames to `handleFrame`.
 *  Registers the env for HMR fan-out (server.handleChange → a `push` frame). */
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

/** ENVIRONMENT (runner) side of the transport: turns frames into invoke promises +
 *  push callbacks. */
export type EnvironmentBridge = {
    handleFrame(frame: TransportFrame): void;
    invoke(call: string, ...args: unknown[]): Promise<unknown>;
    onPush(cb: (payload: unknown) => void): void;
};

export function createEnvironmentBridge(post: (frame: TransportFrame) => void): EnvironmentBridge {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    let nextId = 1;
    let pushCb: ((payload: unknown) => void) | null = null;
    return {
        handleFrame(frame) {
            if (frame.__bundler === 'result') {
                const p = pending.get(frame.id);
                if (p === undefined) return;
                pending.delete(frame.id);
                if (frame.error !== undefined) p.reject(new Error(frame.error));
                else p.resolve(frame.result);
            } else if (frame.__bundler === 'push') {
                pushCb?.(frame.payload);
            }
        },
        invoke(call, ...args) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                post({ __bundler: 'invoke', id, call, args });
            });
        },
        onPush(cb) {
            pushCb = cb;
        },
    };
}

/** Create an Environment whose fetchModule/resolveId route over a bridge (to a
 *  possibly-remote dev server), and whose HMR is driven by the server's pushes. */
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
