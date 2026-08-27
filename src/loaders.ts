import type { ModuleType } from './plugin';

/** Words that cannot be a `var` binding name. Only the ones that are reserved in *any* mode — a
 *  generated module is ESM and therefore strict, so the strict-only reservations count too. */
const RESERVED = new Set([
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'interface',
    'let',
    'new',
    'null',
    'package',
    'private',
    'protected',
    'public',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
]);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Is `k` usable verbatim as both a binding name and an export name? */
const isPlainIdent = (k: string): boolean => IDENT.test(k) && !RESERVED.has(k);

/**
 * Compile a non-JavaScript module to ES module SOURCE, for the rest of the pipeline to parse
 * normally. Returns `null` when the type is already JavaScript.
 *
 * Source-to-source rather than a synthetic AST, because that is what makes the module ORDINARY:
 * tree-shaking, constant folding and inlining all apply to it with no special cases. rolldown does
 * the same — its JSON output is one `var` per top-level key plus an object literal for `default`,
 * and `import d from './d.json'; d.used` folds all the way to `const x = 1`. Emitting a single
 * opaque object literal instead would keep every unused key alive.
 */
export function compileToModule(
    type: ModuleType | undefined,
    source: string,
    id: string,
): { code: string } | { error: string } | null {
    if (type !== 'json') return null;

    let value: unknown;
    try {
        value = JSON.parse(source) as unknown;
    } catch (e) {
        // A JSON syntax error reported AS a JSON error. Before the loader existed the file went
        // straight to the JavaScript parser and produced `expected ';'`, which points at the right
        // file for the wrong reason.
        return { error: `${id}: invalid JSON — ${String((e as Error).message)}` };
    }

    // Only a plain object gets per-key bindings; an array or a primitive has no keys to name, so it
    // is a default export and nothing else. (`typeof null === 'object'`, hence the null check.)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { code: `export default ${JSON.stringify(value)};\n` };
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const lines: string[] = [];
    const members: string[] = [];
    const exports: string[] = [];
    // Seeded with the default binding's own name: a key literally called `default` sanitises to
    // `_default` and silently redeclared it, so `import d from './x.json'; d.default` read the wrong
    // value. Any collision falls through to the positional `_jsonN` form below.
    const DEFAULT_BINDING = '_default';
    const taken = new Set<string>([DEFAULT_BINDING]);
    entries.forEach(([key, v], i) => {
        // A binding name that is stable, unique, and never a reserved word. A key that is not a
        // plain identifier is exported under its literal string name — `export { _a_b as "a-b" }` —
        // which is what arbitrary module namespace names are for.
        let name = isPlainIdent(key) ? key : `_${key.replace(/[^A-Za-z0-9_$]/g, '_')}`;
        if (!IDENT.test(name) || RESERVED.has(name) || taken.has(name)) name = `_json${i}`;
        taken.add(name);
        lines.push(`var ${name} = ${JSON.stringify(v)};`);
        // `__proto__` as a literal key SETS THE PROTOTYPE; a computed key does not. Without this a
        // `{"__proto__": …}` JSON file silently produced an object with a mangled prototype instead
        // of a `__proto__` property.
        members.push(key === '__proto__' ? `['__proto__']: ${name}` : `${JSON.stringify(key)}: ${name}`);
        // A key literally named `default` is NOT re-exported by name: the module already has a
        // `default` export (the whole document), and emitting `export { x as "default" }` alongside
        // it is a duplicate. It is still reachable through that default object — which is also what
        // Node gives you for a JSON module. Caught by a test that read `[undefined, undefined,
        // undefined]` once every key started being exported.
        if (key === 'default') return;
        exports.push(isPlainIdent(key) && name === key ? key : `${name} as ${JSON.stringify(key)}`);
    });
    lines.push(`var ${DEFAULT_BINDING} = { ${members.join(', ')} };`);
    lines.push(`export default ${DEFAULT_BINDING};`);
    if (exports.length > 0) lines.push(`export { ${exports.join(', ')} };`);
    return { code: `${lines.join('\n')}\n` };
}
