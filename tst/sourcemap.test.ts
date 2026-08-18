import { decode } from '@jridgewell/sourcemap-codec';
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import {
    addLine,
    addSegment,
    addUnmapped,
    composeSourceMaps,
    encodeMappings,
    inlineSourceMapComment,
    newMappings,
} from '../src/sourcemap.ts';
import { devTransform } from '../src/transform.ts';

// UTF-16 positions via plain JS string indexing (JS strings are UTF-16, matching SMv3 columns).
const lineStarts = (s: string): number[] => {
    const a = [0];
    for (let i = 0; i < s.length; i++) if (s[i] === '\n') a.push(i + 1);
    return a;
};
const posOf = (s: string, off: number): { line: number; col: number } => {
    const ls = lineStarts(s);
    let lo = 0;
    for (let i = 0; i < ls.length; i++) if (ls[i] <= off) lo = i;
    return { line: lo, col: off - ls[lo] };
};
const offOf = (s: string, line: number, col: number): number => lineStarts(s)[line] + col;
/** map a generated (line,col) to source (line,col) via the nearest preceding decoded segment */
function trace(mappings: string, genLine: number, genCol: number): { srcLine: number; srcCol: number } | null {
    const segs = decode(mappings)[genLine] || [];
    let best: readonly number[] | null = null;
    for (const seg of segs) if (seg[0] <= genCol && seg.length >= 4) best = seg;
    return best ? { srcLine: best[2]!, srcCol: best[3]! } : null;
}
/** trace including the source index (for multi-source bundle maps) */
function traceFull(
    mappings: string,
    genLine: number,
    genCol: number,
): { srcIdx: number; srcLine: number; srcCol: number } | null {
    const segs = decode(mappings)[genLine] || [];
    let best: readonly number[] | null = null;
    for (const seg of segs) if (seg[0] <= genCol && seg.length >= 4) best = seg;
    return best ? { srcIdx: best[1]!, srcLine: best[2]!, srcCol: best[3]! } : null;
}
/** nth (1-based) index of `token` in `hay` */
const nthIndex = (hay: string, token: string, n: number): number => {
    let i = -1;
    for (let k = 0; k < n; k++) i = hay.indexOf(token, i + 1);
    return i;
};

