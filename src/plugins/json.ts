import type { Plugin } from '../plugin';

/** Turns `.json` imports into a module with the value as default export. */
export function json(): Plugin {
    return {
        name: 'json',
        transform: {
            filter: { id: /\.json$/ },
            handler: (_ctx, code) => `export default ${code.trim()};`,
        },
    };
}
