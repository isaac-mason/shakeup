// The `es` output format: one chunk's import/export surface, then its assembled text.
//
// Named for the FORMAT, not the phase, because both references split here and split the same way —
// rolldown has `ecmascript/format/{esm,cjs,iife,umd}.rs`, rollup has `finalisers/{es,cjs,amd,iife,
// umd,system}.ts`. Emitting a format's import/export statements and framing its body is one
// decision. shakeup emits only `es` today, so a second format arrives as a sibling file.
import { N, type Node, walk } from '../../ast/index.ts';
import type { Part } from '../../util/sourcemap.ts';
import type { Chunk } from '../chunk-graph.ts';
import { relativePath } from '../fs.ts';
import { type Graph, type Linked, type Module, NAME_DEFAULT, NAME_NAMESPACE } from '../graph-types.ts';
import { finalNameOf } from '../link.ts';
import type { PreRenderedChunk } from '../output-options.ts';
import { isAnyRequireCall } from '../scan.ts';
import {
    clauseSep,
    isIdentName,
    nameOfBind,
    type PreliminaryFileName,
    type RenderCtx,
    type RenderedChunk,
    type RenderedModules,
} from './context.ts';

/** Runtime helpers for CommonJS interop, transcribed from rolldown's `runtime-base.js`.
 *
 *  The `Min` forms are used: rolldown selects the named-function variants only under
 *  `profiler_names` (default off), and every fixture snapshot uses these. Emitted verbatim into the
 *  chunk that needs them rather than through a synthetic runtime module — a full runtime-module
 *  facility is only warranted once more than a handful of helpers exist.
 *
 *  `__commonJSMin` memoizes: `mod ||` short-circuits after the first call, so a module body runs at
 *  most once and a cycle re-entering it observes the PARTIAL exports, which is exactly Node's
 *  behaviour. `__toESM` converts a CommonJS exports object into an ESM namespace, honouring the
 *  `__esModule` marker — and note rolldown's extra `hasOwnProperty(mod, 'default')` guard, a fix
 *  (#10360) esbuild lacks: a module claiming `__esModule` without actually owning a `default` would
 *  otherwise yield `undefined` for `import d from`. */
