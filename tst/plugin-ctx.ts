import type { Fs } from '../src/bundler/fs.ts';
import { type PluginCtx, pluginParse } from '../src/bundler/plugin.ts';

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
        parse: pluginParse,
        fs,
        resolve: () => null,
        emitFile: () => {
            throw new Error('emitFile not supported in stubPluginCtx');
        },
        getFileName: () => {
            throw new Error('getFileName not supported in stubPluginCtx');
        },
        load: () => null,
        getModuleInfo: () => null,
        getModuleIds: () => [][Symbol.iterator](),
    };
}
