import { DEFAULTS, summarise } from './shared-dynamic.js';
import { formatLabel, registry } from './shared-static.js';
import { chain, clamp } from './util.js';

registry.set('panel', true);

export const limit = clamp(DEFAULTS.limit, 1, 10);
export function render(rows) {
    return (
        chain(
            (s) => `${s}|`,
            (s) => s.toUpperCase(),
        )(summarise(rows)) + formatLabel('panel', limit)
    );
}
// A dynamic import from INSIDE a dynamic chunk — the nested case, where the already-loaded
// optimisation has something to work with.
export const detail = import('./detail.js');