const CJS_HELPERS: Record<string, string> = {
    // The `binary` loader's decoder, transcribed from rolldown's `runtime-base.js:76-95` (which is
    // esbuild's `__toBinary`). The table build and the four-at-a-time inner loop are theirs; the
    // `/* @__PURE__ */` on the IIFE is what lets it be dropped when tree-shaking removes the last
    // binary module. esbuild has a `__toBinaryNode` variant backed by `Buffer.from` — not used
    // here, since this form works on both platforms and shakeup emits ONE runtime chunk shared
    // across them.
    __toBinary: `var __toBinary = /* @__PURE__ */ (() => {
  var table = new Uint8Array(128);
  for (var i = 0; i < 64; i++) table[i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i * 4 - 205] = i;
  return (base64) => {
    var n = base64.length, bytes = new Uint8Array((((n - (base64[n - 1] == '=') - (base64[n - 2] == '=')) * 3) / 4) | 0);
    for (var i = 0, j = 0; i < n; ) {
      var c0 = table[base64.charCodeAt(i++)], c1 = table[base64.charCodeAt(i++)];
      var c2 = table[base64.charCodeAt(i++)], c3 = table[base64.charCodeAt(i++)];
      bytes[j++] = (c0 << 2) | (c1 >> 4);
      bytes[j++] = (c1 << 4) | (c2 >> 2);
      bytes[j++] = (c2 << 6) | c3;
    }
    return bytes;
  };
})();`,
    __getOwnPropNames: 'var __getOwnPropNames = Object.getOwnPropertyNames;',
    __getOwnPropDesc: 'var __getOwnPropDesc = Object.getOwnPropertyDescriptor;',
    __hasOwnProp: 'var __hasOwnProp = Object.prototype.hasOwnProperty;',
    __defProp: 'var __defProp = Object.defineProperty;',
    __create: 'var __create = Object.create;',
    __getProtoOf: 'var __getProtoOf = Object.getPrototypeOf;',
    // esbuild's `__commonJSMin` (`runtime.go:201-207`), NOT rolldown's — the two differ and only
    // esbuild's matches Node. A CommonJS module whose body THROWS is deleted from Node's require
    // cache and RE-RUNS on the next `require()`; measured on Node 24, a module that throws once then
    // succeeds gives `["THREW:first", {ran:2}]`. rolldown's body has no `try`, so `mod` stays set to
    // the HALF-POPULATED exports object from the failed run and the second require hands that back —
    // shakeup returned `{}` where Node returns `{ran:2}`, silently.
    //
    // `cb` is deliberately NOT nulled after the first call (rolldown nulls it to free the closure):
    // a retry needs it. Note the asymmetry with `__esm` below, which is the OPPOSITE and equally
    // deliberate — an ES module's evaluation error IS sticky per spec, a CommonJS module's is not.
    __commonJS: [
        'var __commonJS = (cb, mod) => () => {',
        '    try {',
        '        return (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);',
        '    } catch (e) {',
        '        throw ((mod = 0), e);',
        '    }',
        '};',
    ].join('\n'),
    // rolldown's `__esmMin` verbatim (`runtime/runtime-base.js:17-23`). `fn = 0` after the first
    // call makes it run ONCE; the `err` cache makes an evaluation failure STICKY, which the ESM
    // spec requires — a module that threw must throw the same error on every later access, not
    // re-run. Transcribed rather than derived: the one-liner it is tempting to write instead
    // re-evaluates a module whose first evaluation threw.
    __esm: [
        'var __esm = (fn, res, err) => () => {',
        '    if (err) throw err[0];',
        '    try {',
        '        return (fn && (res = fn((fn = 0))), res);',
        '    } catch (e) {',
        '        throw ((err = [e]), e);',
        '    }',
        '};',
    ].join('\n'),
    __copyProps: [
        'var __copyProps = (to, from, except, desc) => {',
        "    if ((from && typeof from === 'object') || typeof from === 'function') {",
        '        for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {',
        '            key = keys[i];',
        '            if (!__hasOwnProp.call(to, key) && key !== except) {',
        '                __defProp(to, key, {',
        '                    get: ((k) => from[k]).bind(null, key),',
        '                    enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,',
        '                });',
        '            }',
        '        }',
        '    }',
        '    return to;',
        '};',
    ].join('\n'),
    // Transcribed from rolldown `runtime-base.js:34-43` and `:58-60`. `__exportAll` builds the
    // mode-2 namespace: every entry is a getter, and the object stays EXTENSIBLE so `__reExport` can
    // add to it (which is also why nothing here is frozen). `__reExport` copies with `'default'` as
    // the `except` key — `export *` never forwards `default`, in any bundler or in Node.
    __exportAll: [
        'var __exportAll = (all, no_symbols) => {',
        '    let target = {};',
        '    for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });',
        "    if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: 'Module' });",
        '    return target;',
        '};',
    ].join('\n'),
    __reExport:
        "var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, 'default'), secondTarget && __copyProps(secondTarget, mod, 'default'));",
    __toCommonJS: [
        'var __toCommonJS = (mod) =>',
        "    __hasOwnProp.call(mod, 'module.exports')",
        "        ? mod['module.exports']",
        "        : __copyProps(__defProp({}, '__esModule', { value: true }), mod);",
    ].join('\n'),
    __toESM: [
        'var __toESM = (mod, isNodeMode, target) => (',
        '    (target = mod != null ? __create(__getProtoOf(mod)) : {}),',
        '    __copyProps(',
        "        isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, 'default')",
        "            ? __defProp(target, 'default', { value: mod, enumerable: true })",
        '            : target,',
        '        mod,',
        '    )',
        ');',
    ].join('\n'),
};

/** The `require` shim, in its two platform forms — both transcribed, neither derived.
 *
 *  On `platform: 'node'` an ESM bundle can build a REAL require: rolldown's `runtime-tail-node.js`
 *  is `createRequire(import.meta.url)`, selected by `is_esm_format_with_node_platform()`
 *  (`runtime_module_task.rs:42-44`). `require.resolve`, `require.cache` and a dynamic call then all
 *  genuinely work, because it IS Node's require.
 *
 *  Everywhere else it is the Proxy stub esbuild wrote and rolldown inherited verbatim
 *  (`runtime-tail.js` / `runtime.go:123-133`). Two things it is careful about, both from linked
 *  issues: `typeof require` must be `'function'` even off Node (esbuild #1202) — hence a function
 *  target — and it must pick up a `require` that appears LATER, including through property access
 *  (esbuild #1614) — hence the Proxy rather than a captured value. */
