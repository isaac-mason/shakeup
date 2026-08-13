// External import #1 of 'node:path' (also imported by config.ts -> hoist+dedupe).
// Named default export (a function).
import { basename } from 'node:path';

// join a label from a path using an external — trivial but real usage.
export default function labelFor(path: string): string {
    return `shape:${basename(path)}`;
}
