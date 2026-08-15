import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const SHIM_JS = `
export const Fragment = { $$frag: true };
function el(k, type, props, key) { return { k, type, props: props ?? null, key: key ?? null }; }
export function jsx(t, p, k) { return el('jsx', t, p, k); }
export function jsxs(t, p, k) { return el('jsxs', t, p, k); }
export function createElement(t, p, ...c) { return { k: 'ce', type: t, props: p, c }; }
`;

const resolve = (spec: string): string | null =>
    spec === 'react/jsx-runtime' ? '/react/jsx-runtime.ts' : spec === 'react' ? '/react.ts' : null;

function build(main: string, opts: { pure?: boolean } = {}) {
    const files = { '/main.tsx': main, '/react/jsx-runtime.ts': SHIM_JS, '/react.ts': SHIM_JS };
    const r = bundle({
        entry: '/main.tsx',
        fs: createMemoryFs(files),
        external: [],
        resolve,
        jsx: opts.pure === undefined ? undefined : { pure: opts.pure },
    });
    expect(r.errors).toEqual([]);
    return r;
}

describe('G-JSX-5: shake interplay', () => {
    it('drops a dead `const x = <Foo/>` whose binding is unused', () => {
        const { code } = build(`
            function Foo() { return 'foo'; }
            const DEAD_UNUSED = <Foo className="marker-dead" />;
            export const kept = 1;
        `);
        expect(code).not.toContain('marker-dead');
        expect(code).not.toContain('DEAD_UNUSED');
    });

    it('keeps a used JSX value', () => {
        const { code } = build(`
            function Foo() { return 'foo'; }
            export const kept = <Foo className="marker-live" />;
        `);
        expect(code).toContain('marker-live');
        expect(code).toMatch(/jsx\(/);
        expect(code).toContain('$$frag');
    });

    it('keeps a JSX statement with an EFFECTFUL attribute expression', () => {
        const { code } = build(`
            function Foo(p) { return p; }
            let log = [];
            function sink() { log.push('ran'); return 1; }
            const x = <Foo value={sink()} />;
            export const kept = 2;
        `);
        expect(code).toContain('sink()');
    });

    it('a module whose JSX fully shakes away leaves no dangling runtime import', () => {
        const { code } = build(`
            function Foo() { return 'foo'; }
            const DEAD = <Foo />;
            export const kept = 99;
        `);
        expect(code).not.toMatch(/from ['"]react\/jsx-runtime['"]/);
        expect(code).not.toMatch(/\bjsx\(/);
        expect(code).not.toContain('$$frag');
    });

    it('pure:false keeps unused JSX (treated as effectful)', () => {
        const { code } = build(
            `
            function Foo() { return 'foo'; }
            const KEPT_BECAUSE_IMPURE = <Foo className="marker-impure" />;
            export const kept = 1;
        `,
            { pure: false },
        );
        expect(code).toContain('marker-impure');
    });

    it('EXTERNAL runtime: fully-shaken JSX drops the injected import; live keeps it', () => {
        const mk = (main: string) =>
            bundle({ entry: '/main.tsx', fs: createMemoryFs({ '/main.tsx': main }), external: ['react/jsx-runtime', 'react'] });
        const dead = mk(`function Foo(){}\nconst DEAD = <Foo/>;\nexport const kept = 1;`);
        expect(dead.code).not.toMatch(/from ['"]react\/jsx-runtime['"]/);
        const live = mk(`export const a = <div>{x}</div>;`);
        expect(live.code).toMatch(/from ['"]react\/jsx-runtime['"]/);
    });

    it('EXTERNAL runtime: an authored `react` import survives even when JSX shakes away', () => {
        const r = bundle({
            entry: '/main.tsx',
            fs: createMemoryFs({
                '/main.tsx': `import { useState } from 'react';\nfunction Foo(){}\nconst DEAD = <Foo/>;\nexport const s = useState(1);`,
            }),
            external: ['react/jsx-runtime', 'react'],
        });
        expect(r.code).toMatch(/import \{ useState \} from 'react'/);
        expect(r.code).not.toMatch(/from ['"]react\/jsx-runtime['"]/);
    });

    it('executes: live JSX renders, dead JSX absent', async () => {
        const { code } = build(`
            function Foo(p) { return p; }
            const DEAD = <Foo className="dead" />;
            export const live = <Foo className="live" />;
        `);
        const mod = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;
        expect((mod.live as { props: { className: string } }).props.className).toBe('live');
        expect(code).not.toContain('dead');
    });
});