const REQUIRE_SHIM_NODE = 'var __require = /* @__PURE__ */ (() => createRequire(import.meta.url))();';
const REQUIRE_SHIM_NODE_IMPORT = "import { createRequire } from 'node:module';";
const REQUIRE_SHIM = [
    'var __require = /* @__PURE__ */ ((x) =>',
    "    typeof require !== 'undefined'",
    '        ? require',
    "        : typeof Proxy !== 'undefined'",
    "          ? new Proxy(x, { get: (a, b) => (typeof require !== 'undefined' ? require : a)[b] })",
    '          : x)(function (x) {',
    "    if (typeof require !== 'undefined') return require.apply(this, arguments);",
    "    throw Error('Dynamic require of \"' + x + '\" is not supported');",
    '});',
].join('\n');

/** Sentinel key for the `require` shim, which is not in {@link CJS_HELPERS} because it has two
 *  platform-dependent bodies and one of them needs an accompanying import statement. */
export const REQUIRE_SHIM_KEY = '__require';

/** Helpers namespace mode 2 needs, in dependency order. */
const EXPORT_ALL_DEPS = [
    '__getOwnPropNames',
    '__getOwnPropDesc',
    '__hasOwnProp',
    '__defProp',
    '__create',
    '__getProtoOf',
    '__copyProps',
    '__exportAll',
    '__reExport',
    '__toESM',
];

/** Helpers `__toESM` needs, in dependency order. */
const TO_ESM_DEPS = [
    '__getOwnPropNames',
    '__getOwnPropDesc',
    '__hasOwnProp',
    '__defProp',
    '__create',
    '__getProtoOf',
    '__copyProps',
    '__toESM',
];

/** Helpers `__toCommonJS` needs, in dependency order. */
const TO_CJS_DEPS = ['__getOwnPropNames', '__getOwnPropDesc', '__hasOwnProp', '__defProp', '__copyProps', '__toCommonJS'];

/** Identifier references to a FREE `require` that are NOT the callee of a `require(...)` call —
 *  `typeof require`, `require.resolve(x)`, `require.cache`, a bare `require` passed as a value.
 *
 *  esbuild swaps exactly these for its `__require` stub: `ref == p.requireRef && !opts.isCallTarget`
 *  (`js_parser.go:17181-17189` → `valueToSubstituteForRequire`, `:1863`), gated on bundle mode with
 *  a non-CommonJS output format (`config.go:696`). rolldown inherits the same stub. Without it a
 *  UMD header's `typeof require === 'function'` is FALSE and it silently takes the browser-global
 *  branch, and every `require.X` throws `require is not defined` at load.
 *
 *  A `require("literal")` CALL is not here: it is either lowered to the target's wrapper or reported
 *  as an unresolvable specifier. Keeping the stub off call position is what preserves shakeup's
 *  deliberate divergence — a dynamic `require(expr)` stays a LOUD BUILD ERROR rather than becoming a
 *  runtime throw from inside `__require`. */
function needsRequireShim(mod: Module): boolean {
    return freeRequireRefs(mod).length > 0 || mod.importRecords.some((r) => r.kind === 'require' && r.external);
}

export function freeRequireRefs(mod: Module): Node[] {
    const found: Node[] = [];
    if (!mod.hasRequire && !mod.semantic.unresolved.some((n) => n.name === 'require')) return found;
    const callees = new Set<Node>();
    walk(mod.program, (n) => {
        if (isAnyRequireCall(n)) callees.add((n.data as { callee: Node }).callee);
    });
    walk(mod.program, (n) => {
        if (n.type === N.IdentifierReference && n.name === 'require' && n.sym === 0 && !callees.has(n)) found.push(n);
    });
    return found;
}

