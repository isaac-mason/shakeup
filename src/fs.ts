/**
 * The only seam through which core code touches an environment; core (graph,
 * link, bundle) MUST NOT import node builtins directly — go through an Fs so
 * the browser stays a first-class target. Paths are posix-style strings.
 */
export type Fs = {
    read(id: string): string | null;
    exists(id: string): boolean;
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
