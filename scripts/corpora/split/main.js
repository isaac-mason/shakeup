// A MULTI-CHUNK corpus. `unchanged`'s other three all build to ONE chunk, so the whole chunk-graph
// engine — colouring, the already-loaded optimisation, facades, cross-chunk export wiring and chunk
// file naming — had no byte-level gate at all. This is that gate.
import { formatLabel, registry } from './shared-static.js';
import { clamp } from './util.js';

registry.set('main', true);

export const label = formatLabel('main', clamp(7, 0, 5));

export async function load(which, rows) {
    const mod = which === 'panel' ? await import('./panel.js') : await import('./report.js');
    return which === 'panel' ? mod.render(rows) : mod.build(rows);
}

// Statically importing a module that is ALSO a dynamic target, which is what forces a decision about
// duplication versus a shared chunk.
export { summarise } from './shared-dynamic.js';
