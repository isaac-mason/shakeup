import { DEFAULTS, summarise } from './shared-dynamic.js';
import { VERSION } from './shared-static.js';
import { lerp } from './util.js';

export function build(rows) {
    return `${summarise(rows)}#${VERSION}#${lerp(0, DEFAULTS.limit, 0.5)}`;
}
export { DEFAULTS };
