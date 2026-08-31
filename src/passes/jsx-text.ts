import { N, type Node } from '../ast/index.ts';
import { decodeJSXEntities } from '../util/jsx-entities.ts';

/**
 * JSX text/name helpers for the lowering pass (`passes/lower-jsx.ts`): whitespace normalization,
 * attribute-key rendering, and the static-children predicate. Pure string/node helpers, no emit
 * state. Entity decoding itself is a lower-level primitive — see `util/jsx-entities.ts`.
 */

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
