// Bundle: linked graph -> one executable ESM chunk (rolldown generate stage cut
// to a single chunk). Per module, reuse the emit edit engine to strip types and
// rewrite import/export syntax + identifiers, then concat in execution order.
// LIMIT: mutated `let` exports lose live-binding fidelity in namespace objects.

import { A, FL, N, type NodeId, listAt, listLen, text } from './ast';
import { walkRefIdents } from './analysis/refs';
import { type Edit, applyEdits, collectStripEdits } from './emit';
import { type Graph, type GraphOptions, type Module, buildGraph } from './graph';
import { type PluginCtx, compilePipeline } from './plugin';
import { type Shaken, shake } from './shake';
import {
    type ImportBind,
    type Linked,
    externalKey,
    finalNameOf,
    linkGraph,
    packRef,
} from './link';

/** Inputs to {@link bundle}: graph options plus tree-shaking toggle. */
export type BundleOptions = GraphOptions & {
    /** statement-level tree shaking (default true) */
    treeshake?: boolean;
};

/** Output of {@link bundle}: the chunk code plus diagnostics and intermediate state. */
export type BundleResult = {
    code: string;
    errors: string[];
    warnings: string[];
    graph: Graph | null;
    linked: Linked | null;
    /** statements removed by tree shaking (empty when treeshake: false) */
    shaken: Shaken | null;
};

/* --------------------------------------------------------------- renaming */

type EmitCtx = {
    graph: Graph;
    linked: Linked;
    mod: Module;
    edits: Edit[];
    warnings: string[];
    /** live top-level statements for this module (null = keep everything) */
    live: Set<number> | null;
};

/** Final output name for an Ident node's symbol, or null if unchanged. */
function renameOf(ctx: EmitCtx, identNode: NodeId): string | null {
    const sym = ctx.mod.semantic.nodeSymbol[identNode];
    if (sym === 0) return null;
    const imp = ctx.mod.namedImports.get(sym);
    if (imp !== undefined) {
        const bind = ctx.linked.binds.get(packRef(ctx.mod.idx, sym));
        if (bind === undefined) return null;
        return nameOfBind(ctx.linked, bind);
    }
    const renamed = ctx.linked.finalNames.get(packRef(ctx.mod.idx, sym));
    return renamed ?? null;
}

function nameOfBind(linked: Linked, bind: ImportBind): string | null {
    switch (bind.kind) {
        case 'found':
            return finalNameOf(linked, bind.ref);
        case 'namespace':
            return linked.namespaceOf.get(bind.module) ?? null;
        case 'external':
            return linked.externalLocals.get(externalKey(bind.specifier, bind.name)) ?? null;
        case 'none':
            return null;
    }
}

/** Walk an expression/statement subtree adding rename edits (shorthand-aware). */
function renameWalk(ctx: EmitCtx, node: NodeId): void {
    const ast = ctx.mod.ast;
    walkRefIdents(ast, node, (ident, shorthandProp) => {
        const newName = renameOf(ctx, ident);
        if (newName === null || newName === text(ast, ident)) return;
        ctx.edits.push({
            start: ast.start[ident],
            end: ast.end[ident],
            // shorthand `{ a }` must expand to `{ a: a$1 }` — bare span replace would rename the key too
            text: shorthandProp !== 0 ? `${text(ast, ident)}: ${newName}` : newName,
        });
    });
}

/* ---------------------------------------------------- per-module rewriting */

