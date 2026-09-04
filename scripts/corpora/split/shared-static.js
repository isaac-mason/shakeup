// Reached statically from the entry AND from both dynamic branches — the module that decides whether
// a shared chunk is formed or the code is duplicated into each consumer.
export const VERSION = '1.4.2';
export function formatLabel(kind, n) {
    return `${kind}:${VERSION}:${n.toFixed(2)}`;
}
export const registry = new Map();
