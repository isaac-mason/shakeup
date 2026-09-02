// Comment preservation, against the policy the three references actually implement — measured by
// bundling the same file with each, not read off their docs:
//
//                legal `/*!`      jsdoc `/**`   annotation   normal
//   rollup       kept in place    kept          kept         KEPT
//   rolldown     kept inline      kept          kept         dropped
//   esbuild      MOVED TO EOF     DROPPED       kept         dropped
//
// rollup keeps everything because it is SOURCE-PRESERVING — magic-string slices the original text, so
// it never faces the attachment problem at all. esbuild and rolldown print from an AST and must
// re-attach each comment to a node; esbuild optimises for size, rolldown for rollup compatibility.
//
// shakeup prints from an AST and replaces rolldown, so **rolldown's policy is the target**. Not
// esbuild's: relocating legal comments to EOF is a size-driven call, and dropping JSDoc would be a
// regression against rollup for anyone bundling a library.
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

const build = async (files: Record<string, string>, output?: Record<string, unknown>) => {
    const fs = createMemoryFs(files);
    const out = await bundle({ input: '/a.js', fs, ...(output ? { output } : {}) } as never);
    return (out as { chunks: { code: string }[] }).chunks[0].code;
};

const SRC = `/*! @license MIT */
/** Adds two numbers. */
export function add(a, b) { return a + b; }
// an ordinary comment
export const v = /*@__PURE__*/ add(1, 2);
/* a normal block comment */
export const w = 3;
`;

describe('the default matches rolldown', () => {
    it('keeps legal, jsdoc and annotation; drops normal', async () => {
        const code = await build({ '/a.js': SRC });
        expect(code).toContain('/*! @license MIT */');
        expect(code).toContain('/** Adds two numbers. */');
        expect(code).toContain('/* @__PURE__ */');
        expect(code).not.toContain('an ordinary comment');
        expect(code).not.toContain('a normal block comment');
    });

    it('a `//!` line comment is legal too', async () => {
        expect(await build({ '/a.js': '//! legal line\nexport const a = 1;\n' })).toContain('//! legal line');
    });
});

describe('the option', () => {
    it('`comments: false` keeps neither', async () => {
        const code = await build({ '/a.js': SRC }, { comments: false });
        expect(code).not.toContain('@license');
        expect(code).not.toContain('Adds two numbers');
        // The annotation is NOT a retained comment — it is reconstructed from the node's `pure` flag,
        // the same path oxc falls back to when it cannot recover verbatim source. So it survives.
        expect(code).toContain('/* @__PURE__ */');
    });

    it('`comments: { jsdoc: false }` keeps legal only', async () => {
        const code = await build({ '/a.js': SRC }, { comments: { jsdoc: false } });
        expect(code).toContain('@license');
        expect(code).not.toContain('Adds two numbers');
    });
});

describe('a legal comment outlives its anchor', () => {
    // THE case the feature exists for. oxc keeps a sorted list of legal anchors and drains it at
    // statement boundaries (`preserve_when_orphaned` / `print_orphan_comments_before`,
    // `codegen/src/comment.rs:17,262`) precisely so a licence survives when the code it sat above is
    // tree-shaken. Without it the feature is wrong in exactly the situation that matters.
    const LIB = '/*! @license MIT */\nexport function dead() { return 2; }\nexport function used() { return 1; }\n';
    const ENTRY = "import { used } from './l.js';\nconsole.log(used());\n";

    it('survives its statement being tree-shaken', async () => {
        const code = await build({ '/a.js': ENTRY, '/l.js': LIB });
        expect(code).toContain('/*! @license MIT */');
        expect(code).not.toContain('dead');
    });

    it('but JSDoc does NOT — only legal comments are orphan-preserved', async () => {
        const jsdocLib = '/** doc */\nexport function dead() { return 2; }\nexport function used() { return 1; }\n';
        const code = await build({ '/a.js': ENTRY, '/l.js': jsdocLib });
        expect(code).not.toContain('doc');
    });

    it('survives MINIFICATION, which is the whole point of "legal"', async () => {
        const code = await build({ '/a.js': '//! legal line\nexport const a = 1;\n' }, { minify: true });
        expect(code).toContain('//! legal line');
        // A `//` comment must be followed by a newline or it swallows the code after it.
        expect(code).toMatch(/^\/\/! legal line\n/);
    });
});

describe('a source-mapping comment is dropped, never re-emitted', () => {
    // It would collide with the map the bundler appends. `classifyComment` gives it its own kind for
    // this reason, and it is never in the printable set.
    it.each(['//# sourceMappingURL=old.map\nexport const a = 1;\n', '//# sourceURL=x.js\nexport const a = 1;\n'])(
        '%s',
        async (src) => {
            const code = await build({ '/a.js': src });
            expect(code).not.toContain('sourceMappingURL=old.map');
            expect(code).not.toContain('sourceURL=x.js');
        },
    );
});
