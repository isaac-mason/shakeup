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
import { moduleRunnerTransform, transform } from '../src/transform.ts';

// Decoding goes through @jridgewell/sourcemap-codec — the canonical VLQ codec used by rollup /
// vite / magic-string. Using an INDEPENDENT decoder (not our own inverse) is the point: it proves
// our `mappings` string is spec-correct, not merely self-consistent. `decode` returns absolute
// [genCol, srcIdx, srcLine, srcCol(, nameIdx)] segments per generated line.

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

describe('sourcemap — dev transform() round-trip', () => {
    /** true iff `token`'s occ-th appearance in the OUTPUT traces back to identical text in SOURCE. */
    const roundTrips = (filename: string, src: string, token: string, occ: number): boolean => {
        const r = transform(filename, src, { sourcemap: true });
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

    it('identifiers round-trip exactly through type stripping', () => {
        expect(roundTrips('a.ts', ts, 'greet', 1)).toBe(true);
        expect(roundTrips('a.ts', ts, 'name', 2)).toBe(true); // after a stripped `: string`
        expect(roundTrips('a.ts', ts, 'out', 1)).toBe(true);
        expect(roundTrips('a.ts', ts, 'greet', 2)).toBe(true); // line 2, after edits above
    });

    it('UTF-16 columns: identifiers after a non-BMP char round-trip', () => {
        // \u{1F600} = a grinning-face emoji: a surrogate PAIR, 2 UTF-16 code units. Escaped (not a
        // literal glyph) so the fixture is byte-exact regardless of file encoding. If columns were
        // counted in code POINTS not UTF-16 units, everything after it would be off by one and
        // these traces would land on the wrong text.
        const src = `const label = "\u{1F600} é x"; const tail: number = label.length;`;
        expect(roundTrips('u.ts', src, 'tail', 1)).toBe(true); // after the surrogate pair + a BMP accent
        expect(roundTrips('u.ts', src, 'label', 2)).toBe(true); // the `.length` reference, further right
    });

    it('sets sources + sourcesContent to the original file', () => {
        const r = transform('mod.ts', ts, { sourcemap: true });
        expect(r.map!.sources).toEqual(['mod.ts']);
        expect(r.map!.sourcesContent).toEqual([ts]);
        expect(r.map!.version).toBe(3);
    });

    it('plain JS yields an identity map (no edits)', () => {
        const src = 'const x = 1;\nexport const y = x + 1;';
        const r = transform('p.js', src, { sourcemap: true });
        expect(r.code).toBe(src);
        expect(roundTrips('p.js', src, 'y', 1)).toBe(true);
    });

    it('no map unless requested', () => {
        expect(transform('a.ts', ts, {}).map).toBeUndefined();
    });
});

describe('sourcemap — lowered constructs map coarsely to their construct (Level-1 limitation)', () => {
    // Lowered blobs (jsx()/enum IIFE/param-property insert) are ONE edit → their interior maps to
    // the construct's source start, not the inner expression. Coarse but never garbage/unmapped.
    const traceToken = (filename: string, src: string, token: string) => {
        const r = transform(filename, src, { sourcemap: true });
        expect(r.errors).toEqual([]);
        const gp = posOf(r.code, r.code.indexOf(token));
        return trace(r.map!.mappings, gp.line, gp.col);
    };

    it('JSX: interior maps to the element on the right source line', () => {
        const t = traceToken('c.tsx', 'export const El = () => <div id="x">{greet}</div>;', 'greet');
        expect(t).not.toBeNull();
        expect(t!.srcLine).toBe(0);
    });

    it('enum: the lowered runtime maps back onto the enum declaration line', () => {
        const t = traceToken('e.ts', 'const pad = 0;\nexport enum E { A, B }', 'E');
        expect(t).not.toBeNull();
        expect(t!.srcLine).toBe(1);
    });

    it('parameter property: class identifiers still round-trip; synthesized this.x maps into the ctor', () => {
        const src = 'export class C {\n  constructor(private x: number) {}\n}';
        const r = transform('pp.ts', src, { sourcemap: true });
        expect(r.errors).toEqual([]);
        // the class name round-trips exactly
        const cPos = posOf(r.code, r.code.indexOf('class C') + 6);
        const ct = trace(r.map!.mappings, cPos.line, cPos.col);
        expect(ct).not.toBeNull();
        expect(src.slice(offOf(src, ct!.srcLine, ct!.srcCol), offOf(src, ct!.srcLine, ct!.srcCol) + 1)).toBe('C');
        // the synthesized `this.x = x;` maps back to the constructor (source line 1), not nowhere
        const synth = r.code.indexOf('this.x');
        expect(synth).toBeGreaterThan(-1);
        const st = trace(r.map!.mappings, posOf(r.code, synth).line, posOf(r.code, synth).col);
        expect(st).not.toBeNull();
        expect(st!.srcLine).toBe(1);
    });
});

describe('sourcemap — runner transform + compose (the dev chain, §9-G)', () => {
    const original = 'export const greet = (n: string): string => "hi " + n;\nexport const x = greet("a");';

    it('strip → runner → compose maps a runner-output identifier back to the ORIGINAL source', () => {
        const strip = transform('m.ts', original, { sourcemap: true });
        const runner = moduleRunnerTransform('m.ts', strip.code, { sourcemap: true });
        expect(runner.map).toBeDefined();
        const full = composeSourceMaps(runner.map!, strip.map!);
        expect(full.sources).toEqual(['m.ts']);
        // `x` in the runner BODY (occ 3: skips the two in the synthetic `__shakeup.live({ x: () => x })`)
        const idx = nthIndex(runner.code, 'x', 3);
        const gp = posOf(runner.code, idx);
        const t = trace(full.mappings, gp.line, gp.col);
        expect(t).not.toBeNull();
        const off = offOf(original, t!.srcLine, t!.srcCol);
        expect(original.slice(off, off + 1)).toBe('x');
    });

    it('synthetic runner scaffolding (__shakeup.live) is unmapped', () => {
        const runner = moduleRunnerTransform('m.ts', transform('m.ts', original, { sourcemap: true }).code, { sourcemap: true });
        // the very first line is `__shakeup.live({...})` — a generated-only boundary
        expect(runner.code.split('\n')[0]).toContain('__shakeup.live');
        const t = trace(runner.map!.mappings, 0, 0);
        expect(t).toBeNull();
    });

    it('no runner map unless requested', () => {
        expect(moduleRunnerTransform('m.ts', 'export const a = 1;').map).toBeUndefined();
    });
});

describe('sourcemap — bundle() multi-module map', () => {
    const build = (sourcemap: boolean) =>
        bundle({
            entry: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "import { add } from './math';\nexport const r: number = add(2, 3);",
                '/math.ts': 'export const add = (a: number, b: number): number => a + b;',
            }),
            sourcemap,
        });

    it('each token traces to the correct module source at the right position', () => {
        const r = build(true);
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

    it('sourcesContent holds each module verbatim; synthetic export line is unmapped', () => {
        const r = build(true);
        expect(r.map!.sources).toEqual(['/math.ts', '/main.ts']);
        expect(r.map!.sourcesContent).toEqual([
            'export const add = (a: number, b: number): number => a + b;',
            "import { add } from './math';\nexport const r: number = add(2, 3);",
        ]);
        const exportLineIdx = r.code.split('\n').findIndex((l) => l.startsWith('export {'));
        expect(trace(r.map!.mappings, exportLineIdx, 0)).toBeNull();
    });

    it('no bundle map unless requested; enabling it does not change the code', () => {
        expect(build(false).map).toBeUndefined();
        expect(build(true).code).toBe(build(false).code);
    });
});
