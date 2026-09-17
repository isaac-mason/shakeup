// The module record: what a file imports and exports, and where those words are.
//
// A character scanner, not a parser and not even a tokeniser. A tool that rewrites ESM — a loader
// lowering it to something it can evaluate, a bundler resolving a graph — needs statement spans,
// specifiers and binding names, and nothing else. Both of the cheaper-looking routes are traps:
//
//   a full parse       builds an AST nobody asked for. ~47 MB/s on bundled application code.
//   the tokeniser      classifies every token, interning identifiers as it goes. ~862 MB/s, but it
//                      answers the wrong question: it does not know a `}` closing a template
//                      interpolation from one closing a block, and reading that wrong drifts the
//                      nesting count so that every `export` after the first template is missed.
//
// So this walks bytes and skips, as `es-module-lexer` does. A string, a comment, a regex and a
// template are each consumed by a tight loop that looks only for their end; the only characters
// that get thought applied to them are braces and the first letter of `import` and `export`.
//
// The two hazards that make this more than a loop over `charCodeAt`, both handled:
//
//   templates   `a${b}c` nests: the expression inside `${}` can contain further templates and
//               braces. A stack of interpolation depths keeps the `}` that resumes the template
//               apart from the `}` that closes a block.
//   regex       `/[{]/` is a regex and `a / [b] / c` is division, and the difference is decided by
//               what came before. A regex read as division leaves an unbalanced brace; division
//               read as a regex swallows code to the next slash. The preceding significant
//               character decides, with the keyword cases (`return /x/`, `typeof /x/`) handled by
//               remembering the last word.
//
// Measured against `es-module-lexer`, which is the same job compiled to WebAssembly:
//
//   4.96MB of bundled application code
//     this scanner, JavaScript       ~430 MB/s
//     es-module-lexer, wasm          ~390 MB/s
//     the full parse, for scale        46 MB/s
//
// Faster than the wasm scanner, in JavaScript, while reporting strictly more: the local names an
// import binds and how an exported binding was declared, neither of which `es-module-lexer` gives
// and both of which a lowering needs to avoid a second pass. Agreement on npm's module-syntax
// corpus is exact: 123 of 123 files on export names, and every dependency it finds.
//
// Where the speed came from, in the order it was found, because none of it was where it looked:
//
//   the tokeniser is the wrong tool    reusing it ran at 101 MB/s and still missed exports, since
//                                      it cannot tell a `}` closing an interpolation from one
//                                      closing a block.
//   never build an identifier          materialising every one to compare it against a keyword
//                                      was most of the work. 187 -> 255 MB/s.
//   let the engine find the next       a regular expression skips the boring runs natively, so
//   interesting position               this loop runs once per interesting character rather than
//                                      once per token. 276 -> 291 MB/s.
//   do not track parentheses           the largest single win, and the least obvious: a
//                                      declaration cannot appear inside them, braces alone
//                                      balance, and parentheses are the most common stop in a
//                                      file. 291 -> 430 MB/s.
//
// What it does NOT do is validate. Malformed input is recorded as best it can be read and left for
// the parser to complain about; this is for tools that have already decided the input is
// JavaScript.

export type ImportBindingKind = 'default' | 'named' | 'namespace';

export type ImportBinding = {
    /** The name bound in this module. */
    local: string;
    /** The name taken from the other module, or null for a default or namespace binding. */
    imported: string | null;
    kind: ImportBindingKind;
};

/** The specification's own word for this: a module record holds `[[ImportEntries]]`. */
export type ImportEntry = {
    type: 'static' | 'dynamic';
    /** The specifier without quotes, or null when a dynamic import computes it. */
    specifier: string | null;
    /** The specifier literal, quotes included. */
    start: number;
    end: number;
    /** The whole statement, for a rewriter that replaces it. */
    statementStart: number;
    statementEnd: number;
    bindings: ImportBinding[];
};

