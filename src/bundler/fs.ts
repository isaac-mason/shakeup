/** A value or a promise of it. An `Fs` may answer synchronously (node/in-memory) or
 *  asynchronously (browser OPFS); the graph build awaits either. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The only seam through which core code touches an environment; core MUST NOT
 * import node builtins directly — go through an Fs so the browser stays a
 * first-class target. Paths are posix-style strings. Methods may be sync OR async
 * (async filesystems like OPFS are first-class) — the graph build awaits them.
 */
export type Fs = {
    read(id: string): MaybePromise<string | null>;
    exists(id: string): MaybePromise<boolean>;
    /** Is this path a FILE (as opposed to a directory)? The resolver's "load as file" step needs the
     *  distinction: node's algorithm tries X as a file BEFORE X.js and X/index.js, so a directory
     *  named `one` sitting next to `one.js` must not answer `import './one'`. Both oracles carry the
     *  bit — Rollup's `findFile` checks `stats.isFile()` on an `lstat`, and oxc-resolver's
     *  `FileSystem::metadata` returns `FileMetadata { is_file, is_dir, is_symlink }`.
     *
     *  Optional, and absent means `exists` answers for it. That is exactly right for an Fs with no
     *  directories at all, which is every in-memory one; it is wrong for a real filesystem, so
     *  {@link createNodeFs} implements it. */
    isFile?(id: string): MaybePromise<boolean>;
    realpath?(id: string): MaybePromise<string>;
    /** Raw bytes, for the module types whose loader cannot go through text: `base64`, `binary` and
     *  `dataurl`. rolldown splits its read the same way — `StrOrBytes::Bytes` for exactly those
     *  three (`load_source.rs:187`) — because decoding a PNG as UTF-8 corrupts every byte above
     *  0x7F. Optional: an Fs that omits it still bundles those types, from the UTF-8 encoding of
     *  `read`, which is right for text-shaped input and lossy for anything else. */
    readBytes?(id: string): MaybePromise<Uint8Array | null>;
};

/** `Fs.isFile` where the Fs has it, `Fs.exists` where it does not — see {@link Fs.isFile}. Every
 *  "load as file" probe in either resolver goes through this, because node's algorithm tries X as a
 *  FILE before X.js and X/index.js and a bare `exists` cannot tell a directory apart. */
export async function fileExists(fs: Fs, id: string): Promise<boolean> {
    return fs.isFile === undefined ? await fs.exists(id) : await fs.isFile(id);
}

/** In-memory Fs over a map of id -> source; the browser default. A `Uint8Array` value is a binary
 *  file: `read` decodes it as UTF-8 and `readBytes` hands it back untouched. */
export function createMemoryFs(files: Map<string, string | Uint8Array> | Record<string, string | Uint8Array>): Fs {
    const map = files instanceof Map ? files : new Map(Object.entries(files));
    return {
        read: (id) => {
            const v = map.get(id);
            return v === undefined ? null : typeof v === 'string' ? v : new TextDecoder().decode(v);
        },
        exists: (id) => map.has(id),
        // Every entry is a file — there are no directories in a memory fs.
        isFile: (id) => map.has(id),
        readBytes: (id) => {
            const v = map.get(id);
            return v === undefined ? null : typeof v === 'string' ? new TextEncoder().encode(v) : v;
        },
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
