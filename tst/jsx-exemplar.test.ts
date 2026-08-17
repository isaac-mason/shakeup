import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'exemplar');

const SHIM_JS = `
export const Fragment = { $$frag: true };
function norm(t) { return t === Fragment ? 'Fragment' : t; }
function el(k, type, props, key) { return { k, type: norm(type), props: props ?? null, key: key === undefined ? null : key }; }
export function jsx(t, p, k) { return el('jsx', t, p, k); }
export function jsxs(t, p, k) { return el('jsxs', t, p, k); }
export function createElement(t, p, ...c) { return { k: 'ce', type: norm(t), props: p ?? null, c }; }
`;

function loadFixtures(): Record<string, string> {
    const map: Record<string, string> = {};
    const walkDir = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walkDir(full);
            else if (entry.endsWith('.ts') || entry.endsWith('.tsx'))
                map[`/${relative(FIXTURE_ROOT, full)}`] = readFileSync(full, 'utf8');
        }
    };
    walkDir(FIXTURE_ROOT);
    map['/react/jsx-runtime.ts'] = SHIM_JS;
    map['/react.ts'] = SHIM_JS;
    return map;
}

/** Plugin that maps the injected react runtime specifiers to fixture shim files;
 * returning null for everything else falls through to default relative resolution. */
const reactShimPlugin = {
    name: 'react-shim',
    resolveId(_ctx: unknown, spec: string): string | null {
        if (spec === 'react/jsx-runtime') return '/react/jsx-runtime.ts';
        if (spec === 'react') return '/react.ts';
        return null;
    },
};

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

describe('G-JSX-3: exemplar .tsx module bundles + executes', () => {
    const files = loadFixtures();
    const built = bundle({
        entry: '/widget.tsx',
        fs: createMemoryFs(files),
        external: ['node:path'],
        plugins: [reactShimPlugin],
    });

    it('bundles with no errors', async () => {
        expect((await built).errors).toEqual([]);
    });

    it('executes the JSX component against the shim', async () => {
        const mod = await run((await built).code);
        type Tree = { k: string; type: unknown; key?: unknown; props: Record<string, unknown> };
        const Panel = mod.Panel as (p: { rows: { id: number; label: string }[]; particle: { motion: number } }) => Tree;
        const tree = Panel({
            rows: [
                { id: 1, label: 'a' },
                { id: 2, label: 'b' },
            ],
            particle: { motion: 0 },
        });
        expect(tree.k).toBe('jsxs');
        expect(tree.type).toBe('Fragment');
        const kids = tree.props.children as Tree[];
        const header = kids[0];
        expect(header.type).toBe('header');
        const headerKids = header.props.children as Tree[];
        const h1 = headerKids[0];
        expect(h1.type).toBe('h1');
        expect(h1.props.children).toEqual(['Motion: ', 'STATIC']);
        const badge = headerKids[1];
        expect(typeof badge.type).toBe('function');
        expect(badge.props.kind).toBe('live');
        const ul = kids[1];
        expect(ul.type).toBe('ul');
        const items = ul.props.children as Tree[];
        expect(items.map((i) => i.key)).toEqual([1, 2]);
        expect(items.map((i) => i.props.children)).toEqual(['a', 'b']);
        expect(items.map((i) => i.props['data-id'])).toEqual([1, 2]);
    });

    it('the enum lowering still works through the tsx graph (motion.ts unchanged)', async () => {
        expect((await built).code).toContain('MotionType');
    });

    it('EXISTING exemplar output is unaffected by JSX machinery (no-tsx build stable)', async () => {
        const tsOnly: Record<string, string> = {};
        for (const [k, v] of Object.entries(files)) if (k.endsWith('.ts')) tsOnly[k] = v;
        const withJsxOpts = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs(tsOnly),
            external: ['node:path'],
            plugins: [reactShimPlugin],
            jsx: { importSource: 'react', pure: true },
        });
        const plain = await bundle({ entry: '/main.ts', fs: createMemoryFs(tsOnly), external: ['node:path'] });
        expect(withJsxOpts.errors).toEqual([]);
        expect(withJsxOpts.code).toBe(plain.code);
        expect(withJsxOpts.code).not.toContain('jsx-runtime');
        expect(withJsxOpts.code).not.toMatch(/\bjsx\(/);
    });
});
