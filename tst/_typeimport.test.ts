import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// A named import used ONLY in a type position, in an import statement that also
// carries real values and has no `type` markers. tsc's isolatedModules would want
// `import { type Node }`, but plenty of real code does not write it — rolldown
// elides such bindings, so user code like this built fine before.
describe('type-only named import in a mixed import', () => {
    it('elides a binding only used as a type annotation', async () => {
        const r = await bundle({
            input: { index: '/a.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { makeNode, Node } from './lib';\nlet n: Node;\nexport const v = makeNode();\n",
                '/lib.ts': 'export function makeNode() { return 1; }\nexport type Node = { id: number };\n',
            }),
            external: [],
        });
        expect(r.errors).toEqual([]);
    });

    it('elides an imported binding that is never used at all', async () => {
        const r = await bundle({
            input: { index: '/a.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { makeNode, Unused } from './lib';\nexport const v = makeNode();\n",
                '/lib.ts': 'export function makeNode() { return 1; }\nexport type Unused = { id: number };\n',
            }),
            external: [],
        });
        expect(r.errors).toEqual([]);
    });
});
