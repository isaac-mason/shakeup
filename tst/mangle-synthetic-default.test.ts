import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { runModule } from './exec-helpers.ts';

// `export default <expression>` mints a SYNTHETIC symbol in link (`syntheticRef`), whose id is
// allocated past the producer's real symbol table. The chunk mangler indexes `symMap` by symbol id and
// crashed on the resulting out-of-range lookup — `refScopes[undefined].push(...)`. three.js ships ~200
// such modules (`.glsl.js` shader chunks, each `export default \`…\``), so full minify of any real
// multi-module graph containing one died. These execute rather than just building: a wrong name here
// resolves to the wrong binding SILENTLY.
describe('chunk mangler — synthetic default-export refs', () => {
    const build = (files: Record<string, string>, minify: boolean) =>
        bundle({
            entry: '/e.js',
            fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
            external: [],
            output: { minify },
        });

    const FILES = {
        // No named binding at all — the producer's real symbol table is EMPTY, which is what makes the
        // synthetic id land out of range.
        '/glsl.js': 'export default `void main() {}`;\n',
        '/other.js': 'export default 41;\n',
        '/e.js':
            'import shader from "./glsl.js";\nimport n from "./other.js";\n' +
            'export const out = shader.length + n;\n',
    };

    it('mangles a chunk containing a bare-expression default export without crashing', async () => {
        const { code } = await build(FILES, true);
        expect((await runModule(code)).out).toBe('void main() {}'.length + 41);
    });

    it('agrees with the unmangled build', async () => {
        const mangled = (await runModule((await build(FILES, true)).code)).out;
        const plain = (await runModule((await build(FILES, false)).code)).out;
        expect(mangled).toBe(plain);
    });
});
