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

// `shared-dynamic.js` is deliberately NOT reachable from here. Reached only from the two dynamic
// branches, it is the module the already-loaded optimisation folds into whichever branch it can —
// leaving the OTHER branch importing it across the chunk boundary, which is what makes that branch's
// chunk export more than its entry module does and forces a facade. Re-exporting it from the entry
// would pull it into the entry chunk and the whole case would collapse.
