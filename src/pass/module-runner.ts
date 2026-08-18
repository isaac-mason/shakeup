import { type Semantic, symbolOf } from '../analysis/semantic';
import { N, type Node, node, type Program, walk } from '../ast';
import { attrsHaveKeyAfterSpreadEmit } from '../jsx-text';
import { encodeMappings, joinParts, type Part, type SourceMap } from '../sourcemap';
import type { Pass } from './traverse';

/** HMR-accept metadata detected statically from `import.meta.hot.accept(...)`. */
export type RunnerHmr = { selfAccepts: boolean; acceptedDeps: string[] };

/**
 * Shared context for the dev module-runner lowering pass. Side outputs (deps, prelude, HMR)
 * accumulate here; the prelude (`__shakeup.live(...)`, `link` consts, `exportAll`) is text-assembled
 * after printing, following rolldown's `PrependRenderedImport` model — mutate the AST for the
 * structural body rewrites, prepend boilerplate as rendered text, never synthesise prelude AST.
 */
export type RunnerCtx = {
    code: string;
    semantic: Semantic;
    /** every name in the module, seeded for deconfliction of `_N` runtime locals */
    used: Set<string>;
    /** symbolId → the runtime member an import-bound reference lowers to */
    bindings: Map<number, ImportBinding>;
    /** call/tag callees needing `(0, …)` this-stripping when the callee is an import member */
    calleeIdents: Set<Node>;
    deps: string[];
    dynamicDeps: string[];
    importLines: string[];
    reExportLines: string[];
    exportEntries: string[];
    hmr: RunnerHmr;
    importIdx: number;
    // Detection folded into this traversal (was 2 standalone walks: scanJSX + collectUnsupported).
    hasJSX: boolean;
    needsCreateElement: boolean;
    /** start offsets of value `namespace` declarations (unsupported — dev errors on these). */
    unsupported: number[];
};

/** A local bound to an import: its runtime local + the imported name (`null` = namespace). */
type ImportBinding = { local: string; imported: string | null };

export function createRunnerCtx(code: string, semantic: Semantic): RunnerCtx {
    return {
        code,
        semantic,
        used: new Set(semantic.names.keys()),
        bindings: new Map(),
        calleeIdents: new Set(),
        deps: [],
        dynamicDeps: [],
        importLines: [],
        reExportLines: [],
        exportEntries: [],
        hmr: { selfAccepts: false, acceptedDeps: [] },
        importIdx: 0,
        hasJSX: false,
        needsCreateElement: false,
        unsupported: [],
    };
}

/** Assemble the runner output: prelude (`live`/imports/`exportAll`) + the printed body. Mirrors the
 *  edit engine's `assembleRunner` (non-sourcemap path). */
export function assembleRunner(ctx: RunnerCtx, body: string): string {
    const live = ctx.exportEntries.length > 0 ? `__shakeup.live({ ${ctx.exportEntries.join(', ')} });` : '';
    const parts: string[] = [];
    if (live !== '') parts.push(live);
    if (ctx.importLines.length > 0) parts.push(ctx.importLines.join('\n'));
    if (ctx.reExportLines.length > 0) parts.push(ctx.reExportLines.join('\n'));
    const b = body.trim();
    if (b !== '') parts.push(b);
    return `${parts.join('\n')}\n`;
}

/** Sourcemapped assembly: the prelude lines are generated-only (unmapped); the body {@link Part}
 *  carries the printer's during-walk map, and `joinParts` stacks them at the right line offset. */
