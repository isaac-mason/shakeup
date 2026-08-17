import type { Plugin } from '../plugin';

export type CssOptions = {
    /** How a `.css` import becomes a JS module:
     *  - `'inject'` (default): a module that appends a `<style>` with the css text at runtime,
     *    guarded on `document` (a no-op in a worker / SSR).
     *  - `'empty'`: an empty, side-effect-free module — for hosts that ship styles separately (e.g.
     *    the editor's prebuilt `bongle.css`), so `import './x.css'` just resolves and drops. */
    mode?: 'inject' | 'empty';
};

/** `import './styles.css'` → a JS module (core is JS-only; css is lowered to JS here, the Vite
 *  model). `moduleType: 'js'` forces JS handling despite the `.css` id. This is a deliberately small
 *  lowering — `@import`/`url()` resolution (postcss) is out of scope; a host that needs it layers a
 *  richer transform. */
export function css(options: CssOptions = {}): Plugin {
    const mode = options.mode ?? 'inject';
    return {
        name: 'css',
        load: {
            filter: { id: /\.css$/ },
            handler: async (ctx, id) => {
                if (mode === 'empty') return { code: '', moduleType: 'js', moduleSideEffects: false };
                const text = (await ctx.fs.read(id)) ?? '';
                return { code: injectModule(text), moduleType: 'js', moduleSideEffects: true };
            },
        },
    };
}

/** A side-effecting module that appends the css as a `<style>` when a DOM is present. */
function injectModule(cssText: string): string {
    return (
        `if (typeof document !== 'undefined') {\n` +
        `  const __el = document.createElement('style');\n` +
        `  __el.textContent = ${JSON.stringify(cssText)};\n` +
        `  document.head.appendChild(__el);\n` +
        `}\n`
    );
}
