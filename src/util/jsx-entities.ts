/**
 * The HTML named-entity table and the JSX entity decoder. A zero-dependency string primitive, kept
 * apart from the JSX transform helpers in `passes/jsx-text.ts` because the ESTree projection needs
 * decoding without any of the rest — and because `ast/` cannot import `passes/`.
 *
 * oxc draws the same line: the table is `oxc_syntax::xml_entities`, a layer BELOW the AST, while the
 * whitespace/attribute helpers live with the JSX transform in `oxc_transformer::jsx::jsx_impl`.
 */

const JSX_NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '©',
    reg: '®',
    trade: '™',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    bull: '•',
    middot: '·',
    deg: '°',
    laquo: '«',
    raquo: '»',
    times: '×',
    divide: '÷',
    euro: '€',
    pound: '£',
    cent: '¢',
    yen: '¥',
    sect: '§',
    para: '¶',
    dagger: '†',
    Dagger: '‡',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
};

export function decodeJSXEntities(s: string): string {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
        if (body[0] === '#') {
            const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        const named = JSX_NAMED_ENTITIES[body];
        return named !== undefined ? named : m;
    });
}
