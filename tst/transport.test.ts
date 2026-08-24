import { afterEach, describe, expect, it } from 'vitest';
import type { Fs } from '../src/fs.ts';
import { createDevServer } from '../src/runtime/dev-server.ts';
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

    it('a dead conduit fails the call instead of hanging forever', async () => {
        // A port whose far side was terminated delivers no event — it just stops replying. Without
        // a timeout the promise never settles and the realm's import() waits forever, showing
        // nothing: the "client never comes back after restarting the compiler" symptom.
        const bridge = createEnvironmentBridge(() => {}, { timeoutMs: 20 }); // post goes nowhere
        await expect(bridge.invoke('fetchModule', '/m.ts')).rejects.toThrow(/stopped responding/);
    });

    it('the first timeout fails the bridge, so later calls fail fast', async () => {
        const bridge = createEnvironmentBridge(() => {}, { timeoutMs: 20 });
        await expect(bridge.invoke('fetchModule', '/a.ts')).rejects.toThrow(/stopped responding/);

        // once the conduit is proven dead, a second call must not stall for another full timeout.
        const started = performance.now();
        await expect(bridge.invoke('fetchModule', '/b.ts')).rejects.toThrow(/stopped responding/);
        expect(performance.now() - started).toBeLessThan(15);
    });

    it('fails every in-flight call at once, not just the one that timed out', async () => {
        const bridge = createEnvironmentBridge(() => {}, { timeoutMs: 20 });
        const calls = [bridge.invoke('fetchModule', '/a.ts'), bridge.invoke('fetchModule', '/b.ts')];
        const settled = await Promise.allSettled(calls);
        expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    });

    it('fail() reports a host-known teardown to everything in flight', async () => {
        const bridge = createEnvironmentBridge(() => {});
        const call = bridge.invoke('fetchModule', '/m.ts');
        bridge.fail('compiler restarted');
        await expect(call).rejects.toThrow('compiler restarted');
        await expect(bridge.invoke('fetchModule', '/n.ts')).rejects.toThrow('compiler restarted');
    });

    it('a timely answer clears its timer (a slow graph must not trip the bridge)', async () => {
        const { env } = overTransport({ '/m.ts': `export const v = 1;` });
        expect((await env.import('/m.ts')).v).toBe(1);
        // nothing should fire after the fact — if the timer leaked, this would trip mid-wait.
        await settle();
        expect((await env.import('/m.ts')).v).toBe(1);
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
