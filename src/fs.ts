/**
 * The only seam through which core code touches an environment; core (graph,
 * link, bundle) MUST NOT import node builtins directly — go through an Fs so
 * the browser stays a first-class target. Paths are posix-style strings.
 */
export type Fs = {
    /** Source text for a resolved id, or null if it doesn't exist. */
    read(id: string): string | null;
    /** Cheap existence probe (resolution runs many of these). */
    exists(id: string): boolean;
    /**
     * Canonicalize an id (resolve symlinks); identity when absent. Required for
     * pnpm-workspace correctness: one real file via two symlink paths must be
     * ONE module, and nested .pnpm dependency walks start from the real path.
     */
    realpath?(id: string): string;
};

/** In-memory Fs over a map of id -> source; the browser default. */
export function createMemoryFs(files: Map<string, string> | Record<string, string>): Fs {
    const map = files instanceof Map ? files : new Map(Object.entries(files));
    return {
        read: (id) => map.get(id) ?? null,
        exists: (id) => map.has(id),
    };
}

/* ---------------------------------------------------- pure path utilities */

/** Normalize a posix path: resolve '.' and '..' segments, collapse '//'. */
export function normalizePath(path: string): string {
    const absolute = path.startsWith('/');
    const out: string[] = [];
    for (const seg of path.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
            else if (!absolute) out.push('..');
        } else out.push(seg);
    }
    return (absolute ? '/' : '') + out.join('/');
}

/** Directory of a posix path ('' for a bare name). */
export function dirnameOf(path: string): string {
    const i = path.lastIndexOf('/');
    if (i < 0) return '';
    if (i === 0) return '/';
    return path.slice(0, i);
}

/** Join a relative specifier onto an importer's directory and normalize. */
export function joinPath(dir: string, relative: string): string {
    return normalizePath(dir === '' ? relative : `${dir}/${relative}`);
}