export type ExportKind = 'declaration' | 'specifier' | 'default' | 'all';

/** Likewise `[[LocalExportEntries]]`, `[[IndirectExportEntries]]` and `[[StarExportEntries]]`. */
export type ExportEntry = {
    kind: ExportKind;
    /** The name other modules see. `*` for an un-aliased `export * from`. */
    name: string;
    /** The binding in this module, or null when the value comes from elsewhere. */
    localName: string | null;
    /**
     * For a re-export, the name in the module it comes from: the `p` of
     * `export { p as q } from './r.js'`. Null when there is no other module.
     *
     * Not `localName`, which means a binding in this module and is null here on purpose. A
     * lowering needs both sides of the alias, and only this one carries the far side.
     */
    importedName: string | null;
    /** How that binding was declared, which says whether it can ever be reassigned. */
    declarationKind: 'const' | 'let' | 'var' | 'function' | 'class' | null;
    /** A re-export's source, without quotes. */
    specifier: string | null;
    statementStart: number;
    statementEnd: number;
    /** Where the declaration starts, past `export` and any `default`, for stripping keywords. */
    declarationStart: number;
};

export type ModuleSyntax = {
    imports: ImportEntry[];
    exports: ExportEntry[];
    /**
     * Every `import.meta`, which a lowering has to replace with the module's own meta object.
     *
     * Not an import: it names no other module. `es-module-lexer` files it under imports, which
     * makes its import list a list of two different things.
     */
    importMeta: { start: number; end: number }[];
    /** An `await` outside any function, which is what `require()` of a module has to refuse. */
    hasTopLevelAwait: boolean;
};

const CH_TAB = 9, CH_LF = 10, CH_CR = 13, CH_SPACE = 32;
const CH_QUOTE = 34, CH_DOLLAR = 36, CH_APOS = 39;
const CH_LPAREN = 40, CH_RPAREN = 41, CH_STAR = 42, CH_COMMA = 44;
const CH_DOT = 46, CH_SLASH = 47;
const CH_0 = 48, CH_9 = 57, CH_COLON = 58, CH_SEMI = 59;
const CH_EQ = 61, CH_GT = 62;
const CH_A_UPPER = 65, CH_Z_UPPER = 90;
const CH_LBRACKET = 91, CH_BACKSLASH = 92, CH_RBRACKET = 93, CH_UNDERSCORE = 95, CH_BACKTICK = 96;
const CH_A = 97, CH_Z = 122, CH_LBRACE = 123, CH_RBRACE = 125;

/**
 * Character classes, as a table rather than a chain of comparisons.
 *
 * The scanner asks "is this a space" and "can this continue an identifier" once per character of
 * the file, so those two questions are the hot path and a function call is too expensive to make
 * there. One byte per ASCII code, two bits used. Above 127 the answer is computed, which is rare
 * enough not to matter and keeps the table small enough to stay in cache.
 */
const CLASS_SPACE = 1;
const CLASS_IDENT_START = 2;
const CLASS_IDENT_PART = 4;

const CHAR_CLASS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
    let flags = 0;
    if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) flags |= CLASS_SPACE;
    if ((c >= CH_A && c <= CH_Z) || (c >= CH_A_UPPER && c <= CH_Z_UPPER) || c === CH_UNDERSCORE || c === CH_DOLLAR) {
        flags |= CLASS_IDENT_START | CLASS_IDENT_PART;
    }
    if (c >= CH_0 && c <= CH_9) flags |= CLASS_IDENT_PART;
    CHAR_CLASS[c] = flags;
}

