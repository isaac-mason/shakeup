/**
 * The only seam through which core code touches an environment; core MUST NOT
 * import node builtins directly — go through an Fs so the browser stays a
 * first-class target. Paths are posix-style strings.
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

/** Last path segment (posix basename). */
export function basenameOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? path : path.slice(i + 1);
}

/** POSIX relative path from directory `fromDir` to file `to`, always a valid ESM specifier
 *  (prefixed `./` when not ascending). Both are treated relative to a common (dist) root. */
export function relativePath(fromDir: string, to: string): string {
    const from = normalizePath(fromDir).replace(/^\//, '').split('/').filter(Boolean);
    const target = normalizePath(to).replace(/^\//, '').split('/').filter(Boolean);
    let i = 0;
    while (i < from.length && i < target.length && from[i] === target[i]) i++;
    const up = from.slice(i).map(() => '..');
    const down = target.slice(i);
    const joined = [...up, ...down].join('/');
    return up.length === 0 ? `./${joined}` : joined;
}
