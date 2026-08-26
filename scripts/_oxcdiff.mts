// Differential: what does oxc's ACTUAL minifier emit vs ours, for constructs we suspect are gaps?
import { minifySync as minify } from 'oxc-minify';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const CASES: [string, string][] = [
    ['"a".concat("b")', 'o = "a".concat("b");'],
    ['Array.of(1,2)', 'o = Array.of(1, 2);'],
    ['Number.NaN', 'o = Number.NaN;'],
    ['Number.POSITIVE_INFINITY', 'o = Number.POSITIVE_INFINITY;'],
    ['Number.MAX_SAFE_INTEGER', 'o = Number.MAX_SAFE_INTEGER;'],
    ['Number.EPSILON', 'o = Number.EPSILON;'],
    ['/ab+/.source', 'o = /ab+/.source;'],
    ['while(true)', 'while (true) { o = a; if (a) break; }'],
    ['for(;true;)', 'for (; true;) { o = a; if (a) break; }'],
    ['unused #priv', 'class C { #x = 1; m() { return 2; } } o = new C().m();'],
    ['if in for body', 'for (let i = 0; i < 3; i++) { if (a) o = i; }'],
];

for (const [label, body] of CASES) {
    const src = `const a = Number(globalThis.x);\nlet o;\n${body}\nglobalThis.sink = o;\n`;
    const ours0 = (await bundle({ entry: '/e.js', fs: createMemoryFs({ '/e.js': src }), external: [], output: { minify: true, optimize: true } } as never) as { code: string }).code;
    const oxc0 = minify('e.js', src, { compress: {}, mangle: true }).code;
    const strip = (c: string) => c.trim().replace(/\n/g, ' ')
        .replace(/(?:let|var|const) \w+=Number\(globalThis\.x\),?\s*/, '').replace(/;?globalThis\.sink=\w+;?/, '').replace(/^\w+;/, '');
    const ours = strip(ours0), oxc = strip(oxc0);
    const mark = ours === oxc ? ' ' : '!';
    console.log(`${mark} ${label.padEnd(24)}\n    ours: ${ours}\n    oxc : ${oxc}`);
}
