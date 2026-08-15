import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { Fs } from '../fs';

/** Fs backed by the real node filesystem. */
export function createNodeFs(): Fs {
    return {
        read: (id) => {
            try {
                return readFileSync(id, 'utf8');
            } catch {
                return null;
            }
        },
        exists: (id) => existsSync(id),
        realpath: (id) => {
            try {
                return realpathSync(id);
            } catch {
                return id;
            }
        },
    };
}
