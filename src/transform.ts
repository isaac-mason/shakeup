import { walkRefIdents } from './analysis/refs';
import { analyze, createSemantic, type Semantic, symbolOf } from './analysis/semantic';
import { N, type Node, type Program, walk } from './ast';
import {
    applyEdits,
    buildLineTable,
    collectStripEdits,
    type Edit,
    type JSXLower,
    type MapCtx,
    renderEdits,
    renderMappedPart,
} from './emit';
import { collectUnsupported, type JSXOptions, resolveJSXOptions, scanJSX } from './module-graph';
import { parse } from './parser';
import { addLine, encodeMappings, joinParts, newMappings, type Part, type SourceMap } from './sourcemap';

/** Source language; selects TS-strip + JSX-lower behavior. Inferred from the
 *  filename extension when omitted. */
export type TransformLang = 'ts' | 'tsx' | 'js' | 'jsx';

/** Inputs to {@link transform}. `onlyRemoveTypeImports` is not a knob: shakeup
 *  never elides value imports (no strip-time liveness), so that guarantee holds
 *  unconditionally — matching how makecat configures oxc. */
export type TransformOptions = {
    lang?: TransformLang;
    jsx?: JSXOptions;
    /** Emit a source map (SMv3) mapping the output back to `filename`. */
    sourcemap?: boolean;
};

/** Output of {@link transform}: the stripped/lowered code plus diagnostics. On
 *  any error, `code` is empty — never emit code from an unreliable parse. `map`
 *  is present iff `options.sourcemap` was set and the parse succeeded. */
export type TransformOutput = {
    code: string;
    errors: string[];
    map?: SourceMap;
};

/**
 * Render `edits` over `srcCode`, prefixed by generated-only `prefix` (e.g. the JSX runtime
 * import), producing the code and — since `sourcemap` — an SMv3 map back to `filename`. The
 * prefix's lines are left unmapped (they have no source origin); the body maps at token
 * granularity. A single {@link renderEdits} walk produces the code and its map together.
 */
function finishWithMap(filename: string, prefix: string, srcCode: string, edits: Edit[], errors: string[]): TransformOutput {
    const seg = newMappings();
    let prefixLines = 0;
    for (let i = 0; i < prefix.length; i++) if (prefix.charCodeAt(i) === 10) prefixLines++;
    for (let i = 0; i < prefixLines; i++) addLine(seg);
    const m: MapCtx = { seg, srcIdx: 0, srcLine: 0, srcCol: 0, genLine: prefixLines, genCol: 0, lines: buildLineTable(srcCode) };
    const body = renderEdits(srcCode, edits, m);
    const map: SourceMap = {
        version: 3,
        sources: [filename],
        sourcesContent: [srcCode],
        names: [],
        mappings: encodeMappings(seg),
    };
    return { code: prefix + body, errors, map };
}

const TS_EXT = /\.(ts|mts|cts)$/;
const TSX_EXT = /\.tsx$/;
const JSX_EXT = /\.jsx$/;

function inferLang(filename: string): TransformLang {
    if (TSX_EXT.test(filename)) return 'tsx';
    if (TS_EXT.test(filename)) return 'ts';
    if (JSX_EXT.test(filename)) return 'jsx';
    return 'js';
}

/**
 * Per-module TS-strip + JSX-lower, with no graph or linking — the drop-in for
 * oxc's `transform` on makecat's dev path (Arc A1). One full parse, then the
 * shared emit walk strips types, lowers enums, lowers parameter properties, and
 * lowers JSX to automatic-runtime calls. Import/export statements are preserved
 * verbatim (moduleRunnerTransform rewrites them later); value imports are never
 * elided.
 *
 * Unsupported-but-parseable TS surfaces as an error rather than miscompiling:
 * value namespaces via {@link collectUnsupported}; decorators, `import =`, and
 * `export =` are already parse errors. Both feed `errors`.
 */
