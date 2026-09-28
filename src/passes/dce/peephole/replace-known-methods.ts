// Port of oxc_minifier/src/peephole/replace_known_methods.rs, the parts tree-shake mode reaches: the
// template-literal escaping the constant folds use. The known-method replacements are full minify only.

/** Escape a cooked string for use as template-literal raw text. */
export function escapeStringForTemplateLiteral(value: string): string {
    if (!/[\\`$\r]/.test(value)) return value;
    return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('\r', '\\r');
}
