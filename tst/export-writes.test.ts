import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { N } from '../src/ast/index.ts';
import { analyze, createSemantic, parse } from '../src/ast.ts';
import { exportWrites } from '../src/parser/export-writes.ts';

/** The names a case writes, as source text, or 'uncertain' when the scanner declined to answer. */
function writes(source: string, names: string[]): string[] | 'uncertain' {
    const found = exportWrites(source, names);
    return found.uncertain ? 'uncertain' : found.writes.map((write) => source.slice(write.start, write.end));
}

describe('exportWrites', () => {
    const cases: [string, string[], string[] | 'uncertain'][] = [
        ['total = 1;', ['total'], ['total']],
        ['total += 1;', ['total'], ['total']],
        ['total ??= 1;', ['total'], ['total']],
        ['total **= 2;', ['total'], ['total']],
        ['total >>>= 2;', ['total'], ['total']],
        ['total++;', ['total'], ['total']],
        ['--total;', ['total'], ['total']],
        ['if (total == 1) {}', ['total'], []],
        ['x = total > 1 ? 2 : 3;', ['total'], []],

        // A member is not the binding, and the nearest operator is not an adjacent one.
        ['options.total = 1;', ['total'], []],
        ['this.#total = 1;', ['total'], []],
        ['a - total;', ['total'], []],
        ['a + total;', ['total'], []],
        ['++counts[total];', ['total'], []],
        ['this[total] = 1;', ['total'], []],

        // Literals hold text that looks like code.
        ['const s = "total = 1";', ['total'], []],
        ['const r = /total = 1/;', ['total'], []],
        // Built rather than written, so the template holes are not read as strings to lint.
        [`const t = \`\${a} total = 1 \${b}\`;`, ['total'], []],
        [`const t = \`x \${total = 1} y\`;`, ['total'], ['total']],
        // A comment ending in a full stop reads as a member access when scanned backwards.
        ['// requires an update.\ntotal = 1;', ['total'], ['total']],

        // Declarations bind, they do not assign, and rewriting one would not parse.
        ['let total = 1;', ['total'], []],
        ['let total = 1; total = 2;', ['total'], ['total']],
        ['var a = 1, total = 2; total = 3;', ['total'], ['total']],
        ['let q = 1; total = 2;', ['total'], ['total']],
        ['let a = 1\ntotal = 2;', ['total'], ['total']],
        ['const o = { total: 1 };', ['total'], []],

        // Shadowing, which is the whole reason a plain text search will not do.
        ['function f(total) { total = 2; }', ['total'], []],
        ['function f(a, total, b) { total = 2; }', ['total'], []],
        ['function f(a = 1, total) { total = 1; }', ['total'], []],
        ['function f(a, ...total) { total = 1; }', ['total'], []],
        ['function f({ total }) { total = 1; }', ['total'], []],
        ['function f() { var total; total = 2; }', ['total'], []],
        ['function f() { total = 2; var total; }', ['total'], []],
        ['function f() { total = 2; }', ['total'], ['total']],
        ['function f() { { let total; } total = 2; }', ['total'], ['total']],
        ['{ let total; total = 2; }', ['total'], []],
        ['try {} catch (total) { total = 1; }', ['total'], []],
        ['try {} catch (e) { total = 1; }', ['total'], ['total']],
        ['function f() { function total(){} total = 1; }', ['total'], []],

        // Module scope is not a shadowing scope: the declaration there is the export.
        ['function total() {} total = 2;', ['total'], ['total']],
        ['async function total() {} total = 2;', ['total'], ['total']],
        ['export default function total() {}; total = 2;', ['total'], ['total']],

        // An expression binds its name only inside itself.
        ['const g = function total() { total = 1; };', ['total'], []],
        ['Total = class Total { m() {} };', ['Total'], ['Total']],

        // Arrow parameters have no keyword to catch them.
        ['const uv = (total = 0) => new Node(total);', ['total'], []],
        // A concise body has no brace to hang a scope on, so a write in one is declined.
        ['const f = (total = 0) => (total = 1);', ['total'], 'uncertain'],
        ['const f = (total) => { total = 1; };', ['total'], []],
        ['const f = total => { total = 1; };', ['total'], []],

        // Class bodies declare fields and take method shorthand.
        ['class C { total = 1; }', ['total'], []],
        ['class C { [total] = 1; }', ['total'], []],
        ['class C { m() { total = 1; } }', ['total'], ['total']],
        ['class C { add(item, total = item.length) { return total; } }', ['total'], []],

        // Loops.
        ['for (total of xs) {}', ['total'], ['total']],
        ['for (let total of xs) { total = 1; }', ['total'], []],
        ['for (let i = 0, j = n - 1; i < n; j = i++) {}', ['i', 'j'], []],
        ['for (let i = 0; i < n; i++) { total = i; }', ['total'], ['total']],

        // Destructuring, which the AST pass this replaces missed entirely.
        ['[total] = pair;', ['total'], ['total']],
        ['({ total } = obj);', ['total'], ['total']],
        ['({ a: total } = obj);', ['total'], ['total']],
        ['({ total: other } = obj);', ['total'], []],
        ['const { total } = obj; total = 1;', ['total'], ['total']],
        ['const { total: other } = obj; total = 1;', ['total'], ['total']],
        ['const [, , total] = xs; total = 1;', ['total'], ['total']],
        ['function f() { const { total } = o; total = 1; }', ['total'], []],
    ];

    for (const [source, names, expected] of cases) {
        it(JSON.stringify(source), () => {
            expect(writes(source, names)).toEqual(expected);
        });
    }

    it('answers nothing for an empty name set without scanning', () => {
        expect(exportWrites('total = 1;', [])).toEqual({ writes: [], uncertain: false, reason: null });
    });
});

