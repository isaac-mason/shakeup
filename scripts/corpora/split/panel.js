import { DEFAULTS, summarise } from './shared-dynamic.js';
import { formatLabel, registry } from './shared-static.js';
// A NAMESPACE import of a module that lives in the ENTRY chunk, read only as static members — the
// cross-chunk elision shape (§2z54). `report.js` namespace-imports the same module and reads a
// DIFFERENT member, so between them they also cover "two dynamic chunks, disjoint member sets".
// `lerp` is not among the names this module imports by name, so it reaches this chunk only if the
// elision wires it.
import * as util from './util.js';
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
export const midpoint = () => util.lerp(0, DEFAULTS.limit, 0.25);
