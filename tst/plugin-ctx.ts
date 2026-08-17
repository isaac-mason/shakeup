import type { Fs } from '../src/fs.ts';
import type { PluginCtx } from '../src/plugin.ts';

/** A minimal full {@link PluginCtx} for unit tests that drive a single hook in
 *  isolation (resolve/getModuleInfo/getModuleIds are inert stubs). */
export function stubPluginCtx(fs: Fs, warn: (m: string) => void = () => {}): PluginCtx {
    return {
        warn,
        error: (m) => {
            throw new Error(m);
        },
        info: () => {},
        debug: () => {},
        fs,
        resolve: () => null,
        emitFile: () => {
            throw new Error('emitFile not supported in stubPluginCtx');
        },
        getModuleInfo: () => null,
        getModuleIds: () => [][Symbol.iterator](),
    };
}
