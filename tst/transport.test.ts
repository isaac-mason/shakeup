import { afterEach, describe, expect, it } from 'vitest';
import { createDevServer } from '../src/runtime/dev-server.ts';
import type { Fs } from '../src/fs.ts';
import { attachEnvironment, connectEnvironment, createEnvironmentBridge, type TransportFrame } from '../src/runtime/transport.ts';

/** Wire an environment to the dev server over an in-process frame transport (the
 *  same protocol a MessagePort would carry between realms). */
function overTransport(files: Record<string, string>) {
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const server = createDevServer({ fs });

    // two frame sinks, cross-wired (simulating a transport between two realms).
    let toRemote!: (f: TransportFrame) => void;
    let toServer!: (f: TransportFrame) => void;
    const conduit = attachEnvironment(server, 'e', (f) => toRemote(f));
    const bridge = createEnvironmentBridge((f) => toServer(f));
    toRemote = bridge.handleFrame;
    toServer = conduit.handleFrame;

    const env = connectEnvironment(bridge, { name: 'e', createImportMeta: (id) => ({ url: id }) });
    return { server, env, files };
}

const settle = () => new Promise((r) => setTimeout(r, 10)); // let async frame hops complete

afterEach(() => {
    (globalThis as Record<string, unknown>).__t = undefined;
});

describe('transport — environment over a frame bridge', () => {
    it('loads + links a module graph with fetchModule/resolveId over the transport', async () => {
        const { env } = overTransport({
            '/entry.ts': `import { v } from './dep';\nexport const r: number = v * 2;`,
            '/dep.ts': `export const v = 21;`,
        });
        expect((await env.import('/entry.ts')).r).toBe(42);
    });

    it('applies HMR pushed from the server over the transport', async () => {
        const { server, env, files } = overTransport({
            '/m.ts': `globalThis.__t ??= [];\nexport let v = 1;\nimport.meta.hot.accept((nm) => { globalThis.__t.push(nm.v); });`,
        });
        await env.import('/m.ts');

        files['/m.ts'] = files['/m.ts'].replace('v = 1', 'v = 2');
        await server.handleChange('/m.ts'); // fans a `push` frame to the remote env
        await settle();
        expect((globalThis as { __t?: number[] }).__t).toEqual([2]);
    });
});