function renderExternalImports(linked: Linked, sideEffectSpecs: Set<string>, tight: boolean): string[] {
    const bySpec = new Map<string, { name: string; local: string }[]>();
    for (const [key, local] of linked.externalLocals) {
        const sep = key.indexOf('\x00');
        const spec = key.slice(0, sep);
        const name = key.slice(sep + 1);
        let list = bySpec.get(spec);
        if (list === undefined) {
            list = [];
            bySpec.set(spec, list);
        }
        list.push({ name, local });
    }
    const lines: string[] = [];
    for (const [spec, entries] of bySpec) {
        sideEffectSpecs.delete(spec);
        const attrs = linked.externalAttributes.get(spec);
        const star = entries.find((e) => e.name === '*');
        if (star !== undefined) lines.push(importStmt(`* as ${star.local}`, spec, tight, attrs));
        const def = entries.find((e) => e.name === 'default');
        const named = entries.filter((e) => e.name !== '*' && e.name !== 'default');
        if (def !== undefined || named.length > 0) {
            const inner = named.map((e) => (e.name === e.local ? e.name : `${e.name} as ${e.local}`)).join(clauseSep(tight));
            const namedPart = named.length > 0 ? (tight ? `{${inner}}` : `{ ${inner} }`) : '';
            const clauses = [def !== undefined ? def.local : '', namedPart].filter((s) => s !== '').join(clauseSep(tight));
            lines.push(importStmt(clauses, spec, tight, attrs));
        }
    }
    for (const spec of sideEffectSpecs) {
        const a = linked.externalAttributes.get(spec);
        const w = a === undefined ? '' : tight ? `with{${a}}` : ` with { ${a} }`;
        lines.push(tight ? `import'${spec}'${w};` : `import '${spec}'${w};`);
    }
    return lines;
}

/** `import <clauses> from '<spec>';`, dropping the separators that only exist for readability.
 *  A clause list starting with `{`/`*` needs no space after `import`, and one ending in `}` needs
 *  none before `from`; a bare default local (`import d from …`) needs both. */
function importStmt(clauses: string, spec: string, tight: boolean, attrs?: string): string {
    // An external keeps its import attributes: the module is still fetched by the runtime, which
    // needs `with { type: … }` to load it. (A BUNDLED module drops the clause — it is inlined
    // JavaScript by then. Both oracles split it exactly this way.)
    const w = attrs === undefined ? '' : tight ? `with{${attrs}}` : ` with { ${attrs} }`;
    if (!tight) return `import ${clauses} from '${spec}'${w};`;
    const lead = clauses.startsWith('{') || clauses.startsWith('*') ? '' : ' ';
    const tail = clauses.endsWith('}') ? '' : ' ';
    return `import${lead}${clauses}${tail}from'${spec}'${w};`;
}

/** The `__require` shim's lines for this build's platform. */
function requireShimLines(graph: Graph): string[] {
    return graph.platform === 'node' ? [REQUIRE_SHIM_NODE_IMPORT, REQUIRE_SHIM_NODE] : [REQUIRE_SHIM];
}

/** Which runtime helpers this chunk's own modules require. Pure function of `graph`/`linked`/the
 *  chunk's module list, so chunk-graph can call it before rendering to decide whether a shared
 *  runtime chunk is worth minting. */
export function helpersNeededBy(graph: Graph, linked: Linked, chunk: Chunk): Set<string> {
    const wanted = new Set<string>();
    const has = (f: (i: number) => boolean) => chunk.modules.some(f);
    const needsCjs = has((i) => linked.cjsWrap.has(i)) || has((i) => linked.dynamicExports.has(i));
    // A `require()` of an ES module needs `__toCommonJS` even when nothing else here is wrapped.
    const needsToCjs = has((i) =>
        graph.modules[i].importRecords.some(
            (r) =>
                r.kind === 'require' &&
                !r.external &&
                r.resolved >= 0 &&
                !linked.cjsWrap.has(r.resolved) &&
                linked.namespaceOf.has(r.resolved),
        ),
    );
    // A lazily-initialised module (§7.20/D1) carries its own `__esm` — and it is the PRODUCER chunk
    // that declares the init function, which may wrap nothing and require nothing itself.
    const needsEsm = has((i) => linked.esmInit.has(i));
    if (needsCjs) wanted.add('__commonJS');
    if (has((i) => linked.cjsNamespace.has(i) || linked.cjsNamespaceNode.has(i))) for (const d of TO_ESM_DEPS) wanted.add(d);
    if (needsEsm) wanted.add('__esm');
    if (has((i) => linked.dynamicExports.has(i))) for (const d of EXPORT_ALL_DEPS) wanted.add(d);
    if (needsToCjs) for (const d of TO_CJS_DEPS) wanted.add(d);
    if (has((i) => needsRequireShim(graph.modules[i]))) wanted.add(REQUIRE_SHIM_KEY);
    // The `binary` loader emits `export default __toBinary("…")`, so the demand is a property of
    // the module's TYPE rather than of anything `link` computed.
    if (has((i) => graph.modules[i].moduleType === 'binary')) wanted.add('__toBinary');
    return wanted;
}