export function transform(filename: string, code: string, options: TransformOptions = {}): TransformOutput {
    const lang = options.lang ?? inferLang(filename);
    const ts = lang === 'ts' || lang === 'tsx';
    const jsx = lang === 'jsx' || lang === 'tsx';

    const { program, errors: parseErrors } = parse(code, { ts, jsx });
    const errors = parseErrors.map((e) => `${filename}:${e.pos}: ${e.msg}`);
    collectUnsupported(program, filename, errors);
    if (errors.length > 0) return { code: '', errors };

    // Plain JS with no JSX: nothing to strip or lower (map is identity).
    if (!ts && !jsx) return options.sourcemap ? finishWithMap(filename, '', code, [], errors) : { code, errors };

    const semantic = createSemantic();
    analyze(semantic, program);

    // Standalone JSX runtime injection. Bundle mode threads the runtime import
    // through record/link/deconflict; here there is no graph, so emit it as a
    // real import and reference fixed locals — exactly what the automatic runtime
    // does. Locals are deconflicted against every identifier in the module
    // (`semantic.names`), so they can't shadow user code.
    let runtimeImport = '';
    let jsxLower: JSXLower | null = null;
    if (jsx) {
        const { hasJSX, needsCreateElement } = scanJSX(program);
        if (hasJSX) {
            const { importSource } = resolveJSXOptions(options.jsx);
            const used = new Set(semantic.names.keys());
            const claim = (base: string): string => {
                let name = base;
                let i = 1;
                while (used.has(name)) name = `${base}${i++}`;
                used.add(name);
                return name;
            };
            const locals = {
                jsx: claim('_jsx'),
                jsxs: claim('_jsxs'),
                Fragment: claim('_Fragment'),
                createElement: needsCreateElement ? claim('_createElement') : '',
            };
            jsxLower = { renameIdent: () => null, runtimeName: (kind) => locals[kind] };
            runtimeImport = `import { jsx as ${locals.jsx}, jsxs as ${locals.jsxs}, Fragment as ${locals.Fragment} } from '${importSource}/jsx-runtime';\n`;
            if (needsCreateElement) {
                runtimeImport += `import { createElement as ${locals.createElement} } from '${importSource}';\n`;
            }
        }
    }

    const edits = collectStripEdits(program, code, false, null, jsxLower);
    if (options.sourcemap) return finishWithMap(filename, runtimeImport, code, edits, errors);
    return { code: runtimeImport + applyEdits(code, edits), errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// moduleRunnerTransform (Arc A2 spike) — rewrite ESM to shakeup's NATIVE module-
// runner form. NOT vite-coupled: our own protocol, our own runner (Arc A3).
// Operates on plain JS (makecat strips first).
//
// PROTOCOL. The runner wraps each module body in `async (__shakeup) => { … }` and
// injects one branded context object (double-underscore + product name = the
// "reserved, hands off" convention — `__webpack_require__` lineage — and the ONE
// name the runner can't per-module deconflict, so it must be branded):
//   __shakeup.link(spec)   → Promise<namespace>   — the one import primitive
//                                                     (static: `await`; dynamic: inline)
//   __shakeup.live({ n: () => local })             — live exports as lazy getters,
//                                                     ONE call (esbuild __export shape,
//                                                     leaner than vite's N defineProperty;
//                                                     lazy ⇒ circular-dep safe)
//   __shakeup.exportAll(ns)                        — copy ns's names as live exports
//                                                     (skip 'default' + already-defined;
//                                                     esbuild __reExport shape) — `export *`
//   __shakeup.meta         → import.meta           — `.url`, and `.hot` implements the
//                                                     STANDARD import.meta.hot HMR API
//                                                     (accept/dispose/invalidate/data…),
//                                                     supplied by the runner (A3)
// Import locals (`_0`, `_1`) are deconflicted against the module's identifiers, so
// short names are collision-safe without branding.
//
// COVERS: imports (named/default/namespace/side-effect) + reference rewrites (member
// access, this-preserving call wrap, shorthand expansion, scope shadowing free via
// symbolOf) + named/default exports + re-exports (`export … from`, `export *`,
// `export * as`) + deps/dynamicDeps + import.meta + dynamic import.

/** HMR-accept metadata, detected statically from `import.meta.hot.accept(...)` so
 *  the dev server learns accept boundaries WITHOUT evaluating (D1). `selfAccepts`:
 *  the module accepts its own updates (`accept()` / `accept(cb)`). `acceptedDeps`:
 *  specifiers from `accept('dep', cb)` / `accept([deps], cb)`. */
export type HmrInfo = { selfAccepts: boolean; acceptedDeps: string[] };

/** Output of {@link moduleRunnerTransform}. `map` (present iff `sourcemap` was set) maps the runner
 *  output back to the INPUT `code` — compose it with the strip map via `composeSourceMaps` for a
 *  map to the original source. */
export type ModuleRunnerResult = {
    code: string;
    deps: string[];
    dynamicDeps: string[];
    errors: string[];
    hmr: HmrInfo;
    map?: SourceMap;
};

const isIdentName = (s: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const strVal = (src: string, n: Node): string => src.slice(n.start + 1, n.end - 1);

/** Offset just past the leading `export` (and optional `default`) keyword(s) at
 *  `start`. Used to strip ONLY those keywords — a declaration node's start excludes
 *  a leading `async`, so blanking to `decl.start` would wrongly erase `async`. */
function exportKeywordEnd(code: string, start: number, includeDefault: boolean): number {
    let i = start + 'export'.length;
    if (includeDefault) {
        while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
        if (code.startsWith('default', i)) i += 'default'.length;
    }
    return i;
}

/** true for a `import.meta.hot` member expression. */
function isImportMetaHot(n: Node): boolean {
    return (
        n.type === N.StaticMemberExpression &&
        n.data.property.type === N.IdentifierName &&
        n.data.property.name === 'hot' &&
        n.data.object.type === N.ImportMeta
    );
}

/** the property name of a `<import.meta.hot>.<name>(...)` call, or null. */
function hotMethod(call: Node): string | null {
    if (call.type !== N.CallExpression) return null;
    const callee = call.data.callee;
    if (callee.type !== N.StaticMemberExpression || callee.data.property.type !== N.IdentifierName) return null;
    return isImportMetaHot(callee.data.object) ? callee.data.property.name : null;
}

/** A local bound to an import: its deconflicted runtime local + the imported name
 *  (`null` = namespace import → the local IS the namespace). */
type ImportBinding = { local: string; imported: string | null };

function collectBindingNames(pattern: Node, out: string[]): void {
    walk(pattern, (n) => {
        if (n.type === N.BindingIdentifier) {
            out.push(n.name);
            return false;
        }
        return true;
    });
}

type RunnerEdits = {
    edits: Edit[];
    exportEntries: string[];
    importLines: string[];
    reExportLines: string[];
    deps: string[];
    dynamicDeps: string[];
    hmr: HmrInfo;
};

/** Analyze a parsed module + collect the edits/prelude that rewrite it to the
 *  `__shakeup` protocol (imports→link, exports→live, refs→member, import.meta,
 *  dynamic import, HMR-accept detection). Pure over (program, semantic, code) — no
 *  parse. Shared by {@link moduleRunnerTransform} (standalone, on stripped JS) and
 *  {@link devTransform} (fused with the TS/JSX strip over ONE parse). TS `export
 *  enum` registers its live binding; the strip lowers the enum + drops the keyword. */
function collectRunnerEdits(program: Program, semantic: Semantic, code: string): RunnerEdits {
    // Deconflict runtime locals against every identifier in the module.
    const used = new Set(semantic.names.keys());
    const claim = (base: string): string => {
        let name = base;
        let i = 1;
        while (used.has(name)) name = `${base}${i++}`;
        used.add(name);
        return name;
    };

    const bindings = new Map<number, ImportBinding>();
    const importLines: string[] = [];
    const reExportLines: string[] = [];
    const exportEntries: string[] = [];
    const deps: string[] = [];
    const dynamicDeps: string[] = [];
    const edits: Edit[] = [];
    let importIdx = 0;

    // `base.name` or `base['name']` depending on whether `name` is an identifier.
    const memberAccess = (base: string, name: string): string =>
        isIdentName(name) ? `${base}.${name}` : `${base}[${JSON.stringify(name)}]`;
    // The expression an import binding rewrites to (`_0`, `_0.foo`, `_0['x']`).
    const memberOf = (b: ImportBinding): string => (b.imported === null ? b.local : memberAccess(b.local, b.imported));
    // A synthetic runtime link for a re-export source; returns its local var. Used
    // only in export getters / exportAll, not referenced in the body.
    const linkFor = (spec: string): string => {
        deps.push(spec);
        const local = claim(`_${importIdx++}`);
        importLines.push(`const ${local} = await __shakeup.link('${spec}');`);
        return local;
    };
    // The value of an exported local: the import expr if it's an import, else itself.
    const valueOfLocal = (sym: number, name: string): string => {
        const b = bindings.get(sym);
        return b ? memberOf(b) : name;
    };
    const addExport = (exported: string, value: string): void => {
        const key = isIdentName(exported) ? exported : JSON.stringify(exported);
        exportEntries.push(`${key}: () => ${value}`);
    };

    // Pre-pass: call-callee idents (this-preservation), dynamic import, import.meta,
    // and static HMR-accept detection (D1).
    const calleeIdents = new Set<Node>();
    const hmr: HmrInfo = { selfAccepts: false, acceptedDeps: [] };
    walk(program, (n) => {
        if (n.type === N.CallExpression && n.data.callee.type === N.IdentifierReference) {
            calleeIdents.add(n.data.callee);
        } else if (n.type === N.TaggedTemplateExpression && n.data.tag.type === N.IdentifierReference) {
            calleeIdents.add(n.data.tag); // `tag`...`` needs the same this-preservation
        } else if (n.type === N.ImportExpression) {
            edits.push({ start: n.start, end: n.start + 'import'.length, text: '__shakeup.link' });
            if (n.data.source.type === N.StringLiteral) dynamicDeps.push(strVal(code, n.data.source));
        } else if (n.type === N.ImportMeta) {
            edits.push({ start: n.start, end: n.end, text: '__shakeup.meta' });
        } else if (n.type === N.CallExpression && hotMethod(n) === 'accept') {
            const first = n.data.arguments[0];
            if (first === undefined || first.type !== N.StringLiteral) {
                // accept() / accept(cb) → self-accept. accept([deps], cb) handled below.
                if (first !== undefined && first.type === N.ArrayExpression) {
                    for (const el of first.data.elements) {
                        if (el !== null && el.type === N.StringLiteral) hmr.acceptedDeps.push(strVal(code, el));
                    }
                } else {
                    hmr.selfAccepts = true;
                }
            } else {
                hmr.acceptedDeps.push(strVal(code, first)); // accept('dep', cb)
            }
        } else if (n.type === N.CallExpression && hotMethod(n) === 'acceptExports') {
            hmr.selfAccepts = true; // acceptExports is a self-accepting boundary
        }
    });

    // Statement pass: imports (hoist), exports (band + strip), leave the rest.
    for (const stmt of program.data.body) {
        if (stmt.type === N.ImportDeclaration) {
            if (stmt.data.importKind === 'type' || stmt.data.source.type !== N.StringLiteral) continue;
            const spec = strVal(code, stmt.data.source);
            deps.push(spec);
            edits.push({ start: stmt.start, end: stmt.end });
            if (stmt.data.specifiers.length === 0) {
                importLines.push(`await __shakeup.link('${spec}');`); // side-effect import
                continue;
            }
            const local = claim(`_${importIdx++}`);
            for (const sp of stmt.data.specifiers) {
                if (sp.type === N.ImportSpecifier) {
                    if (sp.data.importKind === 'type') continue;
                    const imp = sp.data.imported;
                    const nm = imp.type === N.StringLiteral ? strVal(code, imp) : imp.name;
                    const sym = symbolOf(semantic, sp.data.local);
                    if (sym) bindings.set(sym, { local, imported: nm });
                } else if (sp.type === N.ImportDefaultSpecifier) {
                    const sym = symbolOf(semantic, sp.data.local);
                    if (sym) bindings.set(sym, { local, imported: 'default' });
                } else if (sp.type === N.ImportNamespaceSpecifier) {
                    const sym = symbolOf(semantic, sp.data.local);
                    if (sym) bindings.set(sym, { local, imported: null });
                }
            }
            importLines.push(`const ${local} = await __shakeup.link('${spec}');`);
            continue;
        }

        if (stmt.type === N.ExportNamedDeclaration) {
            if (stmt.data.exportKind === 'type') continue;
            const decl = stmt.data.declaration;
            if (decl !== null) {
                const stripKeyword = () => edits.push({ start: stmt.start, end: exportKeywordEnd(code, stmt.start, false) });
                if (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration) {
                    stripKeyword();
                    if (decl.data.id !== null) addExport(decl.data.id.name, decl.data.id.name);
                } else if (decl.type === N.VariableDeclaration) {
                    stripKeyword();
                    for (const d of decl.data.declarations) {
                        if (d.type !== N.VariableDeclarator) continue;
                        const names: string[] = [];
                        collectBindingNames(d.data.id, names);
                        for (const nm of names) addExport(nm, nm);
                    }
                } else if (decl.type === N.TSEnumDeclaration) {
                    // fused path only (stripped JS has no enum node): the strip lowers
                    // the enum + drops its `export`; we just register the live binding.
                    if (decl.data.id !== null) addExport(decl.data.id.name, decl.data.id.name);
                }
                // interface / type alias: type-only — the strip blanks the whole stmt.
                continue;
            }
            if (stmt.data.source !== null) {
                if (stmt.data.source.type !== N.StringLiteral) continue;
                const rel = linkFor(strVal(code, stmt.data.source));
                for (const sp of stmt.data.specifiers) {
                    if (sp.type !== N.ExportSpecifier || sp.data.exportKind === 'type') continue;
                    const exp = sp.data.exported;
                    const exported = exp.type === N.StringLiteral ? strVal(code, exp) : exp.name;
                    const loc = sp.data.local;
                    const localName = loc.type === N.StringLiteral ? strVal(code, loc) : loc.name;
                    addExport(exported, memberAccess(rel, localName));
                }
                edits.push({ start: stmt.start, end: stmt.end });
                continue;
            }
            for (const sp of stmt.data.specifiers) {
                if (sp.type !== N.ExportSpecifier || sp.data.exportKind === 'type') continue;
                const exported = sp.data.exported;
                const exportedName = exported.type === N.StringLiteral ? strVal(code, exported) : exported.name;
                const local = sp.data.local;
                addExport(exportedName, valueOfLocal(symbolOf(semantic, local), local.name));
            }
            edits.push({ start: stmt.start, end: stmt.end });
            continue;
        }

        if (stmt.type === N.ExportDefaultDeclaration) {
            const decl = stmt.data.declaration;
            const named = (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration) && decl.data.id !== null;
            if (named) {
                edits.push({ start: stmt.start, end: exportKeywordEnd(code, stmt.start, true) });
                addExport('default', (decl.data.id as Node).name);
            } else {
                const dflt = claim('_default');
                edits.push({ start: stmt.start, end: exportKeywordEnd(code, stmt.start, true), text: `const ${dflt} = ` });
                addExport('default', dflt);
            }
            continue;
        }

        if (stmt.type === N.ExportAllDeclaration) {
            if (stmt.data.source.type !== N.StringLiteral) continue;
            const rel = linkFor(strVal(code, stmt.data.source));
            const exp = stmt.data.exported;
            if (exp !== null) {
                addExport(exp.type === N.StringLiteral ? strVal(code, exp) : exp.name, rel); // export * as foo
            } else {
                reExportLines.push(`__shakeup.exportAll(${rel});`); // export *
            }
            edits.push({ start: stmt.start, end: stmt.end });
        }
    }

    // Reference rewrites: every IdentifierReference that resolves to an import binding.
    walkRefIdents(program, (ident, shorthandProp) => {
        if (ident.type !== N.IdentifierReference) return;
        const b = bindings.get(symbolOf(semantic, ident));
        if (b === undefined) return;
        let val = memberOf(b);
        if (b.imported !== null && calleeIdents.has(ident)) val = `(0, ${val})`;
        edits.push({ start: ident.start, end: ident.end, text: shorthandProp !== null ? `${ident.name}: ${val}` : val });
    });

    return { edits, exportEntries, importLines, reExportLines, deps, dynamicDeps, hmr };
}

/** Assemble the runner prelude (`live`/imports/`exportAll`) + the edited body into
 *  the final output, with an optional source map back to `code`. */
function assembleRunner(
    filename: string,
    code: string,
    r: RunnerEdits,
    errors: string[],
    sourcemap?: boolean,
): ModuleRunnerResult {
    const { edits, exportEntries, importLines, reExportLines, deps, dynamicDeps, hmr } = r;
    const live = exportEntries.length > 0 ? `__shakeup.live({ ${exportEntries.join(', ')} });` : '';
    const imports = importLines.join('\n');
    const reExports = reExportLines.join('\n');

    if (sourcemap) {
        const bodyPart = renderMappedPart(code, edits, 0); // body maps back to `code`; synthetics don't
        const parts: Part[] = [];
        if (live !== '') parts.push({ code: live });
        if (imports !== '') parts.push({ code: imports });
        if (reExports !== '') parts.push({ code: reExports });
        if (bodyPart.code !== '') parts.push(bodyPart);
        const joined = joinParts(parts);
        const map: SourceMap = {
            version: 3,
            sources: [filename],
            sourcesContent: [code],
            names: [],
            mappings: encodeMappings(joined.map),
        };
        return { code: joined.code, deps, dynamicDeps, errors, hmr, map };
    }

    const body = applyEdits(code, edits).trim();
    const parts: string[] = [];
    if (live !== '') parts.push(live);
    if (imports !== '') parts.push(imports);
    if (reExports !== '') parts.push(reExports);
    if (body !== '') parts.push(body);
    return { code: `${parts.join('\n')}\n`, deps, dynamicDeps, errors, hmr };
}

const emptyResult = (errors: string[]): ModuleRunnerResult => ({
    code: '',
    deps: [],
    dynamicDeps: [],
    errors,
    hmr: { selfAccepts: false, acceptedDeps: [] },
});

/** Rewrite already-stripped ESM to the native `__shakeup.*` module-runner form.
 *  Standalone — parses `code` as plain JS. The dev path uses {@link devTransform}. */
export function moduleRunnerTransform(filename: string, code: string, options: { sourcemap?: boolean } = {}): ModuleRunnerResult {
    const { program, errors: parseErrors } = parse(code, { ts: false, jsx: false });
    const errors = parseErrors.map((e) => `${filename}:${e.pos}: ${e.msg}`);
    if (errors.length > 0) return emptyResult(errors);
    const semantic = createSemantic();
    analyze(semantic, program);
    return assembleRunner(filename, code, collectRunnerEdits(program, semantic, code), errors, options.sourcemap);
}

/** Inputs to {@link devTransform}. */
export type DevTransformOptions = { lang?: TransformLang; jsx?: JSXOptions; sourcemap?: boolean };

/**
 * The FUSED dev-path transform: TS/JSX strip + module-runner rewrite over a SINGLE
 * parse (P1) — the dev server's per-module transform. For NON-JSX modules the strip
 * edits + runner-rewrite edits are collected over one AST and applied together (one
 * parse instead of two). JSX modules fall back to the sequential 2-parse path
 * (`transform` → `moduleRunnerTransform`): JSX lowering generates runtime + component
 * references the runner-rewrite must also resolve, which the fused path doesn't do yet.
 */
export function devTransform(filename: string, source: string, options: DevTransformOptions = {}): ModuleRunnerResult {
    const lang = options.lang ?? inferLang(filename);
    const ts = lang === 'ts' || lang === 'tsx';
    const jsx = lang === 'jsx' || lang === 'tsx';

    const { program, errors: parseErrors } = parse(source, { ts, jsx });
    const errors = parseErrors.map((e) => `${filename}:${e.pos}: ${e.msg}`);
    collectUnsupported(program, filename, errors);
    if (errors.length > 0) return emptyResult(errors);

    // JSX: not yet fused — use the proven sequential path. No source map yet: it
    // would map runner-code→stripped, and composing strip∘runner needs a chain step.
    if (jsx && scanJSX(program).hasJSX) {
        const stripped = transform(filename, source, { lang, jsx: options.jsx });
        if (stripped.errors.length > 0) return emptyResult(stripped.errors);
        return moduleRunnerTransform(filename, stripped.code);
    }

    // Fused: one parse feeds both the TS strip and the runner-rewrite.
    const semantic = createSemantic();
    analyze(semantic, program);
    const r = collectRunnerEdits(program, semantic, source);
    if (ts) r.edits.push(...collectStripEdits(program, source, true, null, null));
    return assembleRunner(filename, source, r, errors, options.sourcemap);
}