export function assembleRunnerMapped(ctx: RunnerCtx, filename: string, bodyPart: Part): { code: string; map: SourceMap } {
    const live = ctx.exportEntries.length > 0 ? `__shakeup.live({ ${ctx.exportEntries.join(', ')} });` : '';
    const parts: Part[] = [];
    if (live !== '') parts.push({ code: live });
    if (ctx.importLines.length > 0) parts.push({ code: ctx.importLines.join('\n') });
    if (ctx.reExportLines.length > 0) parts.push({ code: ctx.reExportLines.join('\n') });
    if (bodyPart.code.trim() !== '') parts.push(bodyPart);
    const joined = joinParts(parts);
    const map: SourceMap = { version: 3, sources: [filename], sourcesContent: [ctx.code], names: [], mappings: encodeMappings(joined.map) };
    return { code: joined.code, map };
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const isIdentName = (s: string): boolean => IDENT_RE.test(s);
const strVal = (src: string, n: Node): string => src.slice(n.start + 1, n.end - 1);

function claim(ctx: RunnerCtx, base: string): string {
    let name = base;
    let i = 1;
    while (ctx.used.has(name)) name = `${base}${i++}`;
    ctx.used.add(name);
    return name;
}

// --- text prelude helpers (mirror the edit engine exactly, for parity) ---
const memberAccessText = (base: string, name: string): string =>
    isIdentName(name) ? `${base}.${name}` : `${base}[${JSON.stringify(name)}]`;
const memberOfText = (b: ImportBinding): string => (b.imported === null ? b.local : memberAccessText(b.local, b.imported));
function valueOfLocalText(ctx: RunnerCtx, sym: number, name: string): string {
    const b = ctx.bindings.get(sym);
    return b ? memberOfText(b) : name;
}
function addExport(ctx: RunnerCtx, exported: string, value: string): void {
    const key = isIdentName(exported) ? exported : JSON.stringify(exported);
    ctx.exportEntries.push(`${key}: () => ${value}`);
}
/** Link a re-export source; returns its runtime local (used only in getters / exportAll). */
function linkForText(ctx: RunnerCtx, spec: string): string {
    ctx.deps.push(spec);
    const local = claim(ctx, `_${ctx.importIdx++}`);
    ctx.importLines.push(`const ${local} = await __shakeup.link('${spec}');`);
    return local;
}
/** Link an injected runtime module (e.g. `react/jsx-runtime`) post-pass: claims a `_N` local,
 *  records the `link` prelude + dep, returns the local. For orchestrators that add runtime deps
 *  the source didn't import (JSX runtime). */
export function linkRuntime(ctx: RunnerCtx, spec: string): string {
    return linkForText(ctx, spec);
}

function collectBindingNames(pattern: Node, out: string[]): void {
    walk(pattern, (n) => {
        if (n.type === N.BindingIdentifier) {
            out.push(n.name);
            return false;
        }
        return true;
    });
}

// --- synthetic-node builders (spans collapse to the original site; leaves print verbatim) ---
const ident = (name: string, at: number): Node => node(N.IdentifierReference, at, at, name, null);
const identName = (name: string, at: number): Node => node(N.IdentifierName, at, at, name, null);
const member = (obj: Node, prop: Node, s: number, e: number): Node =>
    node(N.StaticMemberExpression, s, e, '', { object: obj, property: prop, optional: false });
const computed = (obj: Node, expr: Node, s: number, e: number): Node =>
    node(N.ComputedMemberExpression, s, e, '', { object: obj, expression: expr, optional: false });
const shakeupMember = (prop: string, s: number, e: number): Node => member(ident('__shakeup', s), identName(prop, e), s, e);

/** The runtime expression an import binding lowers to: `local`, `local.name`, or `local["n-m"]`. */
function memberOf(b: ImportBinding, s: number, e: number): Node {
    if (b.imported === null) return ident(b.local, s);
    if (isIdentName(b.imported)) return member(ident(b.local, s), identName(b.imported, e), s, e);
    return computed(ident(b.local, s), node(N.StringLiteral, s, e, JSON.stringify(b.imported), null), s, e);
}

/** `export default <anon>` → `const <dflt> = <expr>`. A bare declaration is re-tagged to its
 *  expression form; any other node is already an expression and used directly. */
function defaultConstDecl(decl: Node, dflt: string, s: number, e: number): Node {
    let init: Node;
    if (decl.type === N.FunctionDeclaration) {
        const d = decl.data;
        init = node(N.FunctionExpression, decl.start, decl.end, '', {
            id: d.id,
            typeParameters: d.typeParameters,
            params: d.params,
            returnType: d.returnType,
            body: d.body,
            async: d.async,
            generator: d.generator,
        });
    } else if (decl.type === N.ClassDeclaration) {
        const d = decl.data;
        init = node(N.ClassExpression, decl.start, decl.end, '', {
            id: d.id,
            typeParameters: d.typeParameters,
            superClass: d.superClass,
            superTypeArguments: d.superTypeArguments,
            implements: d.implements,
            body: d.body,
        });
    } else {
        init = decl;
    }
    const declarator = node(N.VariableDeclarator, s, e, '', {
        id: node(N.BindingIdentifier, s, s, dflt, null),
        typeAnnotation: null,
        init,
        definite: false,
    });
    return node(N.VariableDeclaration, s, e, '', { declarations: [declarator], kind: 'const', declare: false });
}

/** Statement-level restructuring: imports → bindings + `link` prelude (dropped); exports → `live`/
 *  `exportAll`/re-export prelude with declarations unwrapped back into the body. */
function processModuleStatements(ctx: RunnerCtx, program: Program): void {
    const body = program.data.body;
    const kept: Node[] = [];
    for (const stmt of body) {
        if (stmt.type === N.ImportDeclaration) {
            const d = stmt.data;
            if (d.importKind === 'type' || d.source.type !== N.StringLiteral) {
                kept.push(stmt);
                continue;
            }
            const spec = strVal(ctx.code, d.source);
            ctx.deps.push(spec);
            if (d.specifiers.length === 0) {
                ctx.importLines.push(`await __shakeup.link('${spec}');`); // side-effect import
                continue;
            }
            const local = claim(ctx, `_${ctx.importIdx++}`);
            for (const sp of d.specifiers) {
                if (sp.type === N.ImportSpecifier) {
                    if (sp.data.importKind === 'type') continue;
                    const imp = sp.data.imported;
                    const nm = imp.type === N.StringLiteral ? strVal(ctx.code, imp) : imp.name;
                    const sym = symbolOf(ctx.semantic, sp.data.local);
                    if (sym) ctx.bindings.set(sym, { local, imported: nm });
                } else if (sp.type === N.ImportDefaultSpecifier) {
                    const sym = symbolOf(ctx.semantic, sp.data.local);
                    if (sym) ctx.bindings.set(sym, { local, imported: 'default' });
                } else if (sp.type === N.ImportNamespaceSpecifier) {
                    const sym = symbolOf(ctx.semantic, sp.data.local);
                    if (sym) ctx.bindings.set(sym, { local, imported: null });
                }
            }
            ctx.importLines.push(`const ${local} = await __shakeup.link('${spec}');`);
            continue;
        }

        if (stmt.type === N.ExportNamedDeclaration) {
            if (stmt.data.exportKind === 'type') continue; // type-only export: erased
            const decl = stmt.data.declaration;
            if (decl !== null) {
                if (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration) {
                    if (decl.data.id !== null) addExport(ctx, decl.data.id.name, decl.data.id.name);
                } else if (decl.type === N.VariableDeclaration) {
                    for (const dr of decl.data.declarations) {
                        if (dr.type !== N.VariableDeclarator) continue;
                        const names: string[] = [];
                        collectBindingNames(dr.data.id, names);
                        for (const nm of names) addExport(ctx, nm, nm);
                    }
                } else if (decl.type === N.TSEnumDeclaration) {
                    // the printer lowers the enum; we register its live binding (strip drops `export`).
                    addExport(ctx, decl.data.id.name, decl.data.id.name);
                }
                kept.push(decl); // unwrap: strip the `export` keyword structurally
                continue;
            }
            if (stmt.data.source !== null) {
                if (stmt.data.source.type !== N.StringLiteral) {
                    kept.push(stmt);
                    continue;
                }
                const rel = linkForText(ctx, strVal(ctx.code, stmt.data.source));
                for (const sp of stmt.data.specifiers) {
                    if (sp.type !== N.ExportSpecifier || sp.data.exportKind === 'type') continue;
                    const exp = sp.data.exported;
                    const exported = exp.type === N.StringLiteral ? strVal(ctx.code, exp) : exp.name;
                    const loc = sp.data.local;
                    const localName = loc.type === N.StringLiteral ? strVal(ctx.code, loc) : loc.name;
                    addExport(ctx, exported, memberAccessText(rel, localName));
                }
                continue; // drop
            }
            for (const sp of stmt.data.specifiers) {
                if (sp.type !== N.ExportSpecifier || sp.data.exportKind === 'type') continue;
                const exp = sp.data.exported;
                const exportedName = exp.type === N.StringLiteral ? strVal(ctx.code, exp) : exp.name;
                const loc = sp.data.local;
                addExport(ctx, exportedName, valueOfLocalText(ctx, symbolOf(ctx.semantic, loc), loc.name));
            }
            continue; // drop
        }

        if (stmt.type === N.ExportDefaultDeclaration) {
            const decl = stmt.data.declaration;
            const named = (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration) && decl.data.id !== null;
            if (named) {
                addExport(ctx, 'default', (decl.data.id as Node).name);
                kept.push(decl); // unwrap the named declaration
            } else {
                const dflt = claim(ctx, '_default');
                addExport(ctx, 'default', dflt);
                kept.push(defaultConstDecl(decl, dflt, stmt.start, stmt.end));
            }
            continue;
        }

        if (stmt.type === N.ExportAllDeclaration) {
            if (stmt.data.source.type !== N.StringLiteral) {
                kept.push(stmt);
                continue;
            }
            const rel = linkForText(ctx, strVal(ctx.code, stmt.data.source));
            const exp = stmt.data.exported;
            if (exp !== null) addExport(ctx, exp.type === N.StringLiteral ? strVal(ctx.code, exp) : exp.name, rel);
            else ctx.reExportLines.push(`__shakeup.exportAll(${rel});`);
            continue; // drop
        }

        kept.push(stmt);
    }
    program.data.body = kept;
}

/** the `import.meta.hot.<name>` method of a call, or null (checked before `import.meta` rewrites). */
function hotMethod(call: Node): string | null {
    if (call.type !== N.CallExpression) return null;
    const callee = call.data.callee;
    if (callee.type !== N.StaticMemberExpression || callee.data.property.type !== N.IdentifierName) return null;
    const obj = callee.data.object;
    const isHot =
        obj.type === N.StaticMemberExpression &&
        obj.data.property.type === N.IdentifierName &&
        obj.data.property.name === 'hot' &&
        obj.data.object.type === N.ImportMeta;
    return isHot ? callee.data.property.name : null;
}

/**
 * The dev module-runner lowering pass. In ONE traversal: rewrites imports (→ `link` prelude +
 * bindings) and exports (→ `live`/`exportAll` prelude, declarations unwrapped) at `enter(Program)`;
 * import-bound references → member access (with `(0, …)` for import-member callees); `import.meta`
 * → `__shakeup.meta`; dynamic `import()` → `__shakeup.link()`; and detects `import.meta.hot.accept`.
 */
export const moduleRunnerPass: Pass<RunnerCtx> = {
    name: 'module-runner',
    enter: (n, ctx) => {
        switch (n.type) {
            case N.Program:
                processModuleStatements(ctx, n);
                return undefined;
            case N.CallExpression: {
                if (n.data.callee.type === N.IdentifierReference) ctx.calleeIdents.add(n.data.callee);
                const hm = hotMethod(n);
                if (hm === 'accept') {
                    const first = n.data.arguments[0];
                    if (first === undefined || first.type !== N.StringLiteral) {
                        if (first !== undefined && first.type === N.ArrayExpression) {
                            for (const el of first.data.elements) if (el !== null && el.type === N.StringLiteral) ctx.hmr.acceptedDeps.push(strVal(ctx.code, el));
                        } else ctx.hmr.selfAccepts = true;
                    } else ctx.hmr.acceptedDeps.push(strVal(ctx.code, first));
                } else if (hm === 'acceptExports') ctx.hmr.selfAccepts = true;
                return undefined;
            }
            case N.TaggedTemplateExpression:
                if (n.data.tag.type === N.IdentifierReference) ctx.calleeIdents.add(n.data.tag);
                return undefined;
            // Detection folded in (no separate scanJSX / collectUnsupported walk):
            case N.JSXElement:
            case N.JSXFragment:
                ctx.hasJSX = true;
                return undefined;
            case N.JSXOpeningElement:
                if (attrsHaveKeyAfterSpreadEmit(n.data.attributes)) ctx.needsCreateElement = true;
                return undefined;
            case N.TSModuleDeclaration:
                if (!n.data.declare) ctx.unsupported.push(n.start); // value namespace
                return undefined;
            case N.ImportMeta:
                return shakeupMember('meta', n.start, n.end);
            case N.ImportExpression: {
                const d = n.data;
                if (d.source.type === N.StringLiteral) ctx.dynamicDeps.push(strVal(ctx.code, d.source));
                return node(N.CallExpression, n.start, n.end, '', {
                    callee: shakeupMember('link', n.start, n.start),
                    arguments: d.options === null ? [d.source] : [d.source, d.options],
                    optional: false,
                    typeArguments: null,
                });
            }
            case N.ObjectProperty: {
                if (n.data.shorthand && n.data.value.type === N.IdentifierReference) {
                    if (ctx.bindings.get(symbolOf(ctx.semantic, n.data.value)) !== undefined) n.data.shorthand = false;
                }
                return undefined;
            }
            case N.IdentifierReference: {
                const b = ctx.bindings.get(symbolOf(ctx.semantic, n));
                if (b === undefined) return undefined;
                const m = memberOf(b, n.start, n.end);
                if (b.imported !== null && ctx.calleeIdents.has(n)) {
                    return node(N.SequenceExpression, n.start, n.end, '', {
                        expressions: [node(N.NumericLiteral, n.start, n.start, '0', null), m],
                    });
                }
                return m;
            }
            default:
                return undefined;
        }
    },
    exit: null,
};
