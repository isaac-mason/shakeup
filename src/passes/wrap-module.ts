// Build a module wrapper as AST — `var <name> = <helper>(<params> => { <body> })`.
//
// shakeup used to splice these as TEXT: take the rendered module, indent it four columns, wrap it in
// a template string, and then repair the source map afterwards by prepending the header line and
// shifting every segment right. That repair existed only because of the splice, and its own comment
// recorded what it cost when it was missed: "the map desynchronized for the WHOLE chunk: in a bundle
// with one wrapped module, no output line mapped to anything, including untouched ES modules
// alongside it." The repair function is deleted now — nothing splices.
//
// rolldown builds both of its wrappers as AST — `new_commonjs_wrapper_stmt` and
// `new_esm_wrapper_stmt` in `rolldown_ecmascript_utils/src/ast_factory.rs`, called from
// `module_finalizers/impl_visit_mut.rs`, which moves `program.body` into the closure and pushes the
// wrapper statement. There is no text stage anywhere in its pipeline. This is the shakeup equivalent.
//
// Mappings then fall out of printing, and the wrapper body stays visible to anything that reads the
// AST — a chunk-level compressor sees inside a wrapped module instead of an opaque string.
//
// SCOPES: the minted arrow and block carry `scopeId: 0`. Nothing re-reads the per-module semantic
// after the wrapper is built (it is the last step before printing), and a chunk-level pass analyses
// the assembled program from scratch. If that ever changes, mint the scope the way `ctx.mintBlock`
// does rather than leaving it 0.
//
// SYMBOLS: the wrapper's names (`__commonJS`, `__toESM`, the generated `require_x`) are resolved by
// the deconflict stage, not by the semantic model, so these bindings and references are deliberately
// UNBOUND — hence `binding`/`ref` rather than their `bound*` counterparts.
import { binding, cloneNode, create, N, type Node, num, ref, SPAN } from '../ast/index.ts';

export type WrapOptions = {
    /** The binding the wrapper is assigned to: `var <name> = …`. */
    name: string;
    /** Runtime helper invoked with the closure — `__commonJS` / `__esm`. */
    helper: string;
    /** Closure parameters, in order. EMPTY is meaningful: rolldown emits no parameter list at all
     *  for a CommonJS module that references neither `module` nor `exports`. */
    params: string[];
    /** Statements moved INSIDE the closure. */
    body: Node[];
    /** Annotate the call `/*@__PURE__*​/`, so an unreferenced wrapper can be dropped. rolldown marks
     *  `__commonJS` pure (`new_with_pure`) and `__esm` NOT pure (`new`) — a behavioural difference,
     *  not a cosmetic one, so it is a required argument rather than a default. */
    pure: boolean;
};

/** `var <name> = [/*@__PURE__*​/] <helper>(<params> => { <body> });` */
export function wrapModuleBody(opts: WrapOptions): Node {
    const params = opts.params.map((p) => create.FormalParameter(SPAN, SPAN, 0, binding(p), null, null));
    const body = create.BlockStatement(SPAN, SPAN, 0, opts.body);
    const closure = create.ArrowFunctionExpression(SPAN, SPAN, 0, null, params, null, body);
    const call = create.CallExpression(SPAN, SPAN, opts.pure ? create.FL.PURE : 0, ref(opts.helper), [closure], null);
    const decl = create.VariableDeclarator(SPAN, SPAN, 0, binding(opts.name), null, call);
    return create.VariableDeclaration(SPAN, SPAN, create.VAR_KIND.VAR, [decl]);
}

/** `var <name> = /*@__PURE__*​/ __toESM(<wrapper>()[, 1]);`
 *
 *  The interop namespace materialised beside a CommonJS wrapper. Built here rather than appended as
 *  text so the wrapper and its namespace stay one AST — appending a string beside an AST-built
 *  statement would put the text stage straight back.
 *
 *  `nodeMode` is rolldown's second argument (D4): an importer that is ESM BY FILE FORMAT gets
 *  `__toESM(require_d(), 1)`, which skips the `__esModule` check and hands back the whole
 *  `module.exports` as `default` — what Node actually does. */
export function interopNamespace(name: string, wrapperName: string, nodeMode: boolean): Node {
    const call = create.CallExpression(SPAN, SPAN, 0, ref(wrapperName), [], null);
    const args: Node[] = nodeMode ? [call, num(1)] : [call];
    const toEsm = create.CallExpression(SPAN, SPAN, create.FL.PURE, ref('__toESM'), args, null);
    return create.VariableDeclaration(SPAN, SPAN, create.VAR_KIND.VAR, [
        create.VariableDeclarator(SPAN, SPAN, 0, binding(name), null, toEsm),
    ]);
}

/** The live statements of a module body, with dead declarators pruned.
 *
 *  The printer normally does both jobs while emitting a Program: it skips statements absent from
 *  `live`, and keeps only the declarators whose ids are in it. Neither applies once statements move
 *  INSIDE a wrapper closure — `live` is keyed by TOP-LEVEL node id, and a closure body is not top
 *  level — so a wrapped module has to be materialised first and then rendered with shaking off. That
 *  is the same rule `esmInitSplit` follows.
 *
 *  A partially-live declaration is CLONED with only its live declarators rather than mutated: the
 *  module AST is cached across builds and reused under different liveness. */
export function materialiseLiveBody(body: readonly Node[], live: ReadonlySet<number> | null): Node[] {
    if (live === null) return [...body];
    const out: Node[] = [];
    for (const stmt of body) {
        if (!live.has(stmt.id)) continue;
        const decl = varDeclOf(stmt);
        if (decl === null) {
            out.push(stmt);
            continue;
        }
        const decls = (decl.data as { declarations: Node[] }).declarations;
        const kept = decls.filter((d) => live.has(d.id));
        if (kept.length === decls.length) {
            out.push(stmt);
            continue;
        }
        const copy = cloneNode(stmt)!;
        (varDeclOf(copy)!.data as { declarations: Node[] }).declarations = kept.map((d) => cloneNode(d)!);
        out.push(copy);
    }
    return out;
}

/** The `VariableDeclaration` a statement declares through, bare or `export`-wrapped. */
function varDeclOf(stmt: Node): Node | null {
    if (stmt.type === N.VariableDeclaration) return stmt;
    if (stmt.type !== N.ExportNamedDeclaration) return null;
    const inner = (stmt.data as { declaration: Node | null }).declaration;
    return inner !== null && inner.type === N.VariableDeclaration ? inner : null;
}