describe('sourcemap — MappingsBuilder (decoded by @jridgewell/sourcemap-codec)', () => {
    it('produces spec-correct VLQ that decodes to the exact absolute segments', () => {
        const m = newMappings();
        addSegment(m, 0, 0, 0, 0);
        addSegment(m, 10, 0, 0, 10);
        addLine(m);
        addSegment(m, 2, 0, 5, 4);
        addUnmapped(m, 8);
        expect(decode(encodeMappings(m))).toEqual([
            [
                [0, 0, 0, 0],
                [10, 0, 0, 10],
            ],
            [[2, 0, 5, 4], [8]],
        ]);
    });

    it('inline comment is a base64 data URL of the map JSON', () => {
        const c = inlineSourceMapComment({ version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA' });
        expect(c).toMatch(/^\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,/);
        const json = Buffer.from(c.split('base64,')[1], 'base64').toString('utf8');
        expect(JSON.parse(json)).toMatchObject({ version: 3, mappings: 'AAAA' });
    });
});

describe('sourcemap — dev transform round-trip (devTransform: strip + runner, one map)', () => {
    /** true iff `token`'s occ-th appearance in the OUTPUT traces back to identical text in SOURCE. */
    const roundTrips = (filename: string, src: string, token: string, occ: number): boolean => {
        const r = devTransform(filename, src, { sourcemap: true });
        expect(r.errors).toEqual([]);
        expect(r.map).toBeDefined();
        let idx = -1;
        for (let k = 0; k < occ; k++) idx = r.code.indexOf(token, idx + 1);
        const gp = posOf(r.code, idx);
        const t = trace(r.map!.mappings, gp.line, gp.col);
        if (!t) return false;
        const off = offOf(src, t.srcLine, t.srcCol);
        return src.slice(off, off + token.length) === token;
    };

    const ts = 'const greet = (name: string): string => `hi ${name}`;\nexport const out = greet(1);';

    it('identifiers round-trip through type stripping + runner rewrite', () => {
        expect(roundTrips('a.ts', ts, 'greet', 1)).toBe(true); // the declaration (not in the prelude)
        expect(roundTrips('a.ts', ts, 'name', 2)).toBe(true); // the `${name}` ref, after a stripped `: string`
        expect(roundTrips('a.ts', ts, 'greet', 2)).toBe(true); // the `greet(1)` call
    });

    it('UTF-16 columns: identifiers after a non-BMP char round-trip', () => {
        // \u{1F600} = a grinning-face emoji: a surrogate PAIR, 2 UTF-16 code units. Escaped (not a
        // literal glyph) so the fixture is byte-exact regardless of file encoding. If columns were
        // counted in code POINTS not UTF-16 units, everything after it would be off by one.
        const src = `const label = "\u{1F600} é x"; const tail: number = label.length;`;
        expect(roundTrips('u.ts', src, 'tail', 1)).toBe(true); // after the surrogate pair + a BMP accent
        expect(roundTrips('u.ts', src, 'label', 2)).toBe(true); // the `.length` reference, further right
    });

    it('sets sources + sourcesContent to the original file', () => {
        const r = devTransform('mod.ts', ts, { sourcemap: true });
        expect(r.map!.sources).toEqual(['mod.ts']);
        expect(r.map!.sourcesContent).toEqual([ts]);
        expect(r.map!.version).toBe(3);
    });

    it('plain-JS identifiers round-trip', () => {
        const src = 'const x = 1;\nexport const y = x + 1;';
        expect(roundTrips('p.js', src, 'x', 2)).toBe(true); // the `x + 1` ref (occ 1 is the decl)
    });

    it('no map unless requested', () => {
        expect(devTransform('a.ts', ts, {}).map).toBeUndefined();
    });

    it('synthetic runner prelude (__shakeup.live) is unmapped', () => {
        const r = devTransform('m.ts', ts, { sourcemap: true });
        expect(r.code.split('\n')[0]).toContain('__shakeup.live'); // generated-only boundary
        expect(trace(r.map!.mappings, 0, 0)).toBeNull();
    });
});

describe('sourcemap — lowered-construct interiors (devTransform)', () => {
    // JSX value expressions and enum member initializers map to their OWN source, not the coarse
    // element/enum-declaration start.
    it('JSX: value expressions map to their own source, not the element start', () => {
        const src = 'export const El = (handler, kid) => <div onClick={handler}>{kid}</div>;';
        const r = devTransform('c.tsx', src, { sourcemap: true });
        expect(r.errors).toEqual([]);
        // `handler`/`kid` in the emitted jsx() call map back to their {…} expressions, each to its OWN
        // source position. occ 1 is the parameter; occ 2 is inside the jsx() call.
        for (const token of ['handler', 'kid']) {
            const idx = nthIndex(r.code, token, 2);
            const gp = posOf(r.code, idx);
            const t = trace(r.map!.mappings, gp.line, gp.col);
            expect(t).not.toBeNull();
            expect(t!.srcLine).toBe(0);
            expect(t!.srcCol).toBeGreaterThan(src.indexOf('<div')); // interior maps deeper than the element start
        }
    });

    it('enum: computed member initializers map to their own source line', () => {
        const src = 'export enum Layer {\n  PLAYER = 1 << 2,\n  WALL = 1 << 3,\n  BOTH = PLAYER | WALL,\n}';
        const r = devTransform('layer.ts', src, { sourcemap: true });
        expect(r.errors).toEqual([]);
        const gp = posOf(r.code, r.code.indexOf('1 << 3'));
        const t = trace(r.map!.mappings, gp.line, gp.col);
        expect(t).not.toBeNull();
        expect(t!.srcLine).toBe(2); // WALL's line, NOT the enum decl (line 0)
        const off = offOf(src, t!.srcLine, t!.srcCol);
        expect(src.slice(off, off + 6)).toBe('1 << 3');
    });

    it('parameter property: the class name round-trips exactly', () => {
        const src = 'export class C {\n  constructor(private x: number) {}\n}';
        const r = devTransform('pp.ts', src, { sourcemap: true });
        expect(r.errors).toEqual([]);
        const cPos = posOf(r.code, r.code.indexOf('class C') + 6);
        const ct = trace(r.map!.mappings, cPos.line, cPos.col);
        expect(ct).not.toBeNull();
        expect(ct!.srcLine).toBe(0); // the class is declared on source line 0
    });
});

describe('sourcemap — composeSourceMaps chains two maps', () => {
    it('maps an output position through mid → original', () => {
        // outer maps out(0,0)→mid(0,6); inner maps mid(0,6)→orig(3,2). compose → out(0,0)→orig(3,2).
        const inner = { version: 3 as const, sources: ['orig.ts'], sourcesContent: ['x'], names: [], mappings: encodeMappings(mid2orig()) };
        const outer = { version: 3 as const, sources: ['mid.js'], names: [], mappings: encodeMappings(out2mid()) };
        const full = composeSourceMaps(outer, inner);
        expect(full.sources).toEqual(['orig.ts']);
        const t = trace(full.mappings, 0, 0);
        expect(t).toEqual({ srcLine: 3, srcCol: 2 });
    });
    function out2mid() {
        const m = newMappings();
        addSegment(m, 0, 0, 0, 6); // gen(0,0) → mid(0,6)
        return m;
    }
    function mid2orig() {
        const m = newMappings();
        addSegment(m, 6, 0, 3, 2); // mid(0,6) → orig(3,2)
        return m;
    }
});

describe('sourcemap — bundle() multi-module map', () => {
    const build = async (sourcemap: boolean) =>
        bundle({
            entry: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "import { add } from './math';\nexport const r: number = add(2, 3);",
                '/math.ts': 'export const add = (a: number, b: number): number => a + b;',
            }),
            sourcemap,
        });

    it('each token traces to the correct module source at the right position', async () => {
        const r = await build(true);
        expect(r.errors).toEqual([]);
        expect(r.map).toBeDefined();
        const hit = (token: string, occ: number, wantSource: string) => {
            const gp = posOf(r.code, nthIndex(r.code, token, occ));
            const t = traceFull(r.map!.mappings, gp.line, gp.col);
            expect(t).not.toBeNull();
            expect(r.map!.sources[t!.srcIdx]).toBe(wantSource);
            const content = r.map!.sourcesContent![t!.srcIdx]!;
            const off = offOf(content, t!.srcLine, t!.srcCol);
            expect(content.slice(off, off + token.length)).toBe(token);
        };
        hit('add', 1, '/math.ts'); // the declaration, in the dependency
        hit('add', 2, '/main.ts'); // the call, in the entry
        hit('r', 1, '/main.ts');
    });

    it('sourcesContent holds each module verbatim; synthetic export line is unmapped', async () => {
        const r = await build(true);
        expect(r.map!.sources).toEqual(['/math.ts', '/main.ts']);
        expect(r.map!.sourcesContent).toEqual([
            'export const add = (a: number, b: number): number => a + b;',
            "import { add } from './math';\nexport const r: number = add(2, 3);",
        ]);
        const exportLineIdx = r.code.split('\n').findIndex((l) => l.startsWith('export {'));
        expect(trace(r.map!.mappings, exportLineIdx, 0)).toBeNull();
    });

    it('no bundle map unless requested; enabling it only appends the sourceMappingURL comment', async () => {
        expect((await build(false)).map).toBeUndefined();
        const withMap = (await build(true)).code.replace(/\n\/\/# sourceMappingURL=[^\n]*\n$/, '\n');
        expect(withMap).toBe((await build(false)).code);
    });
});
