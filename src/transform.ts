import { analyze, createSemantic, type Semantic, symbolOf } from './analysis/semantic';
import { isTypeOnlyNode, N, type Node, node, type Program, set, walk } from './ast';
import { type JSXOptions, resolveJSXOptions } from './module-graph';
import { parse } from './parser';
import { makeJsxLower } from './passes/lower-jsx';
import { tsLower } from './passes/lower-ts';
import { tsStrip } from './passes/strip-ts';
import { traverse } from './passes/traverse';
import { printModule } from './print/print-js';
import { createPrinter, finishPrinter, printerPart } from './print/printer';
import { buildLineTable, encodeMappings, joinParts, type Part, type SourceMap } from './sourcemap';

/** Source language; selects TS-strip + JSX-lower behavior. Inferred from the
 *  filename extension when omitted. */
export type TransformLang = 'ts' | 'tsx' | 'js' | 'jsx';

/** HMR-accept metadata, detected statically from `import.meta.hot.accept(...)` so
 *  the dev server learns accept boundaries WITHOUT evaluating. `selfAccepts`: the
 *  module accepts its own updates (`accept()` / `accept(cb)`). `acceptedDeps`:
 *  specifiers from `accept('dep', cb)` / `accept([deps], cb)`. */
export type HmrInfo = { selfAccepts: boolean; acceptedDeps: string[] };

/** `map` is present iff `sourcemap` was set — it maps the runner output back to the
 *  original `source`. */
export type ModuleRunnerResult = {
    code: string;
    deps: string[];
    dynamicDeps: string[];
    errors: string[];
    hmr: HmrInfo;
    map?: SourceMap;
};

const TS_EXT = /\.(ts|mts|cts)$/;
const TSX_EXT = /\.tsx$/;
const JSX_EXT = /\.jsx$/;

function inferLang(filename: string): TransformLang {
    if (TSX_EXT.test(filename)) return 'tsx';
    if (TS_EXT.test(filename)) return 'ts';
    if (JSX_EXT.test(filename)) return 'jsx';
    return 'js';
}

const emptyResult = (errors: string[]): ModuleRunnerResult => ({
    code: '',
    deps: [],
    dynamicDeps: [],
    errors,
    hmr: { selfAccepts: false, acceptedDeps: [] },
});

// ---------------------------------------------------------------------------
// Runner-link: the structural rewrite that lowers a module into the `__shakeup.*`
// module-runner protocol (imports→`link`, exports→`live`, refs→member, import.meta,
// dynamic import, HMR). It's the dev path's LINKING STRATEGY — a single mutating
// traversal over the AST-as-IR, with JSX/unsupported detection folded in. Bundle uses
// a different link strategy (the printer's linkModule mode); this is dev's.
// ---------------------------------------------------------------------------

/** A local bound to an import: its runtime local + the imported name (`null` = namespace). */
type ImportBinding = { local: string; imported: string | null };

/**
 * Shared context for the runner-link traversal. Side outputs (deps, prelude, HMR) accumulate here;
 * the prelude (`__shakeup.live(...)`, `link` consts, `exportAll`) is text-assembled after printing,
 * following rolldown's `PrependRenderedImport` model — mutate the AST for the structural body
 * rewrites, prepend boilerplate as rendered text, never synthesise prelude AST.
 */
type RunnerCtx = {
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
    hmr: HmrInfo;
    importIdx: number;
    /** unsupported constructs (dev errors on these): start offset + reason. */
    unsupported: { pos: number; msg: string }[];
};

function createRunnerCtx(code: string, semantic: Semantic): RunnerCtx {
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
        unsupported: [],
    };
}