/**
 * Every assignment whose target is the module-scope binding of one of `names`, from a real parse
 * and real scope analysis. This is what the scanner replaces, so it is what the scanner is held to.
 */
function oracle(source: string, names: Set<string>): string[] {
    const parsed = parse(source, { ts: false, jsx: false, comments: false });
    const semantic = createSemantic();
    analyze(semantic, parsed.program as never, true);
    const program = parsed.program as never as { data: { body: Record<string, never>[] } };

    const moduleSyms = new Map<number, string>();
    const collect = (node: Record<string, never> | null) => {
        if (!node || typeof node.type !== 'number') return;
        if (node.type === N.BindingIdentifier && names.has(node.name) && node.sym) moduleSyms.set(node.sym, node.name);
        for (const value of Object.values(node.data ?? {})) {
            if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value.type === 'number') collect(value);
        }
    };
    for (const statement of program.data.body) {
        const data = statement.data as Record<string, never>;
        if (statement.type === N.VariableDeclaration) for (const d of data.declarations) collect(d.data.id);
        else if (statement.type === N.FunctionDeclaration || statement.type === N.ClassDeclaration) collect(data.id);
        else if (statement.type === N.ExportNamedDeclaration && data.declaration) {
            const declaration = data.declaration as Record<string, never>;
            if (declaration.type === N.VariableDeclaration) {
                for (const d of declaration.data.declarations) collect(d.data.id);
            } else collect(declaration.data.id);
        } else if (statement.type === N.ImportDeclaration) {
            for (const specifier of data.specifiers ?? []) collect(specifier.data.local);
        }
    }

    const sites: string[] = [];
    const visit = (node: Record<string, never> | null) => {
        if (!node || typeof node.type !== 'number') return;
        if (node.type === N.AssignmentExpression || node.type === N.UpdateExpression) {
            const target = (node.type === N.AssignmentExpression ? node.data.left : node.data.argument) as Record<
                string,
                never
            > | null;
            if (target?.type === N.IdentifierReference && target.sym && moduleSyms.has(target.sym)) {
                sites.push(`${target.start}:${target.end}`);
            } else if (
                target &&
                (target.type === N.ObjectExpression ||
                    target.type === N.ArrayExpression ||
                    target.type === N.ObjectPattern ||
                    target.type === N.ArrayPattern)
            ) {
                // A destructuring target parses as an object or array expression and carries no
                // symbol on the pattern itself, so the targets have to be found inside it.
                const inside = (n: Record<string, never> | null) => {
                    if (!n || typeof n.type !== 'number') return;
                    if ((n.type === N.IdentifierReference || n.type === N.BindingIdentifier) && n.sym && moduleSyms.has(n.sym)) {
                        sites.push(`${n.start}:${n.end}`);
                    }
                    // A default binds its left and reads its right.
                    if (n.type === N.AssignmentExpression || n.type === N.AssignmentPattern) return inside(n.data.left);
                    if (n.type === N.StaticMemberExpression || n.type === N.ComputedMemberExpression) return;
                    for (const value of Object.values(n.data ?? {})) {
                        if (Array.isArray(value)) value.forEach(inside);
                        else if (value && typeof value.type === 'number') inside(value);
                    }
                };
                inside(target);
            }
        }
        for (const value of Object.values(node.data ?? {})) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value.type === 'number') visit(value);
        }
    };
    visit(program as never);
    return sites.sort();
}

