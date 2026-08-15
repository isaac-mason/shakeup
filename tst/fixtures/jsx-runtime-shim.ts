// Minimal automatic-runtime shim: jsx/jsxs/Fragment/createElement build plain
// serializable trees (not React elements) so tests can deep-equal the rendered
// structure. Used by the execution oracle (G-JSX-2) as the injected
// `react/jsx-runtime` (and `react` root for the createElement fallback).
export const Fragment = { $$frag: true };

function element(kind: string, type: unknown, props: unknown, key: unknown): unknown {
    return { kind, type: normType(type), props: props ?? null, key: key === undefined ? null : key };
}
function normType(type: unknown): unknown {
    // Fragment is an object identity; represent it stably as the string 'Fragment'
    return type === Fragment ? 'Fragment' : type;
}

export function jsx(type: unknown, props: unknown, key?: unknown): unknown {
    return element('jsx', type, props, key);
}
export function jsxs(type: unknown, props: unknown, key?: unknown): unknown {
    return element('jsxs', type, props, key);
}
export function createElement(type: unknown, props: unknown, ...children: unknown[]): unknown {
    return { kind: 'createElement', type: normType(type), props: props ?? null, children };
}
