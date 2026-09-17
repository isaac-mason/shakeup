// The ES module lexer: what a module says about itself, read without parsing it.
//
// Separate from `./ast` on purpose. These answer a fixed set of questions in a single character
// pass, and they exist because a lowering that has to ask only those questions should not pay for
// a syntax tree and a symbol table to get them.

export { type ExportWrite, type ExportWrites, exportWrites } from './parser/export-writes.ts';
export {
    type ExportKind,
    type ExportRecord,
    type ImportBinding,
    type ImportBindingKind,
    type ImportRecord,
    type ModuleRecord,
    moduleRecord,
} from './parser/module-record.ts';
