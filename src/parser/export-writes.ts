// Where a module assigns to its own exported bindings.
//
// A lowering that turns ES modules into something `new Function` can compile has to publish an
// exported binding again whenever it changes, or importers keep the value it had at link time.
// Finding those assignments is the one job that needs to tell `total = 1` on an exported binding
// from `total = 1` on a local that shadows it, and that question is why the lowering was parsing
// and running full semantic analysis over every byte it loaded: 460ms of a 575ms cold start, to
// find two assignments in five megabytes.
//
// So this is deliberately not a parser and does not share the record scanner's loop. It answers
// one question, over a handful of names, in a single character pass, and says so when it meets a
// shape it cannot resolve: `uncertain` means the caller should fall back to real analysis for
// that module rather than trust a guess. Being wrong is silent in both directions, a missed
// publish or a local's value published under an exported name, so the scanner never guesses.
//
// The caller rewrites each site's identifier alone, to a property whose setter republishes. That
// is why only the identifier span is reported and no expression bounds are: bounding an
// assignment expression lexically means precedence, `?:` and ASI, and rewriting the target
// instead makes `[total] = pair` and `for (total of xs)` fall out for free.

/** One occurrence of an exported name in a position that writes to it. */
export type ExportWrite = {
    name: string;
    /** The identifier itself, and nothing else. */
    start: number;
    end: number;
};

export type ExportWrites = {
    writes: ExportWrite[];
    /**
     * A shape the scanner could not resolve soundly. The module's writes are then unknown, not
     * absent, and the caller must fall back rather than emit what was found.
     */
    uncertain: boolean;
    /** Which shape gave up, for measuring what the fallback is actually paying for. */
    reason: string | null;
};

const CH_TAB = 9,
    CH_LF = 10,
    CH_CR = 13,
    CH_SPACE = 32;
const CH_QUOTE = 34,
    CH_HASH = 35,
    CH_DOLLAR = 36,
    CH_PERCENT = 37,
    CH_AMP = 38,
    CH_APOS = 39;
const CH_LPAREN = 40,
    CH_RPAREN = 41,
    CH_STAR = 42,
    CH_PLUS = 43,
    CH_COMMA = 44,
    CH_MINUS = 45;
const CH_DOT = 46,
    CH_SLASH = 47;
const CH_0 = 48,
    CH_9 = 57,
    CH_COLON = 58,
    CH_SEMI = 59;
const CH_LT = 60,
    CH_EQ = 61,
    CH_GT = 62,
    CH_QUESTION = 63;
const CH_A_UPPER = 65,
    CH_Z_UPPER = 90;
const CH_LBRACKET = 91,
    CH_BACKSLASH = 92,
    CH_RBRACKET = 93,
    CH_CARET = 94;
const CH_UNDERSCORE = 95,
    CH_BACKTICK = 96;
const CH_A = 97,
    CH_Z = 122,
    CH_LBRACE = 123,
    CH_PIPE = 124,
    CH_RBRACE = 125;

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

const isIdentStart = (c: number) => (c < 128 ? (CHAR_CLASS[c] & CLASS_IDENT_START) !== 0 : c !== 0xfeff);
const isIdentPart = (c: number) => (c < 128 ? (CHAR_CLASS[c] & CLASS_IDENT_PART) !== 0 : c !== 0xfeff);
const isSpace = (c: number) => (c < 128 ? (CHAR_CLASS[c] & CLASS_SPACE) !== 0 : c === 0xfeff);

/** Words after which a `/` opens a regular expression rather than dividing. */
const REGEX_PRECEDING = [
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'case',
    'do',
    'else',
    'yield',
    'await',
];
const REGEX_PRECEDING_SET = new Set(REGEX_PRECEDING);

/** Keywords this scanner acts on, which decide whether a word is worth slicing out. */
const KEYWORDS = ['var', 'let', 'const', 'function', 'class', 'catch', 'for'];

/**
 * A word filter sized so a few hundred names collide rarely. A collision costs one slice and one
 * set lookup, which is what every word used to cost.
 */
const FILTER_SIZE = 1 << 13;
const FILTER_MASK = FILTER_SIZE - 1;

/** The same hash the scanner builds character by character, for filling the filter. */
function hashOf(word: string): number {
    let hash = 0;
    for (let index = 0; index < word.length; index++) hash = (hash * 31 + word.charCodeAt(index)) | 0;
    return hash >>> 0;
}

/** Words that take a parenthesised head, which is not a parameter list however much it looks like one. */
const STATEMENT_HEADS = new Set([
    'if',
    'while',
    'for',
    'switch',
    'catch',
    'with',
    'do',
    'return',
    'typeof',
    'new',
    'delete',
    'void',
    'await',
    'yield',
    'throw',
    'case',
]);

/** Whether the operator at `at` assigns, as opposed to comparing or opening an arrow. */
function assignsAt(source: string, at: number): boolean {
    const c = source.charCodeAt(at);
    const second = source.charCodeAt(at + 1);
    const third = source.charCodeAt(at + 2);
    const fourth = source.charCodeAt(at + 3);
    if (c === CH_EQ) return second !== CH_EQ && second !== CH_GT;
    if (
        c === CH_PLUS ||
        c === CH_MINUS ||
        c === CH_STAR ||
        c === CH_SLASH ||
        c === CH_PERCENT ||
        c === CH_AMP ||
        c === CH_PIPE ||
        c === CH_CARET
    ) {
        if (second === CH_EQ) return third !== CH_EQ;
        // `**=`, `&&=` and `||=` take one character more than `+=`.
        if (second === c && third === CH_EQ) return fourth !== CH_EQ;
        return false;
    }
    if (c === CH_QUESTION) return second === CH_QUESTION && third === CH_EQ && fourth !== CH_EQ;
    if (c === CH_LT) return second === CH_LT && third === CH_EQ;
    if (c === CH_GT) {
        if (second === CH_GT && third === CH_EQ) return true;
        return second === CH_GT && third === CH_GT && fourth === CH_EQ;
    }
    return false;
}

