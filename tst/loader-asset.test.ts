import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// P1 item 8 of the alignment plan: the `text` / `base64` / `dataurl` / `binary` / `empty` loaders.
// All five were in `ModuleType` (which is rolldown's enum, transcribed) but only `json` was ever
// acted on, so a `.txt` import went to the JavaScript parser.
//
// Both oracles agree on the whole spec, so these assert VALUES rather than shape:
//   text    strip a UTF-8 BOM, `export default "<contents>"`   (bundler.go:333, parse_to_ecma_ast.rs:159)
//   base64  `export default "<standard base64>"`               (bundler.go:347, :172)
//   dataurl `export default "<shorter of base64|percent>"`     (bundler.go:384, :176)
//   binary  `export default __toBinary("<base64>")`            (bundler.go:361, :182)
//   empty   an empty module                                    (parse_to_ecma_ast.rs:196)
const run = async (files: Record<string, string | Uint8Array>, main: string, opts: Record<string, unknown> = {}) => {
    const r = await bundle({
        entry: '/main.js',
        external: [],
        fs: createMemoryFs({ ...files, '/main.js': main }),
        ...opts,
    });
    expect(r.errors).toEqual([]);
    return (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { x: unknown };
};

/** A PNG header followed by bytes that are NOT valid UTF-8 — the case a text read corrupts. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x7f]);

describe('the text loader', () => {
    it('binds the file contents to the default export', async () => {
        expect((await run({ '/a.txt': 'line 1\nline "2"\n' }, "import t from './a.txt';\nexport const x = t;")).x).toBe(
            'line 1\nline "2"\n',
        );
    });

    it('is reached by `.txt` with no configuration', async () => {
        // rolldown's built-in map (`prepare_build_context.rs:234`) and esbuild's
        // (`bundler.go:2968`) both carry `.txt → text`. Nothing else outside JS/JSON is in either.
        expect((await run({ '/a.txt': 'hi' }, "import t from './a.txt';\nexport const x = typeof t;")).x).toBe('string');
    });

    it('strips a UTF-8 BOM', async () => {
        // A BOM is an encoding marker, not a character of the text. Both oracles strip it here and
        // nowhere else among these loaders.
        expect((await run({ '/a.txt': '﻿hi' }, "import t from './a.txt';\nexport const x = t;")).x).toBe('hi');
    });

    it('survives quotes, backslashes, newlines and astral characters', async () => {
        const s = 'a"b\\c\nd e\u{1F600}f';
        expect((await run({ '/a.txt': s }, "import t from './a.txt';\nexport const x = t;")).x).toBe(s);
    });

    it('can be selected for any extension through `moduleTypes`', async () => {
        expect(
            (
                await run({ '/s.wgsl': 'fn main() {}' }, "import s from './s.wgsl';\nexport const x = s;", {
                    moduleTypes: { wgsl: 'text' },
                })
            ).x,
        ).toBe('fn main() {}');
    });

    it('can be selected by an import attribute', async () => {
        expect((await run({ '/a.dat': 'raw' }, "import t from './a.dat' with { type: 'text' };\nexport const x = t;")).x).toBe(
            'raw',
        );
    });
});

describe('the base64 loader', () => {
    it('encodes the raw bytes, matching Node', async () => {
        // Node's `Buffer` is the oracle for the encoding itself: `toBase64` is hand-rolled (core
        // must not reach for node builtins, and `btoa` takes a lossy latin1 string).
        expect(
            (
                await run({ '/p.png': PNG }, "import p from './p.png';\nexport const x = p;", {
                    moduleTypes: { png: 'base64' },
                })
            ).x,
        ).toBe(Buffer.from(PNG).toString('base64'));
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])('pads a length ≡ %i correctly', async (n) => {
        const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 200) & 0xff));
        expect(
            (
                await run({ '/b.bin': bytes }, "import b from './b.bin';\nexport const x = b;", {
                    moduleTypes: { bin: 'base64' },
                })
            ).x,
        ).toBe(Buffer.from(bytes).toString('base64'));
    });

    it('handles an empty file', async () => {
        expect(
            (
                await run({ '/b.bin': new Uint8Array(0) }, "import b from './b.bin';\nexport const x = b;", {
                    moduleTypes: { bin: 'base64' },
                })
            ).x,
        ).toBe('');
    });
});

describe('the binary loader', () => {
    it('round-trips the exact bytes through `__toBinary`', async () => {
        // The decoder is rolldown's `runtime-base.js:76`, which is esbuild's. Asserting the DECODED
        // bytes is the only check that covers both the encoder and the transcription.
        const { x } = await run({ '/p.png': PNG }, "import p from './p.png';\nexport const x = Array.from(p);", {
            moduleTypes: { png: 'binary' },
        });
        expect(x).toEqual(Array.from(PNG));
    });

    it('produces a real Uint8Array', async () => {
        expect(
            (
                await run({ '/p.png': PNG }, "import p from './p.png';\nexport const x = p instanceof Uint8Array;", {
                    moduleTypes: { png: 'binary' },
                })
            ).x,
        ).toBe(true);
    });

    it.each([0, 1, 2, 3, 255, 256])('round-trips %i bytes', async (n) => {
        const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 97) & 0xff));
        const { x } = await run({ '/b.bin': bytes }, "import b from './b.bin';\nexport const x = Array.from(b);", {
            moduleTypes: { bin: 'binary' },
        });
        expect(x).toEqual(Array.from(bytes));
    });

    it('is reached by `with { type: "bytes" }`', async () => {
        // esbuild maps the attribute value `bytes` onto the loader it calls `binary`
        // (`bundler.go:214`); the two vocabularies differ only for this one type.
        const { x } = await run(
            { '/p.png': PNG },
            "import p from './p.png' with { type: 'bytes' };\nexport const x = Array.from(p);",
        );
        expect(x).toEqual(Array.from(PNG));
    });

    it('emits `__toBinary` once for many binary modules', async () => {
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({
                '/a.bin': PNG,
                '/b.bin': PNG.slice(0, 4),
                '/main.js': "import a from './a.bin';\nimport b from './b.bin';\nexport const x = [a, b];",
            }),
            moduleTypes: { bin: 'binary' },
        });
        expect(r.errors).toEqual([]);
        expect(r.code.match(/var __toBinary =/g)?.length).toBe(1);
    });

    it('does not emit `__toBinary` when no module uses it', async () => {
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({ '/main.js': 'export const x = 1;' }),
        });
        expect(r.code).not.toMatch(/__toBinary/);
    });
});

describe('the dataurl loader', () => {
    const asUrl = (files: Record<string, string | Uint8Array>, name: string) =>
        run(files, `import d from '${name}';\nexport const x = d;`, {
            moduleTypes: { png: 'dataurl', txt: 'dataurl', bin: 'dataurl', unknownext: 'dataurl' },
        }).then((m) => m.x as string);

    it('takes the MIME type from the extension table', async () => {
        // 24 entries, transcribed from rolldown's `light_guess.rs` (itself from esbuild's
        // `mime.go`). Binary types carry no charset.
        expect(await asUrl({ '/p.png': PNG }, './p.png')).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    });

    it('percent-escapes when that is shorter than base64', async () => {
        // The whole point of `EncodeStringAsShortestDataURL`: for text, spaces and letters ride
        // through raw, so the percent form beats base64's 4/3 expansion.
        const url = await asUrl({ '/a.txt': 'hello world, this is plain text' }, './a.txt');
        expect(url).toBe('data:text/plain;charset=utf-8,hello world, this is plain text');
    });

    it('escapes exactly the characters esbuild derived, and no others', async () => {
        // `dataurl-escapes.html`: tab/newline/CR/`#` always; the trailing run of control+space
        // characters; and a `%` that would otherwise READ as an escape. NOT the usual
        // `encodeURIComponent` set — a raw space and a raw `?` are both fine.
        const url = await asUrl({ '/a.txt': 'a b?c#d\te%33f%zz ' }, './a.txt');
        expect(url).toBe('data:text/plain;charset=utf-8,a b?c%23d%09e%2533f%zz%20');
    });

    it('falls back to base64 for bytes that are not valid UTF-8', async () => {
        // Percent-escaping is defined over text; `encode_as_percent_escaped` returns `None` for
        // invalid UTF-8 and the base64 form is used unconditionally.
        const bytes = new Uint8Array([0xff, 0xfe, 0x41]);
        expect(await asUrl({ '/b.bin': bytes }, './b.bin')).toBe(
            `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
        );
    });

    it('sniffs the MIME type when the extension is unknown', async () => {
        // `guess_mime` order: extension table, then magic bytes, then "is it UTF-8?", then
        // `application/octet-stream`. `.unknownext` is in no table, so the PNG header decides.
        expect(await asUrl({ '/p.unknownext': PNG }, './p.unknownext')).toMatch(/^data:image\/png;base64,/);
    });

    it('calls unrecognised but valid UTF-8 `text/plain`', async () => {
        expect(await asUrl({ '/a.unknownext': 'plain' }, './a.unknownext')).toBe('data:text/plain;charset=utf-8,plain');
    });

    it('produces a URL a browser would decode back to the original', async () => {
        // The product, not the feature: decode the emitted URL the way `fetch` would.
        const url = await asUrl({ '/p.png': PNG }, './p.png');
        const [, b64] = url.split(';base64,');
        expect(Array.from(Buffer.from(b64, 'base64'))).toEqual(Array.from(PNG));
    });
});

describe('the empty loader', () => {
    it('yields a module with no exports and runs no code', async () => {
        expect(
            (
                await run({ '/x.frag': 'this is not javascript (((' }, "import './x.frag';\nexport const x = 1;", {
                    moduleTypes: { frag: 'empty' },
                })
            ).x,
        ).toBe(1);
    });
});

describe('loader tree-shaking', () => {
    it('drops an asset module nothing imports from', async () => {
        // Every one of these loaders emits a LAZY default export — one expression and nothing else
        // (rolldown's `has_lazy_export`, esbuild's `LazyExportAST`), so an unused one is droppable.
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({
                '/big.txt': 'UNIQUE_MARKER_TEXT',
                '/main.js': "import t from './big.txt';\nexport const x = 1;",
            }),
        });
        expect(r.errors).toEqual([]);
        expect(r.code).not.toMatch(/UNIQUE_MARKER_TEXT/);
    });
});