/** Render one chunk in the `es` output format: its import/export surface, then the assembled text.
 *
 *  Named for the FORMAT, not the phase. Both references split here and split the same way — rolldown
 *  has `ecmascript/format/{esm,cjs,iife,umd}.rs`, rollup has `finalisers/{es,cjs,amd,iife,umd,
 *  system}.ts` — because emitting a format's import/export statements and framing its body is one
 *  decision, not two. shakeup emits only `es` today (`format: () => 'es'`), so the seam is latent;
 *  naming it now means a second format arrives as a sibling rather than as a re-cut. */
export function renderEsm(ctx: RenderCtx, mods: RenderedModules, prelim: PreliminaryFileName): RenderedChunk | null {
    const { graph, linked, chunkGraph, chunk, chunkIdx, shaken, naming, tight, pathToChunk } = ctx;
    const { parts: moduleParts, mapSources, mapSourcesContent, entryStarSpecs, sideEffectSpecs } = mods;

    // Cross-chunk static imports: `import { imported as local, … } from '<path>';`
    const crossImportLines: string[] = [];
    for (const [producerChunk, specs] of chunk.imports) {
        const path = pathToChunk(producerChunk);
        // A `*` specifier is a NATIVE namespace import (chunk-graph `nsNative`): the host builds the
        // Module namespace, so it gets its own statement rather than joining the named clause.
        for (const s of specs)
            if (s.imported === NAME_NAMESPACE) crossImportLines.push(importStmt(`* as ${s.local}`, path, tight));
        const named = specs.filter((s) => s.imported !== NAME_NAMESPACE);
        if (named.length === 0) continue;
        const parts = named.map((s) => (s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`));
        const inner = parts.join(clauseSep(tight));
        crossImportLines.push(importStmt(tight ? `{${inner}}` : `{ ${inner} }`, path, tight));
    }
    for (const producerChunk of chunk.sideEffectImports) {
        crossImportLines.push(tight ? `import'${pathToChunk(producerChunk)}';` : `import '${pathToChunk(producerChunk)}';`);
    }

    // External imports, scoped to this chunk's used external locals.
    const extImports = renderExternalImports(linked, sideEffectSpecs, tight);

    // `exports: 'none'` suppresses the entry export line entirely (validation-only shaping for
    // pure ESM — cross-chunk producer exports still emit so shared chunks keep working). For a
    // shared/producer chunk it is `chunk.exports`.
    const exportSpecs: string[] = [];
    const exportedNames: string[] = [];
    let cjsEntryDefault: string | null = null;
    const seenExport = new Set<string>();
    // `output.exports` must be CONSISTENT with what the entry actually exports — rollup's
    // `getExportMode` (`utils/getExportMode.ts:13-20`). `'default'` demands the entry export exactly
    // `default`; `'none'` demands it export nothing. We accepted either silently and then just
    // suppressed the export line, so a misconfigured build produced a chunk missing its exports
    // instead of telling the user.
    if (
        chunk.entryModule >= 0 &&
        (chunk.isEntry || chunk.isDynamicEntry) &&
        (naming.exports === 'default' || naming.exports === 'none')
    ) {
        const keys = [...(linked.exportMaps.get(chunk.entryModule)?.keys() ?? [])];
        const bad = naming.exports === 'default' ? !(keys.length === 1 && keys[0] === NAME_DEFAULT) : keys.length > 0;
        if (bad) {
            // rollup's `printQuotedStringList`: one item bare, otherwise `"a", "b" and "c"`.
            const quoted = keys.map((k) => `"${k}"`);
            const list =
                quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
            const id = graph.modules[chunk.entryModule].id;
            throw new Error(
                `"${naming.exports}" was specified for "output.exports", but entry module "${relativePath(naming.dir, id)}" has the following exports: ${list}`,
            );
        }
    }
    const suppressEntryExports = naming.exports === 'none';
    // Entry (and dynamic-entry) chunks export their entry module's surface.
    if (!suppressEntryExports && chunk.entryModule >= 0 && (chunk.isEntry || chunk.isDynamicEntry)) {
        // A CommonJS entry has no ESM export surface — its exports are `module.exports`, produced by
        // calling the wrapper. rolldown emits exactly `export default require_main();`
        // (`cjs_compat/cjs_entry`). Without this the chunk exported NOTHING: a `import('./x.cjs')`
        // resolved to an empty namespace, and a CommonJS entry point yielded `undefined` downstream.
        const entryWrapRef = linked.cjsWrap.get(chunk.entryModule);
        if (entryWrapRef !== undefined) {
            // Its own statement, not an `export { … }` specifier: a specifier must be an identifier,
            // and this is a CALL. `export default require_main();`
            seenExport.add(NAME_DEFAULT);
            // Chunk-local alias first — a FACADE entry chunk (one whose entry module lives in
            // another chunk, minted when two static entries share a color) has to call the name it
            // imported the wrapper under. rolldown's `multiple_circle_cjs_entries` snapshot is the
            // same shape: `import { t as require_b } from "./a.js"; export default require_b();`.
            cjsEntryDefault = `export default ${chunk.importLocalOf.get(entryWrapRef) ?? finalNameOf(linked, entryWrapRef)}();`;
            exportedNames.push(NAME_DEFAULT);
        }
        const entryMap = linked.exportMaps.get(chunk.entryModule);
        // A pure dynamic-entry chunk narrows to the members its `import()` consumers read (tree-shake
        // dropped the rest); a real user entry always exports its whole surface.
        const narrow = chunk.isDynamicEntry && !chunk.isEntry ? shaken?.nsUsage.get(chunk.entryModule) : undefined;
        if (entryMap !== undefined) {
            for (const [name, bind] of entryMap) {
                if (narrow !== undefined && !narrow.has(name)) continue;
                const local = nameOfBind(linked, bind, chunk);
                if (local === null) continue;
                if (seenExport.has(name)) continue;
                seenExport.add(name);
                const exported = isIdentName(name) ? name : JSON.stringify(name);
                exportSpecs.push(local === name ? exported : `${local} as ${exported}`);
                exportedNames.push(name);
            }
        }
    }
    // Native-namespace producers: surface the module's OWN export names so a consumer's
    // `import * as ns from './thisChunk'` sees the real surface. `nativeNsEligible` guarantees this
    // chunk holds exactly that module and every member is one of its own locals, so these names
    // cannot collide with a sibling's.
    for (const modIdx of chunk.nsNative ?? []) {
        for (const [name, bind] of linked.exportMaps.get(modIdx) ?? []) {
            if (seenExport.has(name)) continue;
            const local = nameOfBind(linked, bind, chunk);
            if (local === null) continue;
            seenExport.add(name);
            const exported = isIdentName(name) ? name : JSON.stringify(name);
            exportSpecs.push(local === name ? exported : `${local} as ${exported}`);
            exportedNames.push(name);
        }
    }
    // Producer exports for cross-chunk consumers (`export { local as t }`).
    for (const [exportedName, e] of chunk.exports) {
        if (seenExport.has(exportedName)) continue;
        const local = e.local;
        seenExport.add(exportedName);
        const exported = isIdentName(exportedName) ? exportedName : JSON.stringify(exportedName);
        exportSpecs.push(local === exportedName ? exported : `${local} as ${exported}`);
        exportedNames.push(exportedName);
    }
    // The shared runtime chunk exports the helpers it defines, under their own names. Not routed
    // through `chunk.exports`, which is keyed on symbol refs — a helper has no ref, it is text.
    if (chunk.runtimeHelpers !== undefined) {
        for (const name of chunk.runtimeHelpers) {
            if (seenExport.has(name)) continue;
            seenExport.add(name);
            exportSpecs.push(name);
            exportedNames.push(name);
        }
    }
    const exportInner = exportSpecs.join(clauseSep(tight));
    const exportLine = exportSpecs.length > 0 ? (tight ? `export{${exportInner}};` : `export { ${exportInner} };`) : null;
    const starLines = suppressEntryExports
        ? []
        : entryStarSpecs.map((spec) => (tight ? `export*from'${spec}';` : `export * from '${spec}';`));

    // CommonJS runtime helpers. Which ones a chunk needs is decided by `helpersNeededBy`, shared
    // with chunk-graph so the SHARED-RUNTIME decision (below) uses the same answer the render does.
    const wanted = helpersNeededBy(graph, linked, chunk);
    const helperLines: string[] = [];
    if (chunk.runtimeHelpers !== undefined) {
        // THIS is the runtime chunk: it defines the union of every consumer's helpers and exports
        // them. rolldown does the same, as a real module in the graph (`runtime_module_task.rs`);
        // shakeup keeps them as text but gives them their own chunk, which is where the DUPLICATION
        // was — measured at 6 identical copies of the helper set across 7 chunks (D5).
        for (const name of chunk.runtimeHelpers) if (name === REQUIRE_SHIM_KEY) helperLines.push(...requireShimLines(graph));
        for (const [name, src] of Object.entries(CJS_HELPERS)) if (chunk.runtimeHelpers.has(name)) helperLines.push(src);
    } else if (chunk.importsRuntime) {
        // A consumer: the helpers arrive as a cross-chunk import, already in `crossImportLines`.
    } else {
        if (wanted.has(REQUIRE_SHIM_KEY)) helperLines.push(...requireShimLines(graph));
        for (const [name, src] of Object.entries(CJS_HELPERS)) if (wanted.has(name)) helperLines.push(src);
    }

    // Empty non-entry chunk with nothing to emit: drop it.
    const isEmpty =
        moduleParts.length === 0 &&
        exportLine === null &&
        cjsEntryDefault === null &&
        starLines.length === 0 &&
        helperLines.length === 0;
    if (isEmpty && !chunk.isEntry) return null;

    // Addons (banner/intro leading, footer/outro trailing). Sync string/fn only. Order:
    // banner, intro, imports, body, exports, outro, footer.
    const preInfo: PreRenderedChunk = {
        name: chunk.name,
        isEntry: chunk.isEntry,
        isDynamicEntry: chunk.isDynamicEntry,
        facadeModuleId: chunk.entryModule >= 0 ? graph.modules[chunk.entryModule].id : null,
        moduleIds: chunk.modules.map((i) => graph.modules[i].id),
        exports: [...chunk.exports.keys()].sort(),
        type: 'chunk',
    };
    const banner = naming.banner(preInfo);
    const intro = naming.intro(preInfo);
    const outro = naming.outro(preInfo);
    const footer = naming.footer(preInfo);

    // ONE list. The emitted text and the sourcemap parts are the SAME sequence, so they are built
    // once and `code` is derived from it — `joinParts` (sourcemap.ts) derives each part's line span
    // from its own `code`, so any disagreement silently shifts every following mapping.
    //
    // This used to be a `string[]` for the code beside a `Part[]` for the map, and it drifted twice.
    // `helperLines` was once missing from the map list, putting every mapped line ~30 generated
    // lines above where it belonged — for any chunk carrying CommonJS helpers, including its plain
    // ES modules. `cjsEntryDefault` was missing too: a CommonJS ENTRY chunk emitted a map one line
    // short (measured: 12 emitted lines, 12 mapped, where every other shape gives n+1). Both were
    // silent — a map that decodes cleanly and has the right `sources` looks fine.
    //
    // Unmapped parts (banner, imports, helper text) carry `code` only; `joinParts` counts their
    // lines and emits empty segments, which is exactly what shifts the mapped parts into place.
    const parts: Part[] = [];
    if (banner !== '') parts.push({ code: banner });
    if (intro !== '') parts.push({ code: intro });
    for (const s of crossImportLines) parts.push({ code: s });
    for (const s of extImports) parts.push({ code: s });
    for (const s of helperLines) parts.push({ code: s });
    parts.push(...moduleParts);
    if (exportLine !== null) parts.push({ code: exportLine });
    if (cjsEntryDefault !== null) parts.push({ code: cjsEntryDefault });
    for (const s of starLines) parts.push({ code: s });
    if (outro !== '') parts.push({ code: outro });
    if (footer !== '') parts.push({ code: footer });
    const code = `${parts.map((p) => p.code).join('\n')}\n`;

    const importNames: string[] = [];
    for (const p of chunk.imports.keys()) importNames.push(chunkGraph.chunks[p].name);
    for (const p of chunk.sideEffectImports) importNames.push(chunkGraph.chunks[p].name);
    const dynamicImportNames: string[] = [];
    for (const d of chunk.dynamicImports) dynamicImportNames.push(chunkGraph.chunks[d].name);

    return {
        chunk,
        chunkIdx,
        prelim,
        code,
        parts,
        mapSources,
        mapSourcesContent,
        name: chunk.name,
        isEntry: chunk.isEntry,
        isDynamicEntry: chunk.isDynamicEntry,
        moduleIds: chunk.modules.map((i) => graph.modules[i].id),
        imports: importNames,
        dynamicImports: dynamicImportNames,
        exports: exportedNames,
    };
}