/**
 * A lexical scope. `declared` and `pending` stay null until something in scope needs them, which
 * for the names being tracked is almost never, so a frame costs one small object and no sets.
 */
type Frame = {
    /** Whether `var` and function declarations stop here rather than passing outward. */
    fn: boolean;
    declared: Set<string> | null;
    pending: ExportWrite[] | null;
};

export function exportWrites(source: string, names: readonly string[]): ExportWrites {
    const writes: ExportWrite[] = [];
    if (names.length === 0) return { writes, uncertain: false, reason: null };

    const tracked = new Set(names);

    /**
     * Which words are worth cutting out of the source: a tracked name, a keyword this scanner
     * acts on, or a word after which a `/` opens a regular expression.
     *
     * Keyed by a hash built as the identifier is read, so a word is rejected by one typed array
     * load and never becomes a string. The obvious filters do not work here: bundled modules
     * export hundreds of names, so a table of first characters and one of lengths are both
     * saturated and reject nothing, and every identifier in the file was being sliced and looked
     * up. That was most of the scan.
     */
    const filter = new Uint8Array(FILTER_SIZE);
    for (const name of names) filter[hashOf(name) & FILTER_MASK] = 1;
    for (const word of KEYWORDS) filter[hashOf(word) & FILTER_MASK] = 1;
    for (const word of REGEX_PRECEDING) filter[hashOf(word) & FILTER_MASK] = 1;

    const length = source.length;
    let uncertain = false;
    let reason: string | null = null;
    const giveUp = (why: string) => {
        uncertain = true;
        reason ??= why;
    };

    let i = 0;
    const frames: Frame[] = [{ fn: true, declared: null, pending: null }];

    /**
     * What the next `{` should open.
     *
     * A function's body and its parameters are one scope, but the parameters are read at the `(`
     * and the scope only exists at the `{`, so the pending shape waits here. Without it a function
     * body was an ordinary block, `var` hoisted straight past it to module scope, and a local
     * `var total` stopped shadowing the export it was hiding.
     */
    let pendingFrame: { fn: boolean; declared: Set<string> | null } | null = null;

    /** `(`, `[` and `{` groups, flat rather than as objects: a file this size holds 200k of them. */
    const groupOpen: number[] = [];
    const groupAt: number[] = [];
    const groupFrames: number[] = [];
    const groupForHead: boolean[] = [];
    const groupOwnsFrame: boolean[] = [];
    const groupLoose: boolean[] = [];
    /** Whether the group is a class body, where `total = 1` declares a field and assigns nothing. */
    const groupClassBody: boolean[] = [];
    /**
     * Whether the group could be a destructuring pattern at all.
     *
     * `this[kHeaders] = null` puts a tracked name inside brackets followed by an `=`, which is the
     * exact shape of `[total] = pair` and is not it: a bracket after a value is a computed member
     * access. Without this, node's lib republished a symbol key as an exported binding.
     */
    const groupCouldBePattern: boolean[] = [];
    /**
     * Whether the group is an object literal, where `name(a, b) {}` is a method.
     *
     * Told apart from a block by what precedes the brace, and kept tight on purpose: the method
     * rule creates a scope for the parameters, so calling a block an object literal would turn
     * `if (total) { total = 1 }` into a shadowed binding and lose a real write.
     */
    const groupObjectLiteral: boolean[] = [];
    let pendingClassBody = false;

    /** Interpolation depths of the templates currently open, so `}` resumes the right one. */
    const templates: number[] = [];

    /**
     * The declarator list currently open, if any.
     *
     * Reading a declaration used to mean walking forward over every initialiser to find the comma
     * that started the next declarator, and then the main loop walked the same bytes again. That
     * second walk was a fifth of the scan. The main loop already passes every character once, so
     * the list is tracked as state instead.
     */
    let declDepth = -1;
    let declHoists = false;
    let expectBinding = false;

    /** The last significant character, which decides whether a `/` divides or opens a regex. */
    let lastSignificant = 0;
    /**
     * Where that character sits.
     *
     * Scanning backwards for it cannot see a line comment, and node's lib is full of sentences
     * ending in a full stop directly above an assignment: `// requires an update.` then
     * `cachedCwd = '';` read as a member access on the comment's last word. The main loop already
     * skips comments, so what it last saw is the answer.
     */
    let lastSignificantAt = -1;
    let lastWord = '';

    const frame = () => frames[frames.length - 1];

    /**
     * Bind a tracked name in the scope that owns it.
     *
     * Module scope is deliberately not a shadowing scope: a tracked name declared there is the
     * exported binding itself, so recording it would suppress every write to the very thing being
     * looked for. `export let total = 1; total = 2;` is the case that makes this explicit.
     */
    const declare = (name: string, hoists: boolean) => {
        let at = frames.length - 1;
        if (hoists) while (at > 0 && !frames[at].fn) at--;
        if (at === 0) return;
        const scope = frames[at];
        scope.declared ??= new Set();
        scope.declared.add(name);
    };

    const note = (name: string, start: number, end: number) => {
        const scope = frame();
        scope.pending ??= [];
        scope.pending.push({ name, start, end });
    };

    const popFrame = () => {
        const done = frames.pop();
        if (!done?.pending) return;
        const parent = frame();
        for (const write of done.pending) {
            // A name this scope declared is a different binding, so the write is not the export's.
            if (done.declared?.has(write.name)) continue;
            parent.pending ??= [];
            parent.pending.push(write);
        }
    };

    function skipLineComment(at: number): number {
        let j = at;
        while (j < length) {
            const c = source.charCodeAt(j);
            if (c === CH_LF || c === CH_CR) break;
            j++;
        }
        return j;
    }

    function skipBlockComment(at: number): number {
        const close = source.indexOf('*/', at);
        return close === -1 ? length : close + 2;
    }

    /** Past a quoted string, counting backslashes so an escaped quote does not end it. */
    function skipString(at: number, quote: number): number {
        let j = at + 1;
        while (j < length) {
            const c = source.charCodeAt(j);
            if (c === CH_BACKSLASH) {
                j += 2;
                continue;
            }
            if (c === quote) return j + 1;
            if (c === CH_LF && quote !== CH_BACKTICK) return j;
            j++;
        }
        return length;
    }

    /** Past a regular expression literal, including its class brackets and flags. */
    function skipRegex(at: number): number {
        let j = at + 1;
        let inClass = false;
        while (j < length) {
            const c = source.charCodeAt(j);
            if (c === CH_BACKSLASH) {
                j += 2;
                continue;
            }
            if (c === CH_LBRACKET) inClass = true;
            else if (c === CH_RBRACKET) inClass = false;
            else if (c === CH_SLASH && !inClass) {
                j++;
                while (j < length && isIdentPart(source.charCodeAt(j))) j++;
                return j;
            } else if (c === CH_LF) return j;
            j++;
        }
        return length;
    }

    /** Whether a `/` here opens a regular expression, judged by what came before it. */
    function regexHere(): boolean {
        if (lastSignificant === 0) return true;
        if (isIdentPart(lastSignificant)) return REGEX_PRECEDING_SET.has(lastWord);
        return lastSignificant !== CH_RPAREN && lastSignificant !== CH_RBRACKET && lastSignificant !== CH_RBRACE;
    }

    /** The first position at or after `at` that is neither space nor comment. */
    function skipTrivia(at: number): number {
        let j = at;
        while (j < length) {
            const c = source.charCodeAt(j);
            if (isSpace(c)) {
                j++;
                continue;
            }
            if (c === CH_SLASH) {
                const next = source.charCodeAt(j + 1);
                if (next === CH_SLASH) {
                    j = skipLineComment(j + 2);
                    continue;
                }
                if (next === CH_STAR) {
                    j = skipBlockComment(j + 2);
                    continue;
                }
            }
            return j;
        }
        return length;
    }

    /** Where the last non-trivia character before `at` sits, or -1 at the start of the file. */
    function beforeTriviaAt(at: number): number {
        let j = at - 1;
        while (j >= 0) {
            const c = source.charCodeAt(j);
            if (isSpace(c)) {
                j--;
                continue;
            }
            // A `*/` here means a block comment ends just before the position, so step over it.
            if (c === CH_SLASH && j > 0 && source.charCodeAt(j - 1) === CH_STAR) {
                const open = source.lastIndexOf('/*', j - 1);
                if (open === -1) return -1;
                j = open - 1;
                continue;
            }
            return j;
        }
        return -1;
    }

    const beforeTrivia = (at: number): number => {
        const j = beforeTriviaAt(at);
        return j === -1 ? 0 : source.charCodeAt(j);
    };

    /** The identifier at `at`, or the empty string when there is none. */
    function wordAt(at: number): string {
        if (at >= length || !isIdentStart(source.charCodeAt(at))) return '';
        let end = at + 1;
        while (end < length && isIdentPart(source.charCodeAt(end))) end++;
        return source.slice(at, end);
    }

    /** Where the innermost `for` head opened, if that is the group we are in. */
    function enclosingForHead(): number | null {
        const top = groupOpen.length - 1;
        if (top < 0 || groupOpen[top] !== CH_LPAREN || !groupForHead[top]) return null;
        return groupAt[top];
    }

    /** The position just past a `{...}`, `[...]` or `(...)`, or -1 if it does not close. */
    function patternEnd(at: number): number {
        let j = at;
        let depth = 0;
        while (j < length) {
            const c = source.charCodeAt(j);
            if (c === CH_LBRACE || c === CH_LBRACKET || c === CH_LPAREN) depth++;
            else if (c === CH_RBRACE || c === CH_RBRACKET || c === CH_RPAREN) {
                depth--;
                if (depth === 0) return j + 1;
            } else if (c === CH_QUOTE || c === CH_APOS || c === CH_BACKTICK) {
                j = skipString(j, c);
                continue;
            }
            j++;
        }
        return -1;
    }

    /**
     * Whether a span holds a tracked name in a position that writes to it.
     *
     * Used only for pattern defaults, which the main loop never walks. A read of a tracked name in
     * a default is ordinary and must not cost a fallback, so this asks the narrower question. It
     * over-approximates on purpose: a false yes costs a fallback, a false no would be silent.
     */
    function containsTrackedWrite(from: number, to: number): boolean {
        let j = from;
        while (j < to) {
            const c = source.charCodeAt(j);
            if (isIdentStart(c)) {
                let end = j + 1;
                while (end < to && isIdentPart(source.charCodeAt(end))) end++;
                if (tracked.has(source.slice(j, end))) {
                    const after = skipTrivia(end);
                    if (after < to && assignsAt(source, after)) return true;
                    const next = source.charCodeAt(after);
                    if (
                        (next === CH_PLUS && source.charCodeAt(after + 1) === CH_PLUS) ||
                        (next === CH_MINUS && source.charCodeAt(after + 1) === CH_MINUS)
                    )
                        return true;
                    const prev = beforeTriviaAt(j);
                    if (
                        prev > 0 &&
                        (source.charCodeAt(prev) === CH_PLUS || source.charCodeAt(prev) === CH_MINUS) &&
                        source.charCodeAt(prev - 1) === source.charCodeAt(prev)
                    )
                        return true;
                }
                j = end;
                continue;
            }
            j++;
        }
        return false;
    }

    function containsTracked(from: number, to: number): boolean {
        let j = from;
        while (j < to) {
            const c = source.charCodeAt(j);
            if (isIdentStart(c)) {
                let end = j + 1;
                while (end < to && isIdentPart(source.charCodeAt(end))) end++;
                if (tracked.has(source.slice(j, end))) return true;
                j = end;
                continue;
            }
            j++;
        }
        return false;
    }

    /**
     * The names a destructuring pattern binds, with the span of each, or null when its shape is
     * past this scanner.
     *
     * A key is not a binding. `{ total: other }` binds `other` and leaves `total` alone, which is
     * why a pattern cannot be treated as the set of names that appear in it.
     */
    function patternBindings(at: number): { names: ExportWrite[]; end: number } | null {
        const names: ExportWrite[] = [];
        const end = walkPattern(at, names);
        return end === -1 ? null : { names, end };
    }

    function walkPattern(at: number, names: ExportWrite[]): number {
        const open = source.charCodeAt(at);
        if (open !== CH_LBRACE && open !== CH_LBRACKET) return -1;
        const closer = open === CH_LBRACE ? CH_RBRACE : CH_RBRACKET;
        let j = skipTrivia(at + 1);

        while (j < length) {
            let c = source.charCodeAt(j);
            if (c === closer) return skipTrivia(j + 1);
            if (c === CH_COMMA) {
                // An array pattern may hold holes: `[, , third]`.
                j = skipTrivia(j + 1);
                continue;
            }
            if (c === CH_DOT && source.charCodeAt(j + 1) === CH_DOT && source.charCodeAt(j + 2) === CH_DOT) {
                j = skipTrivia(j + 3);
                c = source.charCodeAt(j);
            }

            if (open === CH_LBRACE) {
                if (c === CH_LBRACKET) {
                    // A computed key names nothing and holds an arbitrary expression.
                    const close = patternEnd(j);
                    if (close === -1) return -1;
                    j = skipTrivia(close);
                    if (source.charCodeAt(j) !== CH_COLON) return -1;
                    j = skipTrivia(j + 1);
                } else if (c === CH_QUOTE || c === CH_APOS) {
                    j = skipTrivia(skipString(j, c));
                    if (source.charCodeAt(j) !== CH_COLON) return -1;
                    j = skipTrivia(j + 1);
                } else if (isIdentStart(c) || (c >= CH_0 && c <= CH_9)) {
                    const key = readWordOrNumber(j);
                    const afterKey = skipTrivia(j + key.length);
                    if (source.charCodeAt(afterKey) === CH_COLON) {
                        j = skipTrivia(afterKey + 1);
                    } else {
                        // Shorthand: the key is itself the binding.
                        names.push({ name: key, start: j, end: j + key.length });
                        j = skipDefault(afterKey, closer);
                        continue;
                    }
                } else {
                    return -1;
                }
            }

            const target = source.charCodeAt(j);
            if (target === CH_LBRACE || target === CH_LBRACKET) {
                const next = walkPattern(j, names);
                if (next === -1) return -1;
                j = next;
            } else if (isIdentStart(target)) {
                const name = wordAt(j);
                names.push({ name, start: j, end: j + name.length });
                j = skipTrivia(j + name.length);
            } else {
                return -1;
            }
            j = skipDefault(j, closer);
        }
        return -1;
    }

    /** Past `= <expression>` if one is here, stopping at the element's own comma or close. */
    function skipDefault(at: number, closer: number): number {
        if (at >= length || source.charCodeAt(at) !== CH_EQ || !assignsAt(source, at)) return at;
        const from = at + 1;
        let j = at + 1;
        let depth = 0;
        while (j < length) {
            const c = source.charCodeAt(j);
            if (c === CH_LPAREN || c === CH_LBRACKET || c === CH_LBRACE) depth++;
            else if (c === CH_RPAREN || c === CH_RBRACKET || c === CH_RBRACE) {
                if (depth === 0 && c === closer) return j;
                depth--;
            } else if (c === CH_QUOTE || c === CH_APOS || c === CH_BACKTICK) {
                j = skipString(j, c);
                continue;
            } else if (depth === 0 && c === CH_COMMA) break;
            j++;
        }
        // A default is ordinary code and can hold a write of its own, as in
        // `{ name = \`ctx ${index++}\` }`. The main loop never sees it, so rather than miss one
        // the module goes to the fallback when a tracked name is in there at all.
        if (containsTrackedWrite(from, Math.min(j, length))) giveUp('write inside a pattern default');
        return Math.min(j, length);
    }

    function readWordOrNumber(at: number): string {
        let end = at;
        while (end < length && (isIdentPart(source.charCodeAt(end)) || source.charCodeAt(end) === CH_DOT)) end++;
        return source.slice(at, end);
    }

    /** Bind a declarator's name in whichever scope the declaration belongs to. */
    function bindDeclared(name: string): void {
        const head = enclosingForHead();
        if (head === null) {
            declare(name, declHoists);
            return;
        }
        // `for (let total of xs)` binds for the head as well as the body, and the body's scope
        // does not exist until its brace, so the binding waits for it.
        const scope = frame();
        scope.declared ??= new Set();
        scope.declared.add(name);
        const body = skipTrivia(patternEnd(head));
        if (source.charCodeAt(body) === CH_LBRACE) {
            pendingFrame ??= { fn: false, declared: null };
            pendingFrame.declared ??= new Set();
            pendingFrame.declared.add(name);
        } else if (containsTrackedWrite(body, unbracedEnd(body))) {
            // A single statement body has no scope to bind in, but it only matters if it writes.
            giveUp('for head without a block body');
        }
    }

    /**
     * Whether a keyword at `at` begins a statement, which is what separates a declaration from an
     * expression, read from the character before it rather than from a token stream.
     */
    function isStatementPosition(at: number): boolean {
        const before = beforeTrivia(at);
        if (before === 0) return true;
        if (isIdentPart(before)) {
            const word = lastWordBefore(at);
            if (word === 'async') return isStatementPosition(lastWordStart(at));
            return word === 'export' || word === 'default';
        }
        return before === CH_SEMI || before === CH_RBRACE || before === CH_LBRACE || before === CH_RPAREN;
    }

    function lastWordStart(at: number): number {
        let end = at;
        while (end > 0 && isSpace(source.charCodeAt(end - 1))) end--;
        let start = end;
        while (start > 0 && isIdentPart(source.charCodeAt(start - 1))) start--;
        return start;
    }

    function lastWordBefore(at: number): string {
        let end = at;
        while (end > 0 && isSpace(source.charCodeAt(end - 1))) end--;
        const start = lastWordStart(at);
        return start === end ? '' : source.slice(start, end);
    }

    /**
     * The tracked names a parameter list binds.
     *
     * A parameter that shadows an exported name is the case this whole scanner exists to get
     * right, so the list is read exactly: names, defaults, rest and patterns.
     */
    function bindingsIn(open: number, close: number): Set<string> | null {
        if (!containsTracked(open, close)) return null;
        const bound = new Set<string>();
        let j = skipTrivia(open + 1);
        let expectName = true;
        while (j < close - 1) {
            const before = j;
            j = skipTrivia(j);
            if (j !== before) continue;
            const c = source.charCodeAt(j);
            if (c === CH_COMMA) {
                expectName = true;
                j = skipTrivia(j + 1);
                continue;
            }
            if (c === CH_DOT && source.charCodeAt(j + 1) === CH_DOT && source.charCodeAt(j + 2) === CH_DOT) {
                j = skipTrivia(j + 3);
                continue;
            }
            if (isIdentStart(c) && expectName) {
                const name = wordAt(j);
                if (tracked.has(name)) bound.add(name);
                j = skipTrivia(j + name.length);
                expectName = false;
                continue;
            }
            if ((c === CH_LBRACE || c === CH_LBRACKET) && expectName) {
                const pattern = patternBindings(j);
                if (!pattern) {
                    giveUp('parameter pattern');
                    return bound;
                }
                for (const bind of pattern.names) if (tracked.has(bind.name)) bound.add(bind.name);
                j = pattern.end;
                expectName = false;
                continue;
            }
            if (!expectName && source.charCodeAt(j) === CH_EQ && assignsAt(source, j)) {
                j = skipDefault(j, CH_RPAREN);
                continue;
            }
            giveUp('parameter shape');
            return bound;
        }
        return bound;
    }

    /**
     * A function's name and parameters.
     *
     * A function declaration binds its name in the enclosing scope. A function expression binds it
     * only inside itself, so `const g = function total() {}` must not be read as shadowing the
     * export named total everywhere after it.
     */
    function readFunction(at: number, keywordAt: number): void {
        let j = skipTrivia(at);
        if (source.charCodeAt(j) === CH_STAR) j = skipTrivia(j + 1);
        const name = wordAt(j);
        let ownName: string | null = null;
        if (name) {
            if (tracked.has(name)) {
                if (isStatementPosition(keywordAt)) declare(name, true);
                ownName = name;
            }
            j = skipTrivia(j + name.length);
        }
        if (source.charCodeAt(j) !== CH_LPAREN) return;
        const close = patternEnd(j);
        if (close === -1) return;
        const bound = bindingsIn(j, close) ?? (ownName ? new Set<string>() : null);
        if (ownName && bound) bound.add(ownName);
        pendingFrame = { fn: true, declared: bound };
        i = close;
    }

    function readClassName(at: number, keywordAt: number): void {
        const j = skipTrivia(at);
        const name = wordAt(j);
        pendingClassBody = true;
        // `class {` is an expression with no name, and `class X extends` still binds X.
        if (!name || name === 'extends' || !tracked.has(name)) return;
        if (isStatementPosition(keywordAt)) {
            declare(name, false);
            return;
        }
        // A class expression binds its name only inside itself, so
        // `Resource = class Resource {}` assigns the outer binding and shadows nothing.
        pendingFrame = { fn: false, declared: new Set([name]) };
    }

    function readCatchParam(at: number): void {
        const j = skipTrivia(at);
        if (source.charCodeAt(j) !== CH_LPAREN) return;
        const close = patternEnd(j);
        if (close === -1) return;
        pendingFrame = { fn: false, declared: bindingsIn(j, close) };
        i = close;
    }

    /**
     * A parameter list that turned out to belong to an arrow.
     *
     * There is no keyword to catch an arrow at its start, so its parameters are read once the
     * `=>` after the closing paren proves what they were. Any write already noted inside the
     * parens was a defaulted parameter, not an assignment, and is taken back.
     */
    function readArrowParams(openAt: number, closeAt: number, bodyAt: number): void {
        const params = bindingsIn(openAt, closeAt);
        if (!params || params.size === 0) return;
        const pending = frame().pending;
        if (pending) {
            frame().pending = pending.filter(
                (write) => !(write.start >= openAt && write.end <= closeAt && params.has(write.name)),
            );
        }
        const body = skipTrivia(bodyAt);
        if (source.charCodeAt(body) === CH_LBRACE) {
            pendingFrame = { fn: true, declared: params };
            return;
        }
        // A concise body is an expression with no brace to hang a scope on. Its extent cannot be
        // found without parsing, so the rest of the enclosing group stands in: over-reaching only
        // ever costs a fallback, while under-reaching would miss a write.
        if (containsTrackedWrite(body, unbracedEnd(body))) giveUp('concise arrow body with a tracked parameter');
    }

    /**
     * Where the expression or statement starting at `at` ends: the first `,` or `;` at its own
     * depth, or the bracket that closes around it.
     *
     * Used for the two bodies that have no brace to hang a scope on, a concise arrow body and a
     * loop body without braces. Both end at one of those, so this bounds them without parsing.
     * An earlier version ran to the end of the enclosing group, which at module scope is the end
     * of the file, so a 1.6MB module fell back over one defaulted arrow parameter.
     */
    function unbracedEnd(at: number): number {
        let j = at;
        let depth = 0;
        while (j < length) {
            const c = source.charCodeAt(j);
            if (c === CH_LPAREN || c === CH_LBRACKET || c === CH_LBRACE) depth++;
            else if (c === CH_RPAREN || c === CH_RBRACKET || c === CH_RBRACE) {
                if (depth === 0) return j;
                depth--;
            } else if (c === CH_QUOTE || c === CH_APOS || c === CH_BACKTICK) {
                j = skipString(j, c);
                continue;
            } else if (depth === 0 && (c === CH_COMMA || c === CH_SEMI)) return j;
            j++;
        }
        return length;
    }

    /** Open a template, stopping at its close or its first `${`. Returns the position past that. */
    function readTemplateChunk(at: number): number {
        let j = at;
        while (j < length) {
            const c = source.charCodeAt(j);
            if (c === CH_BACKSLASH) {
                j += 2;
                continue;
            }
            if (c === CH_BACKTICK) return j + 1;
            if (c === CH_DOLLAR && source.charCodeAt(j + 1) === CH_LBRACE) {
                templates.push(groupOpen.length);
                groupOpen.push(CH_LBRACE);
                groupAt.push(j + 1);
                groupFrames.push(frames.length);
                groupForHead.push(false);
                groupOwnsFrame.push(false);
                groupLoose.push(false);
                groupClassBody.push(false);
                groupCouldBePattern.push(false);
                groupObjectLiteral.push(false);
                return j + 2;
            }
            j++;
        }
        return length;
    }

    while (i < length) {
        const c = source.charCodeAt(i);

        if (isSpace(c)) {
            // A newline cannot end a declarator list while it is still waiting for a name:
            // `var\n  SCOPE_TOP = 1,\n  SCOPE_FUNCTION = 2;` is one declaration, and reading it
            // as ended made every name in it an assignment.
            if (declDepth !== -1 && !expectBinding && (c === CH_LF || c === CH_CR) && groupOpen.length === declDepth) {
                // No semicolon: the list ends unless what follows can continue it.
                const next = skipTrivia(i + 1);
                if (next >= length) declDepth = -1;
                else {
                    const nc = source.charCodeAt(next);
                    if (nc !== CH_COMMA && nc !== CH_DOT && !assignsAt(source, next) && isIdentStart(nc)) declDepth = -1;
                }
            }
            i++;
            continue;
        }

        if (c === CH_SLASH) {
            const next = source.charCodeAt(i + 1);
            if (next === CH_SLASH) {
                i = skipLineComment(i + 2);
                continue;
            }
            if (next === CH_STAR) {
                i = skipBlockComment(i + 2);
                continue;
            }
            if (regexHere()) {
                lastSignificantAt = i;
                i = skipRegex(i);
                lastSignificant = CH_SLASH;
                continue;
            }
            lastSignificant = c;
            lastSignificantAt = i;
            i++;
            continue;
        }

        if (c === CH_QUOTE || c === CH_APOS) {
            lastSignificantAt = i;
            i = skipString(i, c);
            lastSignificant = CH_QUOTE;
            continue;
        }

        if (c === CH_BACKTICK) {
            lastSignificantAt = i;
            i = readTemplateChunk(i + 1);
            lastSignificant = CH_BACKTICK;
            continue;
        }

        // A pattern in binding position is the declarator, read whole rather than character by
        // character, so the `=` after it is not mistaken for a destructuring assignment.
        if ((c === CH_LBRACE || c === CH_LBRACKET) && expectBinding && declDepth === groupOpen.length) {
            const bound = patternBindings(i);
            if (!bound) {
                giveUp('destructuring declaration');
                const close = patternEnd(i);
                i = close === -1 ? length : close;
            } else {
                for (const bind of bound.names) if (tracked.has(bind.name)) bindDeclared(bind.name);
                i = bound.end;
            }
            expectBinding = false;
            lastSignificant = CH_RBRACE;
            lastSignificantAt = i - 1;
            continue;
        }

        if (c === CH_LBRACE || c === CH_LBRACKET || c === CH_LPAREN) {
            // A `for` head binds for the head as well as the body, and its own later clauses can
            // assign to what it bound: `for (let i = 0, j = n - 1; i < n; j = i++)`.
            const forHead = c === CH_LPAREN && lastWord === 'for';
            if (forHead) frames.push({ fn: false, declared: null, pending: null });
            groupOpen.push(c);
            groupAt.push(i);
            groupFrames.push(frames.length);
            groupForHead.push(forHead);
            groupOwnsFrame.push(forHead);
            groupLoose.push(false);
            groupClassBody.push(c === CH_LBRACE && pendingClassBody);
            if (c === CH_LBRACE) pendingClassBody = false;
            // A bracket or brace that follows a value continues an expression rather than opening
            // one, so it is an index or a block and never a pattern.
            // A class body's own brackets name computed fields: `class C { [kState] = new Map() }`
            // has the shape of `[total] = pair` and is a declaration.
            const inClassBody = groupClassBody.length > 1 && groupClassBody[groupClassBody.length - 2];
            groupCouldBePattern.push(
                !inClassBody &&
                    !(
                        isIdentPart(lastSignificant) ||
                        lastSignificant === CH_RPAREN ||
                        lastSignificant === CH_RBRACKET ||
                        lastSignificant === CH_QUOTE ||
                        lastSignificant === CH_BACKTICK
                    ),
            );
            // Deliberately not `>`: an arrow's block body also follows one, and calling that an
            // object literal made `if (total) { total = 1 }` inside an arrow look like a method
            // whose parameter shadows the export, which loses the write and says nothing.
            // `() => ({ ... })` needs its parens, and those are covered by the `(` case.
            groupObjectLiteral.push(
                c === CH_LBRACE &&
                    (lastSignificant === CH_EQ ||
                        lastSignificant === CH_LPAREN ||
                        lastSignificant === CH_COMMA ||
                        lastSignificant === CH_LBRACKET ||
                        lastSignificant === CH_COLON ||
                        lastSignificant === 0 ||
                        lastWord === 'return'),
            );
            // A brace opens a scope. An object literal does too as far as this is concerned: it
            // declares nothing, so an extra frame costs a push and changes no answer.
            if (c === CH_LBRACE) {
                frames.push({ fn: pendingFrame?.fn ?? false, declared: pendingFrame?.declared ?? null, pending: null });
                pendingFrame = null;
            }
            lastSignificant = c;
            lastSignificantAt = i;
            i++;
            continue;
        }

        if (c === CH_RBRACE || c === CH_RBRACKET || c === CH_RPAREN) {
            const top = groupOpen.length - 1;
            const open = top >= 0 ? groupOpen[top] : 0;
            const at = top >= 0 ? groupAt[top] : 0;
            const frameFloor = top >= 0 ? groupFrames[top] : 1;
            const loose = top >= 0 ? groupLoose[top] && groupCouldBePattern[top] : false;
            const ownsFrame = top >= 0 ? groupOwnsFrame[top] : false;
            if (top >= 0) {
                groupOpen.pop();
                groupAt.pop();
                groupFrames.pop();
                groupForHead.pop();
                groupOwnsFrame.pop();
                groupLoose.pop();
                groupClassBody.pop();
                groupCouldBePattern.pop();
                groupObjectLiteral.pop();
            }

            if (open === CH_LBRACE) {
                while (frames.length > frameFloor) popFrame();
                // A `}` that closes a template's `${` resumes the template rather than code.
                if (templates.length > 0 && templates[templates.length - 1] === groupOpen.length) {
                    templates.pop();
                    lastSignificantAt = i;
                    i = readTemplateChunk(i + 1);
                    lastSignificant = CH_BACKTICK;
                    continue;
                }
            }

            // A group holding an unclassified tracked name, closed by an `=`, is a destructuring
            // assignment: `[total] = pair`. The names inside were targets, not reads.
            if (loose) {
                const after = skipTrivia(i + 1);
                if (after < length && assignsAt(source, after)) {
                    const bound = patternBindings(at);
                    if (!bound) giveUp('destructuring assignment');
                    else {
                        for (const bind of bound.names) {
                            if (tracked.has(bind.name)) note(bind.name, bind.start, bind.end);
                        }
                    }
                }
            }
            if (open === CH_LPAREN) {
                const after = skipTrivia(i + 1);
                if (source.charCodeAt(after) === CH_EQ && source.charCodeAt(after + 1) === CH_GT) {
                    readArrowParams(at, i + 1, after + 2);
                }
            }
            if (ownsFrame) popFrame();
            if (declDepth !== -1 && groupOpen.length < declDepth) declDepth = -1;
            lastSignificant = c;
            lastSignificantAt = i;
            i++;
            continue;
        }

        if (isIdentStart(c)) {
            const start = i;
            let end = i + 1;
            let hash = (c | 0) >>> 0;
            while (end < length) {
                const next = source.charCodeAt(end);
                if (!isIdentPart(next)) break;
                hash = ((hash * 31 + next) | 0) >>> 0;
                end++;
            }
            i = end;
            const before = lastSignificant;
            const beforeAt = lastSignificantAt;
            lastSignificant = source.charCodeAt(end - 1);
            lastSignificantAt = end - 1;

            // Method shorthand, in a class body or an object literal: `add(item, n = xs.length)`
            // and `async setup(global, { jsdom = {} })`. There is no `function` keyword to catch
            // either, so without this the parameter list is ordinary code and a defaulted
            // parameter reads as an assignment to the export it shadows.
            const top = groupOpen.length - 1;
            // A statement head has the same shape as a method: `if (total) { ... }`. Reading one
            // as a parameter list would shadow the export inside the block.
            if (top >= 0 && (groupClassBody[top] || groupObjectLiteral[top]) && !STATEMENT_HEADS.has(source.slice(start, end))) {
                const afterName = skipTrivia(end);
                if (source.charCodeAt(afterName) === CH_LPAREN) {
                    const close = patternEnd(afterName);
                    // A class body holds nothing but members, so the trailing brace is implied
                    // there. In an object literal a call is possible, so the body has to be seen.
                    if (close !== -1 && (groupClassBody[top] || source.charCodeAt(skipTrivia(close)) === CH_LBRACE)) {
                        pendingFrame = { fn: true, declared: bindingsIn(afterName, close) };
                        i = close;
                        lastSignificant = CH_RPAREN;
                        lastSignificantAt = close - 1;
                        continue;
                    }
                }
            }

            // Reject before anything is sliced out of the source. A word not worth slicing is
            // also not in REGEX_PRECEDING, so clearing lastWord keeps the regex decision right
            // rather than leaving a stale word behind.
            if (filter[hash & FILTER_MASK] === 0) {
                lastWord = '';
                // A declarator name this scanner does not track still ends the binding position.
                // Leaving it open made the `{` of `const o = { total: 1 }` read as a pattern.
                if (expectBinding && declDepth === groupOpen.length) expectBinding = false;
                continue;
            }
            const word = source.slice(start, end);
            lastWord = word;

            // A property that happens to spell a keyword is not one: `promise.catch((err) => {})`
            // was read as a try/catch clause, which gave its callback a scope built from the
            // wrong parameters and could have shadowed an export inside it.
            const isMember = before === CH_DOT || before === CH_HASH;

            if (!isMember && (word === 'var' || word === 'let' || word === 'const')) {
                declDepth = groupOpen.length;
                declHoists = word === 'var';
                expectBinding = true;
                continue;
            }
            if (!isMember && word === 'function') {
                readFunction(end, start);
                continue;
            }
            if (!isMember && word === 'class') {
                readClassName(end, start);
                continue;
            }
            if (!isMember && word === 'catch') {
                readCatchParam(end);
                continue;
            }

            const isTracked = tracked.has(word);

            // A declarator's own name is a binding, not an assignment. Rewriting `let total = 1`
            // as `let _live.total = 1` is not a redundant publish, it does not parse.
            if (expectBinding && declDepth === groupOpen.length) {
                if (isTracked) bindDeclared(word);
                expectBinding = false;
                continue;
            }
            if (!isTracked) continue;

            // A class field: `class C { total = 1 }` declares, it does not assign.
            if (groupClassBody.length > 0 && groupClassBody[groupClassBody.length - 1]) continue;

            // A property, not the binding: `options.total = 1` is the case that makes a purely
            // textual search for an assignment useless.
            if (before === CH_DOT) continue;
            // A private name is a member too: `this.#fs = x` writes no binding called `fs`.
            if (before === CH_HASH) continue;
            // A property key, `{ total: x }`, names nothing.
            const after = skipTrivia(end);
            if (source.charCodeAt(after) === CH_COLON && before !== CH_QUESTION) continue;

            if (after < length && assignsAt(source, after)) {
                note(word, start, end);
                continue;
            }
            // `total++`.
            const nextChar = source.charCodeAt(after);
            if (
                (nextChar === CH_PLUS && source.charCodeAt(after + 1) === CH_PLUS) ||
                (nextChar === CH_MINUS && source.charCodeAt(after + 1) === CH_MINUS)
            ) {
                note(word, start, end);
                continue;
            }
            // `++total`. The two characters have to be adjacent to each other, not merely the
            // nearest thing before the name: `a - total` puts a `-` before it and another two
            // positions back, and reading that as `--total` republished half the arithmetic in
            // the file under an exported name.
            if (
                (before === CH_PLUS || before === CH_MINUS) &&
                beforeAt > 0 &&
                source.charCodeAt(beforeAt - 1) === before &&
                // `++counts[key]` updates a property, and leaves the binding alone.
                nextChar !== CH_DOT &&
                nextChar !== CH_LBRACKET
            ) {
                note(word, start, end);
                continue;
            }
            // `total => ...` is a parameter, not a read of the export it shadows.
            if (nextChar === CH_EQ && source.charCodeAt(after + 1) === CH_GT) {
                const body = skipTrivia(after + 2);
                if (source.charCodeAt(body) === CH_LBRACE) pendingFrame = { fn: true, declared: new Set([word]) };
                else if (containsTrackedWrite(body, unbracedEnd(body))) {
                    giveUp('concise arrow body with a tracked parameter');
                }
                continue;
            }
            // `for (total of xs)` assigns on every turn of the loop.
            const followingWord = wordAt(after);
            if ((followingWord === 'of' || followingWord === 'in') && enclosingForHead() !== null) {
                note(word, start, end);
                continue;
            }
            // Read, or something this scanner does not classify. The group it sits in decides:
            // closed by an `=`, it was a destructuring target after all.
            if (groupLoose.length > 0) groupLoose[groupLoose.length - 1] = true;
            continue;
        }

        if (declDepth !== -1 && groupOpen.length === declDepth) {
            if (c === CH_COMMA) expectBinding = true;
            else if (c === CH_SEMI) declDepth = -1;
        }

        lastSignificant = c;
        lastSignificantAt = i;
        i++;
    }

    while (frames.length > 1) popFrame();
    for (const write of frames[0].pending ?? []) writes.push(write);
    writes.sort((a, b) => a.start - b.start);
    return { writes, uncertain, reason };
}
