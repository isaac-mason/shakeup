import { N, type Node } from './ast.ts';

/**
 * JSX text/name utilities used by the JSX lowering pass (`passes/lower-jsx.ts`): entity decoding,
 * whitespace normalization, attribute-key rendering, and the static-children predicate. Pure
 * string/node helpers, no emit state.
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

export function normalizeJSXText(raw: string): string | null {
    const lines = raw.split('\n');
    let acc = '';
    let first = true;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].replace(/\r$/, '');
        if (i !== 0) line = line.replace(/^[ \t\v\f ]+/, '');
        if (i !== lines.length - 1) line = line.replace(/[ \t\v\f ]+$/, '');
        if (line === '') continue;
        if (!first) acc += ' ';
        acc += line;
        first = false;
    }
    if (acc === '') return null;
    return decodeJSXEntities(acc);
}

/** Render a JSX attribute/element name as a property-key token (identifier verbatim, else quoted). */
export function attrKeyText(name: Node): string {
    const raw =
        name.type === N.JSXNamespacedName ? `${(name.data.namespace as Node).name}:${(name.data.name as Node).name}` : name.name;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw) ? raw : JSON.stringify(raw);
}

/** true when children lower to a `jsxs` (array) call: >1 child, or a single spread child. */
export function childrenAreStatic(childTexts: string[]): boolean {
    if (childTexts.length > 1) return true;
    return childTexts.length === 1 && childTexts[0].startsWith('...');
}