/** Every name the module binds at its top level, a far harder set than its real exports. */
function topLevelNames(source: string): Set<string> {
    const parsed = parse(source, { ts: false, jsx: false, comments: false });
    const names = new Set<string>();
    const collect = (node: Record<string, never> | null) => {
        if (!node || typeof node.type !== 'number') return;
        if (node.type === N.BindingIdentifier) names.add(node.name);
        for (const value of Object.values(node.data ?? {})) {
            if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value.type === 'number') collect(value);
        }
    };
    const program = parsed.program as never as { data: { body: Record<string, never>[] } };
    for (const statement of program.data.body) {
        const data = statement.data as Record<string, never>;
        if (statement.type === N.VariableDeclaration) for (const d of data.declarations) collect(d.data.id);
        else if (statement.type === N.FunctionDeclaration || statement.type === N.ClassDeclaration) collect(data.id);
        else if (statement.type === N.ExportNamedDeclaration && data.declaration) {
            const declaration = data.declaration as Record<string, never>;
            if (declaration.type === N.VariableDeclaration) {
                for (const d of declaration.data.declarations) collect(d.data.id);
            } else collect(declaration.data.id);
        }
    }
    return names;
}

function corpus(limit: number): string[] {
    const root = fileURLToPath(new URL('../node_modules', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (files.length >= limit || depth > 5) return;
        let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>> | undefined;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= limit) return;
            const path = join(dir, entry.name);
            // pnpm's node_modules is a farm of symlinks, which isDirectory reports false for.
            if (entry.isDirectory() || entry.isSymbolicLink()) walk(path, depth + 1);
            else if (entry.name.endsWith('.js')) files.push(path);
        }
    };
    walk(root, 0);
    return files.map((file) => readFileSync(file, 'utf8')).filter((source) => source.length < 2_000_000);
}

/**
 * The scanner against the analysis it replaces, over whatever real code is installed.
 *
 * Every name a module binds at its top level is tracked, not just the ones it exports, so the
 * shadowing question is asked far more often than a real lowering would ask it. Disagreement is
 * the failure: a missed write leaves an importer holding a stale value, and an invented one
 * publishes a local under an exported name, and neither says anything at the time.
 */
describe('exportWrites against parse and analyze', () => {
    const sources = corpus(300);

    it('finds a corpus to check against', () => {
        expect({ root: fileURLToPath(new URL('../node_modules', import.meta.url)), found: sources.length }).toMatchObject({
            found: expect.any(Number),
        });
        expect(sources.length).toBeGreaterThan(20);
    });

    it('agrees on every module it does not decline', () => {
        const disagreements: string[] = [];
        let checked = 0;
        let declined = 0;
        let sites = 0;
        let unparsed = 0;

        for (const source of sources) {
            let names: Set<string>;
            let expected: string[];
            try {
                names = topLevelNames(source);
                expected = oracle(source, names);
            } catch {
                // Counted, not swallowed: an oracle that throws on everything would otherwise
                // leave this test asserting nothing at all, which it did.
                unparsed++;
                continue;
            }
            const found = exportWrites(source, [...names]);
            if (found.uncertain) {
                declined++;
                continue;
            }
            checked++;
            sites += expected.length;
            const actual = found.writes.map((write) => `${write.start}:${write.end}`).sort();
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                const missing = expected.filter((site) => !actual.includes(site));
                const extra = actual.filter((site) => !expected.includes(site));
                const show = (site: string) =>
                    JSON.stringify(source.slice(Math.max(0, +site.split(':')[0] - 60), +site.split(':')[1]));
                disagreements.push(
                    [...missing.map((site) => `missing ${show(site)}`), ...extra.map((site) => `invented ${show(site)}`)].join(
                        '\n',
                    ),
                );
            }
        }

        expect(unparsed).toBeLessThan(sources.length / 2);
        expect(checked).toBeGreaterThan(20);
        expect(sites).toBeGreaterThan(0);
        expect(disagreements.join('\n---\n')).toBe('');
        // Declining is sound but costs the caller a real parse, so a jump is worth noticing.
        expect(declined / (checked + declined)).toBeLessThan(0.2);
    });
});
