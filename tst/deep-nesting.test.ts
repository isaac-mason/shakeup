// The bundler used to recurse once per AST level in several walkers, so a deeply nested program
// overflowed the stack — and the ceiling MOVED whenever a node type was added, because a bigger
// schema-generated function means a bigger frame. Adding two node types was enough to take a
// previously-passing 300-level program below the line.
//
// Three walkers are iterative now: `walk` (src/ast/ast.ts), `walkRefIdents` (analysis/refs.ts) and
// the target/visit pair in analysis/ref-facts.ts. This pins the result well clear of the old cliff
// so the next node type cannot quietly reintroduce it.
//
// Measure with ONE cold call. A binary search warms the JIT with its earlier probes and reports ~25%
// high — 374 where the cold value was under 300. That mistake was made twice before it was noticed.
import { expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

const nested = (depth: number): string => {
    let body = 'let v0 = 1;\n';
    for (let i = 1; i <= depth; i++) body += `{ let v${i} = v${i - 1} + 1;\n`;
    return `${body}globalThis.sink = v${depth};\n${'}'.repeat(depth)}`;
};

it('bundles 1000 levels of nesting', async () => {
    const r = await bundle({
        entry: '/e.js',
        fs: createMemoryFs({ '/e.js': nested(1000) }),
        external: [],
        output: { minify: true, optimize: true },
    } as never);
    expect(r.errors ?? []).toEqual([]);
    expect(r.chunks.length).toBeGreaterThan(0);
}, 120000);
