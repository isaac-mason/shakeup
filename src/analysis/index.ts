// Analysis passes: standalone, re-runnable queries over (Ast, NodeId) with no
// coupling to graph/link/bundle state, cheap to re-derive after AST mutation.
export * from './semantic';
export * from './effects';
export * from './refs';
