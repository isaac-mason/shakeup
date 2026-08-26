import { existsSync, readFileSync } from 'node:fs';
import type { Fs } from '../src/fs.ts';

/** Real-disk {@link Fs} for the differential harness — both bundlers must read the same bytes. */
export const nodeFsFrom = (): Fs => ({
    read: (id: string) => (existsSync(id) ? readFileSync(id, 'utf8') : null),
    exists: (id: string) => existsSync(id),
});
