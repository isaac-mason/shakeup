// Public surface of the parser. Internals live in sibling modules:
//   parser.ts — recursive descent · token.ts — packed token space · errors.ts — diagnostics
//   module-syntax.ts — the module lexer, which reads specifiers without building a tree
export * from './parser.ts';
export {
    type ExportKind,
    type ExportEntry,
    type ImportBinding,
    type ImportBindingKind,
    type ImportEntry,
    type ModuleSyntax,
    scanModuleSyntax,
} from './module-syntax.ts';
