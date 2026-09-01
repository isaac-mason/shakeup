// THE LANGUAGE TOOLCHAIN'S PUBLIC API — `shakeup/ast`.
//
// Parse, inspect, build, and analyse JavaScript/TypeScript, with no bundler attached. This mirrors the
// `src/` split — `bundler/` depends on the toolchain and never the reverse, enforced by
// `tst/toolchain-boundary.test.ts` — so the package's two halves are separable from the outside too:
// a consumer who wants an AST does not pull in a bundler. oxc does the same, publishing `oxc-parser`
// apart from the bundler that uses it.
//
// Curated like `index.ts`: values named one by one, types via `export type *`. What is deliberately
// NOT here, and why:
//
//   • `allocId` / `peekNextId` — the node-id allocator. Handing out ids from outside desynchronises
//     the counter every `node()` call depends on.
//   • `retireSymbol`, `declareLocal`, `declareSyntheticImport`, `attachScopeNode`, `refFor`,
//     `markInferredPure`, `resetInferredPure` — Semantic MUTATORS. The Semantic is maintained
//     incrementally across lowering, and mutating it outside `passes/traverse.ts`'s API is this
//     codebase's single most recurrent bug class. Publishing them would export the footgun.
//   • `parseProgram` / `lexOnly` — narrower spellings of `parse` that nothing has ever called, not
//     even the benchmarks. Trivial to add back if a use appears; impossible to remove once shipped.
//   • `ast/estree.ts` — imports `@typescript-eslint/types`, a devDependency, in a package with ZERO
//     runtime dependencies. Exporting it would break a consumer install.
//
// The AST is exported whole otherwise, builders included: a toolchain that can parse and walk but not
// CONSTRUCT is only half of one, and `set` is here because retyping a node in place is how a real
// transform converts (an `ObjectExpression` used as a pattern, say).

export type * from './analysis/index.ts';
// ── semantic analysis: scopes, symbols, purity ──────────────────────────────────────────────────
// Read-and-create only; see the mutator note above.
export {
    analyze,
    createScope,
    createSemantic,
    isPureExpr,
    isPureStatement,
    lookupValue,
    mayHaveSideEffects,
    SCOPE,
    SYM,
    scopeOf,
    symbolName,
    symbolOf,
    walkRefIdents,
} from './analysis/index.ts';
export type * from './ast/index.ts';
// ── the AST: schema, traversal, construction ────────────────────────────────────────────────────
export {
    assign,
    bigInt,
    binding,
    bool,
    boundBinding,
    boundRef,
    CHILD_FIELDS,
    cloneNode,
    computed,
    create,
    DEFS,
    emptyObject,
    exprStmt,
    FL,
    idName,
    isIdentifier,
    isJSXNode,
    isTypeOnlyNode,
    jsxIdent,
    jsxText,
    labelId,
    lineColOf,
    member,
    N,
    NODE_TYPE_NAMES,
    node,
    nullLit,
    num,
    OP,
    privateName,
    ref,
    regExp,
    SPAN,
    set,
    statementListOf,
    str,
    TYPE_COUNT,
    TYPE_NAME,
    templateElement,
    VAR_KIND,
    void0,
    walk,
    walkChildren,
} from './ast/index.ts';
export type * from './parser/index.ts';
// ── parsing ─────────────────────────────────────────────────────────────────────────────────────
export { parse, parseWithDiagnostics } from './parser/index.ts';