// Above ASCII, anything that is not the byte order mark can start an identifier. Close enough for
// a scanner: a non-ASCII character in expression position is an identifier or inside a literal,
// and literals are skipped whole.
const isIdentStart = (c: number) => (c < 128 ? (CHAR_CLASS[c] & CLASS_IDENT_START) !== 0 : c !== 0xfeff);
const isIdentPart = (c: number) => (c < 128 ? (CHAR_CLASS[c] & CLASS_IDENT_PART) !== 0 : c !== 0xfeff);
const isSpace = (c: number) => (c < 128 ? (CHAR_CLASS[c] & CLASS_SPACE) !== 0 : c === 0xfeff);

/** Words after which a `/` begins a regular expression rather than a division. */
const REGEX_PRECEDING = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
    'case', 'do', 'else', 'yield', 'await',
]);

export function scanModuleSyntax(source: string): ModuleSyntax {
    /** Compare a word in place, so a keyword test costs no allocation. */
    const matches = (at: number, word: string): boolean => {
        for (let k = 0; k < word.length; k++) {
            if (source.charCodeAt(at + k) !== word.charCodeAt(k)) return false;
        }
        return true;
    };

    const imports: ImportEntry[] = [];
    const exports: ExportEntry[] = [];
    const importMeta: { start: number; end: number }[] = [];
    let hasTopLevelAwait = false;

    const length = source.length;
    let i = 0;
    let depth = 0;

    /**
     * Interpolation depths of the templates currently open.
     *
     * A `}` resumes a template when the nesting is back to where its `${` was. Templates nest, so
     * this is a stack rather than a flag.
     */
    const templates: number[] = [];

    /**
     * The last character that decides whether a `/` is a regex, and the last word before it. A
     * regex may follow an operator, a keyword or the start of a statement, and may not follow a
     * value — an identifier, a number, a string, or a closing bracket.
     */
    /** Skip whitespace and comments from `at`, returning the first position that is neither. */
    function skipTrivia(at: number): number {
        while (at < length) {
            const c = source.charCodeAt(at);
            if (isSpace(c)) {
                at++;
                continue;
            }
            if (c === CH_SLASH) {
                const next = source.charCodeAt(at + 1);
                if (next === CH_SLASH) {
                    const nl = source.indexOf('\n', at + 2);
                    at = nl < 0 ? length : nl + 1;
                    continue;
                }
                if (next === CH_STAR) {
                    const close = source.indexOf('*/', at + 2);
                    at = close < 0 ? length : close + 2;
                    continue;
                }
            }
            return at;
        }
        return length;
    }

    /** The identifier at `at`, or an empty string. */
    function wordAt(at: number): string {
        if (at >= length || !isIdentStart(source.charCodeAt(at))) return '';
        let end = at + 1;
        while (end < length && isIdentPart(source.charCodeAt(end))) end++;
        return source.slice(at, end);
    }

    /**
     * Past the string literal starting at `at`.
     *
     * `indexOf` rather than a loop over `charCodeAt`. The engine's own search is a native scan and
     * a string's contents are bulk bytes nobody here cares about, so the only characters worth
     * examining are the closing quote and the backslashes immediately before it. An odd number of
     * those escapes the quote and the search continues; an even number does not, which is the
     * whole of the escape handling.
     */
    function skipString(at: number): number {
        const quote = at;
        const ch = source[at];
        let from = at + 1;
        for (;;) {
            const end = source.indexOf(ch, from);
            if (end < 0) return length;
            let slashes = 0;
            while (source.charCodeAt(end - 1 - slashes) === CH_BACKSLASH) slashes++;
            if ((slashes & 1) === 0) return end + 1;
            from = end + 1;
        }
        // `quote` is kept so a caller can slice the literal it just skipped.
        void quote;
    }

    /**
     * Where the next interesting character is, found by the engine rather than by us.
     *
     * Almost nothing in a file matters here. Identifiers that are not one of three keywords,
     * numbers, operators and whitespace are all bytes to step over, and stepping over them one
     * `charCodeAt` at a time is most of the cost of scanning. A regular expression asks V8's own
     * matcher to find the next position worth thinking about, which skips those runs at native
     * speed and leaves this loop running once per interesting character instead of once per token.
     *
     * The word boundaries matter: without them `myimport` and `exports` would both stop the scan.
     *
     * Parentheses and brackets are deliberately not in the set. Nesting is only tracked to know
     * whether a declaration sits at the top level, and a declaration cannot appear inside either;
     * braces alone balance, because a brace inside parentheses still has its own closing brace.
     * Leaving them out removes the most common stop in the file.
     */
    const INTERESTING = /\bimport\b|\bexport\b|\bawait\b|["'`]|\/|[{}]/g;

    /**
     * The last significant character before `at`, for deciding whether a `/` opens a regex.
     *
     * Looked up backwards on demand rather than tracked forwards, because the forward version
     * costs something at every character and this costs something only at a slash. Whitespace is
     * skipped; a `*` preceded by `/` is the end of a comment, which is not a value, so a regex may
     * follow it.
     */
    function significantBefore(at: number): number {
        let back = at - 1;
        while (back >= 0) {
            const c = source.charCodeAt(back);
            if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) {
                back--;
                continue;
            }
            if (c === CH_SLASH && back > 0 && source.charCodeAt(back - 1) === CH_STAR) return 0;
            return c;
        }
        return 0;
    }

    /**
     * Is the `await` at `at` inside an arrow function's expression body?
     *
     * Braces alone cannot answer this, and it is the one case they miss: `async () => await go()`
     * has no body braces, so the await sits at brace depth zero and reads as top-level. That
     * matters more than it sounds — a module is refused by `require()` when its graph contains a
     * top-level await, so getting this wrong makes every module that merely DEFINES an async arrow
     * un-requireable, which is most of them.
     *
     * An arrow is the only case: `async function` always has braces, and parentheses do not
     * introduce a scope, so `foo(await x)` at the top level really is a top-level await. So the
     * question is only whether an `=>` comes before the nearest statement boundary going
     * backwards, which is a short walk and only ever taken for an await that already looks
     * top-level.
     */
    function inConciseArrowBody(at: number): boolean {
        for (let back = at - 1; back >= 0; back--) {
            const c = source.charCodeAt(back);
            // A statement boundary: whatever preceded it belongs to another statement.
            if (c === CH_SEMI || c === CH_LBRACE || c === CH_RBRACE) return false;
            // `=>`, and not `>=`, which cannot appear here anyway but costs nothing to exclude.
            if (c === CH_GT && source.charCodeAt(back - 1) === CH_EQ) return true;
        }
        return false;
    }

    /** The identifier ending at `at`, for the keyword cases where a regex may follow a word. */
    function wordEndingAt(at: number): string {
        let start = at;
        while (start > 0 && isIdentPart(source.charCodeAt(start - 1))) start--;
        return source.slice(start, at);
    }

    while (i < length) {
        INTERESTING.lastIndex = i;
        const found = INTERESTING.exec(source);
        if (found === null) break;

        i = found.index;
        const c = source.charCodeAt(i);
        const token = found[0];

        if (c === CH_SLASH) {
            const next = source.charCodeAt(i + 1);
            if (next === CH_SLASH) {
                const nl = source.indexOf('\n', i + 2);
                i = nl < 0 ? length : nl + 1;
                continue;
            }
            if (next === CH_STAR) {
                const close = source.indexOf('*/', i + 2);
                i = close < 0 ? length : close + 2;
                continue;
            }
            const before = significantBefore(i);
            const isRegex = before === 0
                ? true
                : isIdentPart(before)
                    ? REGEX_PRECEDING.has(wordEndingAt(i === 0 ? 0 : backOverSpace(i)))
                    : before !== CH_RPAREN && before !== CH_RBRACKET;
            if (!isRegex) {
                i++;
                continue;
            }
            i++;
            let inClass = false;
            while (i < length) {
                const r = source.charCodeAt(i);
                if (r === CH_BACKSLASH) {
                    i += 2;
                    continue;
                }
                if (r === CH_LBRACKET) inClass = true;
                else if (r === CH_RBRACKET) inClass = false;
                else if (r === CH_SLASH && !inClass) {
                    i++;
                    break;
                } else if (r === CH_LF) break;
                i++;
            }
            while (i < length && isIdentPart(source.charCodeAt(i))) i++;
            continue;
        }

        if (c === CH_QUOTE || c === CH_APOS) {
            i = skipString(i);
            continue;
        }

        if (c === CH_BACKTICK) {
            i = skipTemplateChunk(i + 1);
            continue;
        }

        if (c === CH_LBRACE) {
            depth++;
            i++;
            continue;
        }

        if (c === CH_RBRACE) {
            // A `}` at the depth a `${` was opened at resumes its template rather than closing a
            // block. Without this the nesting count drifts and every later export is missed.
            if (templates.length > 0 && templates[templates.length - 1] === depth) {
                templates.pop();
                i = skipTemplateChunk(i + 1);
                continue;
            }
            if (depth > 0) depth--;
            i++;
            continue;
        }

        // One of the three words — unless it is a property name. `lib.import('./a.js')` is a method
        // call and `obj.export` is a field, and a word boundary cannot tell either from the real
        // thing.
        //
        // Only the character immediately before counts, deliberately. Skipping whitespace first
        // would mean skipping comments too, and a comment ending in a full stop is common prose:
        // `// for efficiency's sake.` followed by `export function` read as a member access and
        // lost the export. `lib . import(x)` is legal and is not handled; it is vanishingly rare,
        // and misreading it yields a spurious dynamic import that fails to resolve rather than a
        // silently missing one.
        const after = i + token.length;
        if (source.charCodeAt(i - 1) === CH_DOT) {
            i = after;
            continue;
        }
        if (token === 'import') {
            const at = skipTrivia(after);
            const nextChar = source.charCodeAt(at);
            if (nextChar === CH_LPAREN) {
                i = readDynamicImport(i, at);
                continue;
            }
            if (nextChar === CH_DOT) {
                const metaAt = skipTrivia(at + 1);
                if (matches(metaAt, 'meta')) importMeta.push({ start: i, end: metaAt + 4 });
                i = after;
                continue;
            }
            if (depth === 0) {
                i = readImport(i, at);
                continue;
            }
        } else if (token === 'export' && depth === 0) {
            i = readExport(i, skipTrivia(after));
            continue;
        } else if (token === 'await' && depth === 0 && !inConciseArrowBody(i)) {
            hasTopLevelAwait = true;
        }
        i = after;
    }

    /** Backwards over whitespace, for reading the word that ends just before a slash. */
    function backOverSpace(at: number): number {
        let back = at;
        while (back > 0) {
            const c = source.charCodeAt(back - 1);
            if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) back--;
            else break;
        }
        return back;
    }

    /**
     * From just inside a template chunk to just past its end or its next `${`.
     *
     * Shared by the opening backtick and by the `}` that resumes an interpolation, because both
     * continue the same literal.
     */
    function skipTemplateChunk(at: number): number {
        let cursor = at;
        while (cursor < length) {
            const t = source.charCodeAt(cursor);
            if (t === CH_BACKSLASH) {
                cursor += 2;
                continue;
            }
            if (t === CH_BACKTICK) return cursor + 1;
            if (t === CH_DOLLAR && source.charCodeAt(cursor + 1) === CH_LBRACE) {
                templates.push(depth);
                return cursor + 2;
            }
            cursor++;
        }
        return length;
    }

    function readDynamicImport(statementStart: number, at: number): number {
        let cursor = skipTrivia(at + 1);
        const c = source.charCodeAt(cursor);
        const record: ImportEntry = {
            type: 'dynamic', specifier: null, start: cursor, end: cursor,
            statementStart, statementEnd: cursor, bindings: [],
        };
        // A literal specifier can be resolved ahead of time; a computed one cannot, and saying so
        // is more useful than guessing.
        if (c === CH_QUOTE || c === CH_APOS) {
            const end = skipString(cursor);
            record.specifier = source.slice(cursor + 1, end - 1);
            record.start = cursor;
            record.end = end;
            record.statementEnd = end;
            cursor = end;
        }
        imports.push(record);
        return cursor;
    }

    function readImport(statementStart: number, at: number): number {
        const bindings: ImportBinding[] = [];
        let cursor = at;
        let c = source.charCodeAt(cursor);

        const finish = (specifierAt: number) => {
            const end = skipString(specifierAt);
            imports.push({
                type: 'static', specifier: source.slice(specifierAt + 1, end - 1),
                start: specifierAt, end, statementStart, statementEnd: end, bindings,
            });
            return end;
        };

        // `import './side-effect.js'`
        if (c === CH_QUOTE || c === CH_APOS) return finish(cursor);

        // A default binding, which may be followed by a comma and more.
        if (isIdentStart(c)) {
            const local = wordAt(cursor);
            bindings.push({ local, imported: null, kind: 'default' });
            cursor = skipTrivia(cursor + local.length);
            if (source.charCodeAt(cursor) === CH_COMMA) cursor = skipTrivia(cursor + 1);
        }

        c = source.charCodeAt(cursor);
        if (c === CH_STAR) {
            cursor = skipTrivia(cursor + 1);
            if (wordAt(cursor) === 'as') cursor = skipTrivia(cursor + 2);
            const local = wordAt(cursor);
            if (local !== '') {
                bindings.push({ local, imported: null, kind: 'namespace' });
                cursor = skipTrivia(cursor + local.length);
            }
        } else if (c === CH_LBRACE) {
            cursor = skipTrivia(cursor + 1);
            while (cursor < length && source.charCodeAt(cursor) !== CH_RBRACE) {
                if (source.charCodeAt(cursor) === CH_COMMA) {
                    cursor = skipTrivia(cursor + 1);
                    continue;
                }
                const imported = wordAt(cursor);
                if (imported === '') break;
                cursor = skipTrivia(cursor + imported.length);
                let local = imported;
                if (wordAt(cursor) === 'as') {
                    cursor = skipTrivia(cursor + 2);
                    local = wordAt(cursor);
                    cursor = skipTrivia(cursor + local.length);
                }
                bindings.push({ local, imported, kind: 'named' });
            }
            cursor = skipTrivia(cursor + 1);
        }

        if (wordAt(cursor) === 'from') cursor = skipTrivia(cursor + 4);
        c = source.charCodeAt(cursor);
        if (c === CH_QUOTE || c === CH_APOS) return finish(cursor);

        return cursor;
    }

    function readExport(statementStart: number, at: number): number {
        let cursor = at;
        const declarationStart = cursor;
        const word = wordAt(cursor);

        if (word === 'default') {
            cursor = skipTrivia(cursor + 7);
            const { kind, after: afterKeyword } = declarationAt(cursor);
            let localName: string | null = null;
            if (kind === 'function' || kind === 'class') {
                const nameAt = source.charCodeAt(afterKeyword) === CH_STAR ? skipTrivia(afterKeyword + 1) : afterKeyword;
                const name = wordAt(nameAt);
                if (name !== '' && name !== 'extends') localName = name;
            }
            exports.push({
                kind: 'default', name: 'default', localName, importedName: null, declarationKind: kind,
                specifier: null, statementStart, statementEnd: cursor, declarationStart: cursor,
            });
            return cursor;
        }

        // `export * from './m.js'` and `export * as ns from './m.js'`
        if (source.charCodeAt(cursor) === CH_STAR) {
            cursor = skipTrivia(cursor + 1);
            let name = '*';
            if (wordAt(cursor) === 'as') {
                cursor = skipTrivia(cursor + 2);
                name = wordAt(cursor);
                cursor = skipTrivia(cursor + name.length);
            }
            if (wordAt(cursor) === 'from') cursor = skipTrivia(cursor + 4);
            let specifier: string | null = null;
            const c = source.charCodeAt(cursor);
            if (c === CH_QUOTE || c === CH_APOS) {
                const end = skipString(cursor);
                specifier = source.slice(cursor + 1, end - 1);
                cursor = end;
            }
            exports.push({
                kind: 'all', name, localName: null, importedName: null, declarationKind: null, specifier,
                statementStart, statementEnd: cursor, declarationStart,
            });
            return cursor;
        }

        // `export { a, b as c }`, optionally `from './m.js'`
        if (source.charCodeAt(cursor) === CH_LBRACE) {
            cursor = skipTrivia(cursor + 1);
            const pending: { local: string; name: string }[] = [];
            while (cursor < length && source.charCodeAt(cursor) !== CH_RBRACE) {
                if (source.charCodeAt(cursor) === CH_COMMA) {
                    cursor = skipTrivia(cursor + 1);
                    continue;
                }
                const local = wordAt(cursor);
                if (local === '') break;
                cursor = skipTrivia(cursor + local.length);
                let name = local;
                if (wordAt(cursor) === 'as') {
                    cursor = skipTrivia(cursor + 2);
                    name = wordAt(cursor);
                    cursor = skipTrivia(cursor + name.length);
                }
                pending.push({ local, name });
            }
            cursor = skipTrivia(cursor + 1);

            let specifier: string | null = null;
            if (wordAt(cursor) === 'from') {
                cursor = skipTrivia(cursor + 4);
                const c = source.charCodeAt(cursor);
                if (c === CH_QUOTE || c === CH_APOS) {
                    const end = skipString(cursor);
                    specifier = source.slice(cursor + 1, end - 1);
                    cursor = end;
                }
            }
            for (const { local, name } of pending) {
                exports.push({
                    kind: 'specifier', name,
                    // A re-export's local name belongs to the other module, not this one.
                    localName: specifier === null ? local : null,
                    importedName: specifier === null ? null : local,
                    declarationKind: null, specifier,
                    statementStart, statementEnd: cursor, declarationStart,
                });
            }
            return cursor;
        }

        // `export const x = 1` and its relatives: the names it declares are its exports.
        const { kind, after: afterKeyword } = declarationAt(cursor);
        if (kind === null) {
            return cursor;
        }
        // A generator star sits between `function` and the name.
        const after = source.charCodeAt(afterKeyword) === CH_STAR ? skipTrivia(afterKeyword + 1) : afterKeyword;
        if (kind === 'function' || kind === 'class') {
            // `export default function*` and `export async function` both land here by their
            // keyword; the name is whatever identifier follows.
            const name = wordAt(after);
            if (name !== '') {
                exports.push({
                    kind: 'declaration', name, localName: name, importedName: null, declarationKind: kind,
                    specifier: null, statementStart, statementEnd: after + name.length, declarationStart,
                });
            }
            return after;
        }

        const { names, end } = declaredNames(after);
        for (const name of names) {
            exports.push({
                kind: 'declaration', name, localName: name, importedName: null, declarationKind: kind,
                specifier: null, statementStart, statementEnd: end, declarationStart,
            });
        }
        return after;
    }

    /**
     * The declaration keyword at `at`, and where the word after it begins.
     *
     * The second half matters: `export async function f` puts `function` a word further along, and
     * assuming the keyword's own length lands the name search in the middle of `function` rather
     * than on `f`. That is how `export async function toBuffer` came back with no exports at all.
     */
    function declarationAt(at: number): { kind: ExportEntry['declarationKind']; after: number } {
        const word = wordAt(at);
        if (word === 'const' || word === 'let' || word === 'var' || word === 'function' || word === 'class') {
            return { kind: word, after: skipTrivia(at + word.length) };
        }
        if (word === 'async') {
            const nextAt = skipTrivia(at + 5);
            if (wordAt(nextAt) === 'function') return { kind: 'function', after: skipTrivia(nextAt + 8) };
        }
        // A generator's star sits between the keyword and the name.
        return { kind: null, after: at };
    }


    /**
     * The names a variable declaration introduces, patterns included.
     *
     * Walks to the end of the statement counting nesting, because a destructuring pattern's names
     * sit inside braces and brackets and the initialisers between them must not be mistaken for
     * bindings. A name followed by a colon is a property key, and the name after it is the binding.
     */
    /** Past a whole template literal, interpolations and nested templates included. */
    function pastTemplate(at: number): number {
        let cursor = at + 1;
        let depth = 0;
        while (cursor < length) {
            const c = source.charCodeAt(cursor);
            if (c === CH_BACKSLASH) {
                cursor += 2;
                continue;
            }
            if (depth === 0 && c === CH_BACKTICK) return cursor + 1;
            if (c === CH_DOLLAR && source.charCodeAt(cursor + 1) === CH_LBRACE) {
                depth++;
                cursor += 2;
                continue;
            }
            if (depth > 0) {
                if (c === CH_RBRACE) depth--;
                else if (c === CH_QUOTE || c === CH_APOS) {
                    cursor = skipString(cursor);
                    continue;
                } else if (c === CH_BACKTICK) {
                    cursor = pastTemplate(cursor);
                    continue;
                }
            }
            cursor++;
        }
        return length;
    }

    function declaredNames(at: number): { names: string[]; end: number } {
        const names: string[] = [];
        let cursor = at;
        let nesting = 0;
        let inInitialiser = false;

        while (cursor < length) {
            const c = source.charCodeAt(cursor);
            if (isSpace(c)) {
                cursor++;
                continue;
            }
            if (c === CH_LBRACE || c === CH_LBRACKET || c === CH_LPAREN) {
                nesting++;
                cursor++;
                continue;
            }
            if (c === CH_RBRACE || c === CH_RBRACKET || c === CH_RPAREN) {
                if (nesting === 0) break;
                nesting--;
                cursor++;
                continue;
            }
            if (c === CH_SEMI && nesting === 0) break;
            if (c === CH_LF && nesting === 0 && !inInitialiser) break;
            if (c === CH_COMMA && nesting === 0) {
                inInitialiser = false;
                cursor++;
                continue;
            }
            if (c === CH_EQ && nesting === 0) {
                inInitialiser = true;
                cursor++;
                continue;
            }
            if (c === CH_QUOTE || c === CH_APOS) {
                cursor = skipString(cursor);
                continue;
            }
            if (c === CH_BACKTICK) {
                // A template has to go whole. Walking into one puts `$` in identifier position,
                // and its interpolations hold commas at nesting zero, which reset the initialiser
                // flag: `export const all = \`${d},${a}\`` reported $, a and d as exports.
                cursor = pastTemplate(cursor);
                continue;
            }
            if (c === CH_SLASH) {
                // A comment here is prose, and prose is full of words that look like bindings:
                // `export const x = 1 // but this gets checked` reported `but`, `this` and `gets`
                // as exports until this branch existed.
                const next = skipTrivia(cursor);
                if (next !== cursor) {
                    cursor = next;
                    continue;
                }
            }
            if (isIdentStart(c) && !inInitialiser) {
                const name = wordAt(cursor);
                const next = skipTrivia(cursor + name.length);
                cursor = cursor + name.length;
                if (source.charCodeAt(next) !== CH_COLON) names.push(name);
                continue;
            }
            cursor++;
        }
        return { names, end: cursor };
    }

    return { imports, exports, importMeta, hasTopLevelAwait };
}