function moduleEdits(ctx: EmitCtx, isEntry: boolean, entryStarSpecs: string[], sideEffectSpecs: Set<string>): void {
    const { mod } = ctx;
    const ast = mod.ast;
    const body = A.Program.body(ast, mod.program);
    for (let i = 0; i < listLen(ast, body); i++) {
        const stmt = listAt(ast, body, i);
        const t = ast.type[stmt];

        if (ctx.live !== null && !ctx.live.has(stmt)) {
            // shaken: blank the whole statement, no renames, no export handling
            ctx.edits.push({ start: ast.start[stmt], end: ast.end[stmt] });
            continue;
        }

        if (t === N.ImportDecl) {
            if ((ast.flags[stmt] & FL.TYPE_ONLY) === 0) {
                // side-effect-only external import must survive (hoisted)
                const specs = A.ImportDecl.specifiers(ast, stmt);
                const source = A.ImportDecl.source(ast, stmt);
                if (source !== 0 && listLen(ast, specs) === 0) {
                    const spec = ast.src.slice(ast.start[source] + 1, ast.end[source] - 1);
                    const rec = mod.importRecords.find((r) => r.specifier === spec);
                    if (rec?.external) sideEffectSpecs.add(spec);
                }
            }
            ctx.edits.push({ start: ast.start[stmt], end: ast.end[stmt] });
            continue;
        }

        if (t === N.ExportAll) {
            const source = A.ExportAll.source(ast, stmt);
            const spec = source !== 0 ? ast.src.slice(ast.start[source] + 1, ast.end[source] - 1) : '';
            const rec = mod.importRecords.find((r) => r.specifier === spec);
            if (rec?.external) {
                if (isEntry) entryStarSpecs.push(spec);
                else ctx.warnings.push(`'export * from "${spec}"' in non-entry module '${mod.id}' is dropped (external star re-export)`);
            }
            ctx.edits.push({ start: ast.start[stmt], end: ast.end[stmt] });
            continue;
        }

        if (t === N.ExportNamed) {
            if (ast.flags[stmt] & FL.TYPE_ONLY) continue; // strip pass blanks it
            const decl = A.ExportNamed.decl(ast, stmt);
            if (decl !== 0) {
                const dt = ast.type[decl];
                if (dt === N.TSEnumDecl || dt === N.TSInterfaceDecl || dt === N.TSTypeAliasDecl) continue; // strip pass owns these
                // keep the declaration, blank the `export ` prefix
                ctx.edits.push({ start: ast.start[stmt], end: ast.start[decl] });
                renameWalk(ctx, decl);
            } else {
                ctx.edits.push({ start: ast.start[stmt], end: ast.end[stmt] });
            }
            continue;
        }

        if (t === N.ExportDefault) {
            const decl = A.ExportDefault.decl(ast, stmt);
            const dt = ast.type[decl];
            const named =
                (dt === N.FuncDecl || dt === N.ClassDecl) &&
                A[dt === N.FuncDecl ? 'FuncDecl' : 'ClassDecl'].id(ast, decl) !== 0;
            if (named) {
                ctx.edits.push({ start: ast.start[stmt], end: ast.start[decl] });
            } else {
                const ref = ctx.linked.defaultRefs.get(mod.idx);
                const name = ref !== undefined ? finalNameOf(ctx.linked, ref) : `${mod.idx}_default`;
                ctx.edits.push({ start: ast.start[stmt], end: ast.start[decl], text: `const ${name} = ` });
            }
            renameWalk(ctx, decl);
            continue;
        }

        renameWalk(ctx, stmt);
    }
}

/* ------------------------------------------------------- external imports */

function renderExternalImports(linked: Linked, sideEffectSpecs: Set<string>): string[] {
    // group hoisted locals by specifier
    const bySpec = new Map<string, { name: string; local: string }[]>();
    for (const [key, local] of linked.externalLocals) {
        const sep = key.indexOf('\x00');
        const spec = key.slice(0, sep);
        const name = key.slice(sep + 1);
        let list = bySpec.get(spec);
        if (list === undefined) bySpec.set(spec, (list = []));
        list.push({ name, local });
    }
    const lines: string[] = [];
    for (const [spec, entries] of bySpec) {
        sideEffectSpecs.delete(spec); // a binding import already runs the module
        const star = entries.find((e) => e.name === '*');
        if (star !== undefined) lines.push(`import * as ${star.local} from '${spec}';`);
        const def = entries.find((e) => e.name === 'default');
        const named = entries.filter((e) => e.name !== '*' && e.name !== 'default');
        if (def !== undefined || named.length > 0) {
            const namedPart =
                named.length > 0
                    ? `{ ${named.map((e) => (e.name === e.local ? e.name : `${e.name} as ${e.local}`)).join(', ')} }`
                    : '';
            const clauses = [def !== undefined ? def.local : '', namedPart].filter((s) => s !== '').join(', ');
            lines.push(`import ${clauses} from '${spec}';`);
        }
    }
    for (const spec of sideEffectSpecs) lines.push(`import '${spec}';`);
    return lines;
}

/* -------------------------------------------------------------- namespaces */

