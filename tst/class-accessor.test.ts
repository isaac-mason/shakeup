import { expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// `accessor a = 1` is an auto-accessor: a getter/setter pair on the prototype over private storage.
// The parser used to consume the keyword and drop it, which turned it into an own field. Checked by
// text, since Node does not run auto-accessors yet.
it('keeps an auto-accessor an accessor', async () => {
    const r = await bundle({
        entry: '/main.js',
        fs: createMemoryFs({
            '/main.js':
                'export class A { accessor a = 1; static accessor b = 2; }\n',
        }),
        external: [],
        output: {},
    } as never);
    const code = (r as { chunks: { code: string }[] }).chunks[0].code;
    expect(code).toContain('accessor a = 1;');
    expect(code).toContain('static accessor b = 2;');
});