/** Assemble the runner output: prelude (`live`/imports/`exportAll`) + the printed body. */
function assembleRunner(ctx: RunnerCtx, body: string): string {
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
function assembleRunnerMapped(ctx: RunnerCtx, filename: string, bodyPart: Part): { code: string; map: SourceMap } {
    const live = ctx.exportEntries.length > 0 ? `__shakeup.live({ ${ctx.exportEntries.join(', ')} });` : '';
    const parts: Part[] = [];
    if (live !== '') parts.push({ code: live });
    if (ctx.importLines.length > 0) parts.push({ code: ctx.importLines.join('\n') });
    if (ctx.reExportLines.length > 0) parts.push({ code: ctx.reExportLines.join('\n') });
    if (bodyPart.code.trim() !== '') parts.push(bodyPart);
    const joined = joinParts(parts);
    const map: SourceMap = {
        version: 3,
        sources: [filename],
        sourcesContent: [ctx.code],
        names: [],
        mappings: encodeMappings(joined.map),
    };
    return { code: joined.code, map };
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const isIdentName = (s: string): boolean => IDENT_RE.test(s);
// Real StringLiterals slice from source; synthetic transform-injected nodes (collapsed span) carry
// the quoted value in `name` — fall back so injected imports (jsxLower runtime) link like any other.
const strVal = (src: string, n: Node): string => (n.end > n.start ? src.slice(n.start + 1, n.end - 1) : n.name.slice(1, -1));

function claim(ctx: RunnerCtx, base: string): string {
    let name = base;
    let i = 1;
    while (ctx.used.has(name)) name = `${base}${i++}`;
    ctx.used.add(name);
    return name;
}

// --- text prelude helpers ---
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

/** Retype an import-bound reference IN PLACE into its runtime member (`_0.foo` / `_0["n-m"]`), or
 *  rename for a namespace import (`ns` → `_0`, the local IS the namespace). */
function setMember(n: Node, b: ImportBinding): void {
    if (b.imported === null) {
        n.name = b.local;
        return;
    }
    if (isIdentName(b.imported)) {
        set(n, N.StaticMemberExpression, {
            object: ident(b.local, n.start),
            property: identName(b.imported, n.end),
            optional: false,
        });
    } else {
        set(n, N.ComputedMemberExpression, {
            object: ident(b.local, n.start),
            expression: node(N.StringLiteral, n.start, n.end, JSON.stringify(b.imported), null),
            optional: false,
        });
    }
}

/**
 * The runner-link visitor, applied by {@link walk} to every node. Mutates IN PLACE (via {@link set}):
 * imports/exports at `Program`, import-bound references → member access (with `(0, …)` for import-
 * member callees), `import.meta` → `__shakeup.meta`, dynamic `import()` → `__shakeup.link()`. Also
 * detects JSX / value-namespace / `import.meta.hot.accept`. Returns `false` to prune type-only
 * subtrees — the printer strips them, so there's nothing to rewrite inside.
 */
function runnerVisit(n: Node, ctx: RunnerCtx): boolean | void {
    switch (n.type) {
        case N.Program:
            processModuleStatements(ctx, n);
            return;
        case N.CallExpression: {
            if (n.data.callee.type === N.IdentifierReference) ctx.calleeIdents.add(n.data.callee);
            const hm = hotMethod(n);
            if (hm === 'accept') {
                const first = n.data.arguments[0];
                if (first === undefined || first.type !== N.StringLiteral) {
                    if (first !== undefined && first.type === N.ArrayExpression) {
                        for (const el of first.data.elements)
                            if (el !== null && el.type === N.StringLiteral) ctx.hmr.acceptedDeps.push(strVal(ctx.code, el));
                    } else ctx.hmr.selfAccepts = true;
                } else ctx.hmr.acceptedDeps.push(strVal(ctx.code, first));
            } else if (hm === 'acceptExports') ctx.hmr.selfAccepts = true;
            return;
        }
        case N.TaggedTemplateExpression:
            if (n.data.tag.type === N.IdentifierReference) ctx.calleeIdents.add(n.data.tag);
            return;
        case N.TSModuleDeclaration:
            if (!n.data.declare)
                ctx.unsupported.push({ pos: n.start, msg: 'value namespaces are not supported (use ES modules)' });
            return;
        case N.TSImportEqualsDeclaration:
            // Only the require() form survives lowering (entity/type forms are lowered away).
            if (n.data.moduleReference.type === N.TSExternalModuleReference)
                ctx.unsupported.push({
                    pos: n.start,
                    msg: 'import-equals with require() (CommonJS) is not supported (use ES modules)',
                });
            return;
        case N.ImportMeta:
            set(n, N.StaticMemberExpression, {
                object: ident('__shakeup', n.start),
                property: identName('meta', n.end),
                optional: false,
            });
            return;
        case N.ImportExpression: {
            const d = n.data;
            if (d.source.type === N.StringLiteral) ctx.dynamicDeps.push(strVal(ctx.code, d.source));
            set(n, N.CallExpression, {
                callee: shakeupMember('link', n.start, n.start),
                arguments: d.options === null ? [d.source] : [d.source, d.options],
                optional: false,
                pure: false,
                typeArguments: null,
            });
            return;
        }
        case N.ObjectProperty:
            if (n.data.shorthand && n.data.value.type === N.IdentifierReference) {
                if (ctx.bindings.get(symbolOf(ctx.semantic, n.data.value)) !== undefined) n.data.shorthand = false;
            }
            return;
        case N.IdentifierReference: {
            const b = ctx.bindings.get(symbolOf(ctx.semantic, n));
            if (b === undefined) return;
            if (b.imported !== null && ctx.calleeIdents.has(n)) {
                const m = memberOf(b, n.start, n.end);
                set(n, N.SequenceExpression, { expressions: [node(N.NumericLiteral, n.start, n.start, '0', null), m] });
                return;
            }
            setMember(n, b);
            return;
        }
    }
    if (isTypeOnlyNode(n.type)) return false; // prune type subtrees — nothing to rewrite inside
}

/** Lower a parsed module into the `__shakeup.*` runner protocol, in place, in ONE walk. */
function runnerLink(program: Program, ctx: RunnerCtx): void {
    walk(program, (n) => runnerVisit(n, ctx));
}

export type DevTransformOptions = { lang?: TransformLang; jsx?: JSXOptions; sourcemap?: boolean };

/**
 * The dev-path transform (Branch A): ONE parse → analyze → runner-link → print. TS-stripping and
 * JSX-lowering are printer concerns (config over the immutable AST); the structural runner rewrite
 * (`import`→`link`, exports→`live`, refs→member) is {@link runnerLink}, a single mutating traversal.
 * JSX is not a special case: the traversal rewrites component-tag references and the runtime is
 * linked + referenced as member text, so JSX/TSX costs a single parse+traversal+print.
 */
export function devTransform(filename: string, source: string, options: DevTransformOptions = {}): ModuleRunnerResult {
    const lang = options.lang ?? inferLang(filename);
    const ts = lang === 'ts' || lang === 'tsx';
    const jsx = lang === 'jsx' || lang === 'tsx';

    const { program, errors: parseErrors } = parse(source, { ts, jsx });
    const errors = parseErrors.map((e) => `${filename}:${e.pos}: ${e.msg}`);
    if (errors.length > 0) return emptyResult(errors);

    const semantic = createSemantic();
    analyze(semantic, program);
    // Transform stage: lower TS (enum/namespace) AND JSX to plain JS BEFORE the runner rewrite, so dev
    // and bundle lower through the same passes. jsxLower injects a real `import {…} from "…/jsx-runtime"`
    // that runnerLink then links like any import (its `_jsx` refs become `_N.jsx` member access).
    const passes = [tsLower];
    if (jsx) {
        const { importSource, pure } = resolveJSXOptions(options.jsx);
        passes.push(makeJsxLower(importSource, pure));
    }
    traverse(program, semantic, passes);
    traverse(program, semantic, [tsStrip]); // strip residual TS types (2nd traverse — see plan)

    const ctx = createRunnerCtx(source, semantic);
    runnerLink(program, ctx);
    if (ctx.unsupported.length > 0) {
        return emptyResult(ctx.unsupported.map(({ pos, msg }) => `${filename}:${pos}: ${msg}`));
    }

    const wantMap = options.sourcemap ?? false;
    // JSX is already lowered to calls, so the printer needs no JSX hook.
    const p = createPrinter(
        { minify: false },
        { srcLines: wantMap ? Uint32Array.from(buildLineTable(source)) : undefined, sourceIdx: 0 },
    );
    printModule(p, program);

    if (wantMap) {
        const { code, map } = assembleRunnerMapped(ctx, filename, printerPart(p));
        return { code, deps: ctx.deps, dynamicDeps: ctx.dynamicDeps, errors, hmr: ctx.hmr, map };
    }
    return { code: assembleRunner(ctx, finishPrinter(p)), deps: ctx.deps, dynamicDeps: ctx.dynamicDeps, errors, hmr: ctx.hmr };
}
