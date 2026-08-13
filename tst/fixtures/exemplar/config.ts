// External import #2 of 'node:path' (same specifier as label.ts). The bundler
// must hoist + dedupe to a SINGLE `from 'node:path'` line. Note we import a
// different named member (`sep`) — dedupe merges the two import statements.
import { sep } from 'node:path';

// Anonymous default export: `export default { ... }` object literal, consumed.
export default {
    gravity: 10,
    // `sep` is always '/' or '\\'; length is 1 either way — keeps math exact.
    sepLen: sep.length,
};
