// Compile-time global replacement — esbuild/Vite `define`, ported from oxc's
// `oxc_transformer_plugins/src/replace_global_defines.rs` (which rolldown runs as step 2 of
// `pre_process_ecma_ast.rs`, BEFORE the TS/JSX transform).
//
// Substitution alone is only half the point: `process.env.NODE_ENV !== 'production'` becomes
// `"production" !== 'production'`, which fold-constants turns into `false` and dead-code then
// deletes the branch. That chain is why real dependencies get smaller instead of merely running —
// and on a browser target it is also why they RUN AT ALL, since `process` is not defined there.
//
// Two guards carry all the correctness:
//   1. Only FREE references are replaced (`sym === 0`), so a local `const process = …` shadowing the
//      global is untouched. oxc's `is_global_or_ambient_reference`.
//   2. Assignment targets are never replaced — `process.env.NODE_ENV = x` must not become
//      `"production" = x`. oxc uses an AST-node lock; the enter-order equivalent is used here.
import { N, type Node, node } from '../ast.ts';
import { parse } from '../parser/index.ts';
import { hookTable, type TransformCtx, type Visitor } from './traverse.ts';

/** A dotted key (`process.env.NODE_ENV`) split into its parts, innermost first: the parts are
 *  matched against a member chain from the OUTSIDE in, so `['NODE_ENV', 'env', 'process']`. */
type DotDefine = { parts: string[]; value: Node };

type Compiled = { idents: Map<string, Node>; dots: Map<string, DotDefine[]> };

/** Parse a define VALUE (JS source, e.g. `'"production"'` or `'false'`) into a template expression
 *  that is deep-copied into each replacement site. Matches esbuild/Vite: the value is code, not a
 *  string literal — which is why `NODE_ENV` must be written with its quotes included. */
function parseValue(src: string): Node | null {
    // PARENTHESIZED first: at statement position `{ a: 1 }` parses as a BLOCK, so an object-literal
    // define (`__CONFIG__: '{"a":1}'`) would silently be dropped. Wrapping forces expression
    // position. The bare form is kept as a fallback for values a wrap would break, such as one
    // ending in a line comment.
    for (const candidate of [`(${src})`, src]) {
        const { program, errors } = parse(candidate, { ts: false, jsx: false });
        if (errors.length > 0) continue;
        const body = program.data.body;
        if (body.length !== 1 || body[0].type !== N.ExpressionStatement) continue;
        return (body[0].data as { expression: Node }).expression;
    }
    return null;
}

/** Compile a `define` map once per build. Invalid values are dropped rather than throwing — a bad
 *  define should not take the whole build down, and the key simply stays unreplaced. */
export function compileDefines(defines: Record<string, string>): Compiled | null {
    const idents = new Map<string, Node>();
    const dots = new Map<string, DotDefine[]>();
    for (const [key, raw] of Object.entries(defines)) {
        const value = parseValue(raw);
        if (value === null) continue;
        const parts = key.split('.');
        if (parts.length === 1) {
            idents.set(key, value);
            continue;
        }
        // Bucket by the OUTERMOST property so a member-expression hit is one map lookup, not a scan
        // of every dotted key (oxc buckets the same way).
        const last = parts[parts.length - 1];
        const list = dots.get(last) ?? [];
        list.push({ parts: parts.slice().reverse(), value });
        dots.set(last, list);
    }
    return idents.size === 0 && dots.size === 0 ? null : { idents, dots };
}

/** Deep-copy a template so each site gets its own nodes (ids are minted fresh by `node`). */
function copyValue(t: Node): Node {
    // Leaf nodes (literals) carry no `data` at all — copy them by identity of shape, not by walking.
    if (t.data === null || t.data === undefined) return node(t.type, t.start, t.end, t.name, t.data as never);
    const d = t.data as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(d)) {
        const v = d[k];
        out[k] = Array.isArray(v) ? v.map((c) => (c === null ? null : copyValue(c as Node))) : v !== null && typeof v === 'object' ? copyValue(v as Node) : v;
    }
    return node(t.type, t.start, t.end, t.name, out as never);
}

/** Match a static member chain against `parts` (outermost first). The ROOT must be a free
 *  identifier — that is the shadowing guard, and it is why a local `process` is left alone. */
function chainMatches(n: Node, parts: string[]): boolean {
    let cur = n;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur.type !== N.StaticMemberExpression) return false;
        const d = cur.data as { object: Node; property: Node };
        if (d.property.name !== parts[i]) return false;
        cur = d.object;
    }
    return cur.type === N.IdentifierReference && cur.sym === 0 && cur.name === parts[parts.length - 1];
}

/** Nodes that sit in an assignment/update TARGET position and must never be substituted. Populated
 *  when the enclosing assignment is ENTERED, which precedes the target's own visit. */
let LOCKED: Set<Node> = new Set();

export function makeDefine(compiled: Compiled): Visitor {
    return {
        name: 'define',
        enter: hookTable({
            [N.Program]: () => {
                LOCKED = new Set();
            },
            [N.AssignmentExpression]: (n: Node) => {
                LOCKED.add((n.data as { left: Node }).left);
            },
            [N.UpdateExpression]: (n: Node) => {
                LOCKED.add((n.data as { argument: Node }).argument);
            },
            [N.StaticMemberExpression]: (n, ctx: TransformCtx) => {
                if (LOCKED.has(n)) return;
                const outer = (n.data as { property: Node }).property;
                if (outer.type !== N.IdentifierName && outer.type !== N.IdentifierReference) return;
                const candidates = compiled.dots.get(outer.name);
                if (candidates === undefined) return;
                for (const d of candidates) {
                    if (chainMatches(n, d.parts)) {
                        ctx.replaceWith(copyValue(d.value));
                        return;
                    }
                }
            },
            [N.IdentifierReference]: (n, ctx: TransformCtx) => {
                if (LOCKED.has(n) || n.sym !== 0) return; // bound to a real declaration: not a global
                const v = compiled.idents.get(n.name);
                if (v !== undefined) ctx.replaceWith(copyValue(v));
            },
        }),
        exit: null,
    };
}