const isIdentName = (s: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

function renderNamespaceObject(linked: Linked, modIdx: number): string {
    const nsName = linked.namespaceOf.get(modIdx)!;
    const map = linked.exportMaps.get(modIdx);
    const entries: string[] = [];
    if (map !== undefined) {
        for (const [name, bind] of map) {
            const value = nameOfBind(linked, bind);
            if (value === null) continue;
            entries.push(`${isIdentName(name) ? name : JSON.stringify(name)}: ${value}`);
        }
    }
    return `const ${nsName} = Object.freeze({ ${entries.join(', ')} });`;
}

/* ------------------------------------------------------------------ entry */

/** Build, link, tree-shake, and assemble the entry module into a single ESM chunk. */
export function bundle(options: BundleOptions): BundleResult {
    const pipeline = compilePipeline(options.plugins ?? []);
    const warningsOut: string[] = [];
    const pluginCtx: PluginCtx = { warn: (m) => warningsOut.push(m), fs: options.fs };
    for (const hook of pipeline.buildStart) hook.handler(pluginCtx);
    const graph = buildGraph(options, pipeline);
    if (graph.errors.length > 0 || graph.entry < 0) {
        return { code: '', errors: graph.errors, warnings: [], graph, linked: null, shaken: null };
    }
    const linked = linkGraph(graph);
    if (linked.errors.length > 0) {
        return { code: '', errors: linked.errors, warnings: [], graph, linked, shaken: null };
    }

    const warnings: string[] = [...warningsOut, ...graph.warnings];
    const parts: string[] = [];
    const entryStarSpecs: string[] = [];
    const sideEffectSpecs = new Set<string>();
    const shaken = options.treeshake === false ? null : shake(graph, linked);

    const moduleTexts: string[] = [];
    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        const live = shaken === null ? null : shaken.live[idx];
        // LIMIT: only the enum's own name is renamed; idents inside enum initializer expressions are not.
        const enumFinalName = (idNode: number): string | null => {
            const sym = mod.semantic.nodeSymbol[idNode];
            if (sym === 0) return null;
            return linked.finalNames.get(packRef(mod.idx, sym)) ?? null;
        };
        let stripEdits = collectStripEdits(mod.ast, mod.program, true, enumFinalName);
        if (live !== null) {
            // drop strip edits (e.g. enum lowerings) inside statements that the
            // shaker blanks wholesale — the blank owns the span
            const deadSpans: [number, number][] = [];
            const body = A.Program.body(mod.ast, mod.program);
            for (let i = 0; i < listLen(mod.ast, body); i++) {
                const stmt = listAt(mod.ast, body, i);
                if (!live.has(stmt)) deadSpans.push([mod.ast.start[stmt], mod.ast.end[stmt]]);
            }
            stripEdits = stripEdits.filter((e) => !deadSpans.some(([s, x]) => e.start >= s && e.end <= x));
        }
        const ctx: EmitCtx = { graph, linked, mod, edits: stripEdits, warnings, live };
        moduleEdits(ctx, idx === graph.entry, entryStarSpecs, sideEffectSpecs);
        let out = applyEdits(mod.source, ctx.edits).trim();
        if (linked.namespaceOf.has(idx)) {
            out += `\n${renderNamespaceObject(linked, idx)}`;
        }
        if (out !== '') moduleTexts.push(out);
    }

    parts.push(...renderExternalImports(linked, sideEffectSpecs));
    parts.push(...moduleTexts);

    // entry export surface
    const entryMap = linked.exportMaps.get(graph.entry);
    if (entryMap !== undefined && entryMap.size > 0) {
        const specifiers: string[] = [];
        for (const [name, bind] of entryMap) {
            const local = nameOfBind(linked, bind);
            if (local === null) continue;
            const exported = isIdentName(name) ? name : JSON.stringify(name);
            specifiers.push(local === name ? exported : `${local} as ${exported}`);
        }
        if (specifiers.length > 0) parts.push(`export { ${specifiers.join(', ')} };`);
    }
    for (const spec of entryStarSpecs) parts.push(`export * from '${spec}';`);

    let code = `${parts.join('\n')}\n`;
    for (const hook of pipeline.renderChunk) {
        const result = hook.handler(pluginCtx, code);
        if (result !== null && result !== undefined) code = result;
    }
    for (const hook of pipeline.buildEnd) hook.handler(pluginCtx);
    warnings.push(...warningsOut.splice(0));
    return { code, errors: [], warnings, graph, linked, shaken };
}
