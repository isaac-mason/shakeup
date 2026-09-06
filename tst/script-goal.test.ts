import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

// The SCRIPT goal — what a `<script>` tag has, and what test262 means by "not a module". oxc's
// `SourceType::script()`. shakeup had `module`, `commonjs` and `unambiguous` and nothing for this,
// so the conformance harness was handing shakeup `unambiguous` while asking oxc for `script`: two
// different languages compared against each other, worth 14 of the parser-layer misses on its own.
//
// It is NOT CommonJS. A top-level `return` is legal in CJS only because Node wraps the body in a
// function, and `unambiguous` reads one as EVIDENCE of CJS — a Script has no wrapper, so the spec
// rejects it. Every rule below was verified against `oxc-parser` with `sourceType: 'script'` before
// it was written.
const errs = (src: string, kind: 'script' | 'module' | 'commonjs' | 'unambiguous') =>
    parse(src, { ts: false, jsx: false, kind }).errors;
const accepts = (src: string, kind: 'script' | 'module' | 'commonjs' | 'unambiguous') => errs(src, kind).length === 0;

describe('the script goal rejects what a Script may not contain', () => {
    it.each([
        ['a top-level return', 'return 1;'],
        ['new.target at top level', 'new.target;'],
        ['new.target in a top-level arrow', 'var f = () => new.target;'],
        ['import.meta', 'import.meta;'],
    ])('rejects %s', (_name, src) => {
        expect(accepts(src, 'script'), 'script rejects it').toBe(false);
        // CommonJS keeps `return` and `new.target` because Node's wrapper is a real function, and
        // `unambiguous` cannot know yet — so neither may be tightened by this.
        if (src !== 'import.meta;') expect(accepts(src, 'commonjs'), 'CommonJS still accepts it').toBe(true);
        expect(accepts(src, 'unambiguous'), 'unambiguous stays permissive').toBe(true);
    });

    it('still allows them where a Script genuinely may have them', () => {
        expect(accepts('function f() { return 1; }', 'script')).toBe(true);
        expect(accepts('function f() { new.target; }', 'script')).toBe(true);
    });
});

describe('the script goal keeps what only a MODULE may not contain', () => {
    // Three separate rules were keyed on `allowTopReturn`, which was the same test as "is a module"
    // only because that flag happened to be false for modules alone. Adding this goal broke all
    // three at once: `with` newly rejected 297 valid sloppy programs and HTML-like comments another
    // 6. Both are Script-legal and Module-illegal, so they are keyed on the goal being a MODULE now.
    it.each([
        ['a with statement', 'with ({}) { }'],
        ['an HTML close comment', 'var c = 0;\n/*\n*/-->\nc += 1;\n'],
        ['an HTML open comment', '<!-- comment\nvar x = 1;\n'],
    ])('accepts %s in a script and rejects it in a module', (_name, src) => {
        expect(accepts(src, 'script'), 'Annex B / sloppy Script permits it').toBe(true);
        expect(accepts(src, 'module'), 'a module does not').toBe(false);
        expect(accepts(src, 'unambiguous'), 'unambiguous is unchanged').toBe(true);
    });
});
