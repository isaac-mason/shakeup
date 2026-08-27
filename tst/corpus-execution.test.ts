import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';

// THE GATE THAT WAS MISSING. Nothing executed corpus output, so a tree-shaking bug that dropped
// `Object3D.DEFAULT_UP = new Vector3(0,1,0)` shipped past 2,050 green tests AND past the byte gate —
// which reported three.js getting 2,729 bytes SMALLER, i.e. the regression looked like a win. Only
// importing the bundle and calling into it caught the `TypeError: Cannot read properties of
// undefined (reading 'clone')`.
//
// Byte-identical output and passing unit tests cannot show that a real library still RUNS. This does.
const THREE = join(process.cwd(), 'llm/spikes/node_modules/three/build/three.core.js');
const diskFs = {
    read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
    realpath: (i: string) => (existsSync(i) ? realpathSync(i) : i),
};

describe.skipIf(!existsSync(THREE))('three.core.js executes after bundling', () => {
    const modes: [string, object][] = [
        ['plain', {}],
        ['compress full', { minify: { whitespace: false, mangle: false, compress: true } }],
        ['full minify', { minify: true }],
    ];

    // Bundling a ~777KB corpus three times is not a 5s job, and `SEMANTIC_VERIFY=1` makes it slower
    // still — the budget is generous so the gate never reads as a flake.
    it.each(modes)('%s', { timeout: 120_000 }, async (label, output) => {
        const result = await bundle({ entry: THREE, fs: diskFs, output } as never);
        expect((result as { errors: unknown[] }).errors).toEqual([]);
        const code = (result as { code: string }).code;
        // Import through a real file: a data: URL of a ~380KB module is fragile to encode.
        const file = join(tmpdir(), `shakeup-three-${label.replace(/\W+/g, '-')}-${process.pid}.mjs`);
        writeFileSync(file, code);
        const m = (await import(file)) as Record<string, unknown>;

        // Each of these needs a DIFFERENT static to have survived tree-shaking, so they fail
        // independently: Object3D.DEFAULT_UP, the ColorManagement tables, Matrix4's identity init.
        const Vector3 = m.Vector3 as new (x: number, y: number, z: number) => { length(): number };
        expect(new Vector3(3, 4, 0).length()).toBe(5);

        const Color = m.Color as new (c: number) => { getHexString(): string };
        expect(new Color(0xff8800).getHexString()).toBe('ff8800');

        const Matrix4 = m.Matrix4 as new () => { elements: number[] };
        expect(new Matrix4().elements[0]).toBe(1);

        // `new Object3D()` reads `Object3D.DEFAULT_UP.clone()` in its constructor — the exact
        // statement whose loss started this.
        const Object3D = m.Object3D as new () => { up: { x: number; y: number; z: number } };
        expect(new Object3D().up.y).toBe(1);
    });
});
