// The AST module root — the one address the rest of the codebase imports from.
//
// Mirrors `oxc_ast`'s `lib.rs`: the crate root re-exports, while the definitions live in
// sibling files (`ast.ts` = the schema + node types + walk; `create.ts` = the builders).
// This is NOT the `graph/` barrel rejected in module-graph-split-plan.md §1 — that one
// would have preserved a three-stage blob under a single fictitious name. `ast` is one
// coherent module, so a root is the honest shape rather than a cover story.
//
// `create` is re-exported as a NAMESPACE, not flattened: `create.Program` (the builder)
// and `Program` (the node type) are different things that would collide under a bare
// `export *`. Call sites keep reading `create.CallExpression(...)`.
//
// The parse-flag vocabulary is ALSO re-exported bare, because 184 call sites spell it
// `FL.ASYNC` / `VAR_KIND.VAR` / `OP.NOT` and those read better unqualified in the parser's
// hot path. Both spellings work; `create.FL` is the same object.
//
// `create.ts` imports `./ast.ts` directly rather than this file — importing the root from
// inside the module would be a cycle.
export * from './ast.ts';
export * as create from './create.ts';
export { FL, type KeywordType, OP, VAR_KIND } from './create.ts';
