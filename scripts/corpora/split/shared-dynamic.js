// Reached from BOTH dynamic branches and from neither static path. Its colour is {panel, report},
// which is distinct from either branch's own — so it is the module that must not be folded into one
// of them without the other's chunk still being able to reach it.
import { formatLabel } from './shared-static.js';

export function summarise(rows) {
    let total = 0;
    for (const r of rows) total += r.weight;
    return formatLabel('sum', total);
}
export const DEFAULTS = { limit: 20, offset: 0 };
