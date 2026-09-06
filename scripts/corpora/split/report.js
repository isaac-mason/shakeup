import { DEFAULTS, summarise } from './shared-dynamic.js';
import { VERSION } from './shared-static.js';
// The other half of the cross-chunk namespace pair — see `panel.js`. Reads `chain`, which this
// module imports under no other name.
import * as util from './util.js';
import { lerp } from './util.js';

export function build(rows) {
    const shout = util.chain((s) => `${s}!`)(summarise(rows));
    return `${shout}#${VERSION}#${lerp(0, DEFAULTS.limit, 0.5)}`;
}
export { DEFAULTS };
