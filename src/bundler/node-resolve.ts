import { dirnameOf, type Fs, joinPath, normalizePath } from './fs';
import type { ModuleDefFormat } from './graph-types';

/** The minimal context the resolver needs: a diagnostics sink. */
type ResolveCtx = { warn(message: string): void };

export type NodeResolverOptions = {
    fs: Fs;
    conditions?: string[];
    extensions?: string[];
    mainFields?: string[];
    /** Where resolution diagnostics go (unresolved subpaths, condition misses, …). */
    warn: (message: string) => void;
};

/** Resolves bare specifiers (node_modules / package `exports` / workspace members) and
 *  browser-field remaps. `load` returns '' for a `browser: false`-disabled module. */
export type NodeResolver = {
    resolve(specifier: string, importer: string | null): Promise<string | null>;
    load(id: string): string | null;
    /** The nearest enclosing `package.json` for a RESOLVED id, off the resolver's own cache.
     *
     *  rolldown gets this for free: oxc-resolver returns `package_json` alongside the path from
     *  every resolve, relative imports included (`ResolveReturn`, `rolldown_resolver/src/resolver.rs:78`).
     *  shakeup splits resolution — this resolver handles bare specifiers, `defaultResolve` handles
     *  relative ones — so the lookup is exposed instead and `makeBaseResolve` applies it to BOTH
     *  branches. It shares `readPkg`'s cache, which resolution has usually already warmed. */
    packageFor(id: string): Promise<PackageJson | null>;
};

const DEFAULT_CONDITIONS = ['import', 'browser', 'default'];
const DEFAULT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.json'];
const DEFAULT_MAIN_FIELDS = ['browser', 'module', 'main'];

/** Sentinel id for a `browser: false` / disabled module. Load hook returns ''. */
export const EMPTY_MODULE_ID = '\0empty';

/** The subset of package.json this resolver reads (parse-cached per dir). */
type PackageJson = {
    dir: string;
    name: string | undefined;
    exports: unknown;
    browser: string | Record<string, string | false> | undefined;
    module: string | undefined;
    main: string | undefined;
    /** `workspaces` globs/paths (array form or `{ packages: [...] }`) — for install-free
     *  monorepo member resolution. */
    workspaces: string[] | undefined;
    /** `sideEffects`: `false` = every module here is drop-if-unreferenced; a glob or glob array =
     *  only the matching files have side effects. Absent = unknown, decide per statement. */
    sideEffects: boolean | string[] | undefined;
};

/** Match one `sideEffects` glob against a package-relative path.
 *
 *  npm/webpack semantics, which are NOT full globbing: `*` matches within a segment, `**` crosses
 *  separators, and a pattern with no `/` matches the BASENAME at any depth (`"*.css"` covers
 *  `dist/a.css`). oxc-resolver implements this in `PackageJson::check_side_effects_for`, which is not
 *  vendored under `llm/libs`, so this follows the spec rather than that source — hence the tests. */
function sideEffectGlobMatches(pattern: string, relPath: string): boolean {
    let pat = pattern.startsWith('./') ? pattern.slice(2) : pattern;
    // A bare pattern (no separator) matches the basename at any depth.
    const target = pat.includes('/') ? relPath : baseName(relPath);
    let re = '';
    for (let i = 0; i < pat.length; i++) {
        const c = pat[i];
        if (c === '*') {
            if (pat[i + 1] === '*') {
                // `**/` may also match ZERO segments, so the separator is part of the optional group.
                if (pat[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`).test(target);
}

/** The `sideEffects` verdict for `id` under `pkg`, or `undefined` when the manifest says nothing.
 *  Mirrors oxc-resolver's per-module check: the path is taken RELATIVE TO THE PACKAGE DIRECTORY
 *  (rolldown `ecma_module_view_factory.rs:237` computes it against the package.json's realpath
 *  parent for exactly this reason). */
export function packageSideEffectsFor(pkg: { dir: string; sideEffects: boolean | string[] | undefined }, id: string): boolean | undefined {
    const se = pkg.sideEffects;
    if (se === undefined) return undefined;
    if (typeof se === 'boolean') return se;
    if (!id.startsWith(`${pkg.dir}/`)) return undefined; // outside the package — say nothing
    const rel = id.slice(pkg.dir.length + 1);
    for (const pattern of se) if (sideEffectGlobMatches(pattern, rel)) return true;
    return false;
}

/** `false` / `true` / one glob / an array of globs. Anything else is not a declaration. */
function parseSideEffects(raw: unknown): boolean | string[] | undefined {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return [raw];
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
    return undefined;
}

function parsePackageName(spec: string): { name: string; subpath: string } | null {
    if (spec === '') return null;
    let name: string;
    const slash = spec.indexOf('/');
    if (!spec.startsWith('@')) {
        name = slash === -1 ? spec : spec.slice(0, slash);
    } else {
        if (slash === -1) return null;
        const slash2 = spec.indexOf('/', slash + 1);
        name = slash2 === -1 ? spec : spec.slice(0, slash2);
    }
    if (name.startsWith('.') || name.includes('\\') || name.includes('%')) return null;
    const subpath = '.' + spec.slice(name.length);
    return { name, subpath };
}

type PjResult =
    | { status: 'exact'; value: string }
    | { status: 'inexact'; value: string }
    | { status: 'null'; blocked: boolean }
    | { status: 'undefined' }
    | { status: 'no-conditions'; conditions: string[] }
    | { status: 'invalid'; reason: string };

const isUndefinedish = (r: PjResult): boolean => r.status === 'undefined' || r.status === 'no-conditions';

function joinUrl(packageUrl: string, rel: string): string {
    return normalizePath(`${packageUrl}/${rel}`);
}

/** Any "." / ".." / "node_modules" segment after the first → invalid. */
function findInvalidSegment(p: string): string {
    const slash = p.search(/[/\\]/);
    if (slash === -1) return '';
    let rest = p.slice(slash + 1);
    while (rest !== '') {
        const s = rest.search(/[/\\]/);
        let seg: string;
        if (s !== -1) {
            seg = rest.slice(0, s);
            rest = rest.slice(s + 1);
        } else {
            seg = rest;
            rest = '';
        }
        if (seg === '.' || seg === '..' || seg === 'node_modules') return seg;
    }
    return '';
}

function targetResolve(
    packageUrl: string,
    target: unknown,
    subpath: string,
    pattern: boolean,
    conditions: Set<string>,
): PjResult {
    if (typeof target === 'string') {
        if (!pattern && subpath !== '' && !target.endsWith('/')) {
            return { status: 'invalid', reason: 'because it doesn\'t end in "/"' };
        }
        if (!target.startsWith('./')) {
            return { status: 'invalid', reason: 'because it doesn\'t start with "./"' };
        }
        const badTarget = findInvalidSegment(target);
        if (badTarget !== '') {
            return { status: 'invalid', reason: `because it contains invalid segment "${badTarget}"` };
        }
        if (/%2f|%5c/i.test(target)) {
            return { status: 'invalid', reason: 'because it must not include encoded "/" or "\\"' };
        }
        const resolvedTarget = joinUrl(packageUrl, target);
        const badSub = findInvalidSegment(subpath);
        if (badSub !== '') {
            return { status: 'invalid', reason: `because it contains invalid segment "${badSub}"` };
        }
        if (/%2f|%5c/i.test(subpath)) {
            return { status: 'invalid', reason: 'because it must not include encoded "/" or "\\"' };
        }
        if (pattern) {
            const value = resolvedTarget.split('*').join(subpath);
            return { status: 'exact', value };
        }
        return { status: 'exact', value: normalizePath(`${resolvedTarget}/${subpath}`) };
    }

    if (target === null) {
        return { status: 'null', blocked: true };
    }

    if (Array.isArray(target)) {
        if (target.length === 0) return { status: 'null', blocked: false };
        let last: PjResult = { status: 'undefined' };
        for (const item of target) {
            const r = targetResolve(packageUrl, item, subpath, pattern, conditions);
            if (r.status === 'invalid' || r.status === 'null') {
                last = r;
                continue;
            }
            if (isUndefinedish(r)) continue;
            return r;
        }
        return last;
    }

    if (typeof target === 'object') {
        const map = target as Record<string, unknown>;
        const keys = Object.keys(map);
        let lastEntry: { key: string; value: unknown } | null = null;
        for (const key of keys) {
            if (key === 'default' || conditions.has(key)) {
                const r = targetResolve(packageUrl, map[key], subpath, pattern, conditions);
                if (isUndefinedish(r)) {
                    lastEntry = { key, value: map[key] };
                    continue;
                }
                return r;
            }
        }
        if (keys.length > 0) {
            let listing = keys;
            if (
                lastEntry !== null &&
                typeof lastEntry.value === 'object' &&
                lastEntry.value !== null &&
                !Array.isArray(lastEntry.value) &&
                !keysStartWithDot(lastEntry.value as Record<string, unknown>)
            ) {
                listing = Object.keys(lastEntry.value as Record<string, unknown>);
            }
            return { status: 'no-conditions', conditions: listing };
        }
        return { status: 'undefined' };
    }

    return { status: 'invalid', reason: '' };
}

function keysStartWithDot(obj: Record<string, unknown>): boolean {
    const keys = Object.keys(obj);
    return keys.length > 0 && keys[0].startsWith('.');
}

function expansionLess(a: string, b: string): number {
    const starA = a.indexOf('*');
    const starB = b.indexOf('*');
    const baseA = starA >= 0 ? starA : a.length;
    const baseB = starB >= 0 ? starB : b.length;
    if (baseA > baseB) return -1;
    if (baseB > baseA) return 1;
    if (starA < 0) return 1;
    if (starB < 0) return -1;
    if (a.length > b.length) return -1;
    if (b.length > a.length) return 1;
    return 0;
}

function subpathResolve(
    matchKey: string,
    matchObj: Record<string, unknown>,
    packageUrl: string,
    conditions: Set<string>,
): PjResult {
    if (!matchKey.endsWith('/') && !matchKey.includes('*')) {
        if (Object.hasOwn(matchObj, matchKey)) {
            return targetResolve(packageUrl, matchObj[matchKey], '', false, conditions);
        }
    }

    const expansionKeys = Object.keys(matchObj).filter((k) => k.endsWith('/') || k.includes('*'));
    expansionKeys.sort(expansionLess);

    for (const key of expansionKeys) {
        const star = key.indexOf('*');
        if (star >= 0) {
            const patternBase = key.slice(0, star);
            if (matchKey.startsWith(patternBase)) {
                const patternTrailer = key.slice(star + 1);
                if (patternTrailer === '' || (matchKey.endsWith(patternTrailer) && matchKey.length >= key.length)) {
                    const captured = matchKey.slice(patternBase.length, matchKey.length - patternTrailer.length);
                    return targetResolve(packageUrl, matchObj[key], captured, true, conditions);
                }
            }
        } else {
            if (matchKey.startsWith(key)) {
                const captured = matchKey.slice(key.length);
                const r = targetResolve(packageUrl, matchObj[key], captured, false, conditions);
                if (r.status === 'exact') return { status: 'inexact', value: r.value };
                return r;
            }
        }
    }

    return { status: 'null', blocked: false };
}

function exportsResolve(exports: unknown, subpath: string, packageUrl: string, conditions: Set<string>): PjResult {
    if (subpath === '.') {
        let mainExport: unknown;
        if (typeof exports === 'string' || Array.isArray(exports) || (isPlainObject(exports) && !keysStartWithDot(exports))) {
            mainExport = exports;
        } else if (isPlainObject(exports) && Object.hasOwn(exports, '.')) {
            mainExport = (exports as Record<string, unknown>)['.'];
        }
        if (mainExport !== undefined) {
            const r = targetResolve(packageUrl, mainExport, '', false, conditions);
            if (r.status !== 'undefined') return r;
        }
    } else if (isPlainObject(exports) && keysStartWithDot(exports)) {
        const r = subpathResolve(subpath, exports, packageUrl, conditions);
        if (r.status !== 'undefined') return r;
    }
    return { status: 'undefined' };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mixedExportsKeys(exports: unknown): { key: string; prev: string } | null {
    if (!isPlainObject(exports)) return null;
    const keys = Object.keys(exports);
    if (keys.length === 0) return null;
    const firstIsDot = keys[0].startsWith('.');
    for (let i = 1; i < keys.length; i++) {
        if (keys[i].startsWith('.') !== firstIsDot) return { key: keys[i], prev: keys[i - 1] };
    }
    return null;
}

/** Extensions Node treats as "js-like", i.e. the ones whose module goal is decided by the nearest
 *  `package.json#type` rather than by the extension itself. `.jsx`/`.tsx` are included for the same
 *  reason rolldown includes them (`rolldown_resolver/src/resolver.rs:252-258`): oxc_resolver follows
 *  the Node ESM spec, which has no native `.jsx`/`.tsx`, but a bundler should treat all js-like
 *  extensions consistently. */
const JS_LIKE = ['.js', '.jsx', '.ts', '.tsx'];

/** Resolve a module's DECLARED format: extension first, then the nearest `package.json#type`.
 *  Port of rolldown's `resolver.rs:238-266` **[V]**.
 *
 *  Per `llm/notes/cjs.md` §7.1b this is a per-build RESOLVE output — the returned lookup owns a
 *  cache that lives exactly as long as one build, which is what keeps a `package.json#type` edit
 *  from going stale without any cross-file invalidation machinery. */
export function createDefFormatLookup(fs: Fs): (id: string) => Promise<ModuleDefFormat> {
    const typeCache = new Map<string, 'module' | 'commonjs' | null>();
    const seenPkg = new Set<string>(); // dirs that HAVE a package.json, whatever it declares

    const readType = async (dir: string): Promise<'module' | 'commonjs' | null> => {
        const cached = typeCache.get(dir);
        if (cached !== undefined) return cached;
        let type: 'module' | 'commonjs' | null = null;
        const text = await fs.read(`${dir}/package.json`);
        if (text !== null) {
            seenPkg.add(dir);
            try {
                const raw = JSON.parse(text) as Record<string, unknown>;
                // ABSENT `type` means UNKNOWN, not CommonJS. Node's own default is CommonJS, but a
                // bundler must stay permissive here: the overwhelming majority of packages ship a
                // package.json with no `type` and ESM syntax in `.js` files, and treating those as
                // declared-CommonJS would reject them. rolldown does the same — both its lookups
                // return `Option` and fall through to `ModuleDefFormat::Unknown`
                // (`rolldown_resolver/src/resolver.rs:249-265`). Only an explicit field decides.
                type = raw.type === 'module' ? 'module' : raw.type === 'commonjs' ? 'commonjs' : null;
            } catch {
                type = null; // malformed: decides nothing
            }
        }
        typeCache.set(dir, type);
        return type;
    };

    return async (id: string): Promise<ModuleDefFormat> => {
        if (id.endsWith('.mjs')) return 'esm-mjs';
        if (id.endsWith('.mts')) return 'esm-mts';
        if (id.endsWith('.cjs')) return 'cjs';
        if (id.endsWith('.cts')) return 'cts';
        if (!JS_LIKE.some((e) => id.endsWith(e))) return 'unknown';
        // Walk up to the first package boundary. Virtual ids (`\0…`) have no directory to walk.
        if (id.startsWith('\0')) return 'unknown';
        // Walk up to the first package boundary, INCLUDING the root: `readType('')` probes
        // `/package.json`, which a naive `while (dir !== '')` loop skips — and a root-level
        // `"type": "module"` covering files in subdirectories is the single most common real layout.
        let dir = id.slice(0, id.lastIndexOf('/'));
        for (;;) {
            const type = await readType(dir);
            if (type !== null) return type === 'module' ? 'esm-package-json' : 'cjs-package-json';
            // A package.json with no usable `type` still ends the search: Node stops at the first
            // package boundary rather than inheriting a parent package's goal.
            if (seenPkg.has(dir)) return 'unknown';
            if (dir === '') return 'unknown';
            dir = dir.slice(0, dir.lastIndexOf('/'));
        }
    };
}

export function createNodeResolver(options: NodeResolverOptions): NodeResolver {
    const fs = options.fs;
    const warnCtx: ResolveCtx = { warn: options.warn };
    const conditions = new Set(options.conditions ?? DEFAULT_CONDITIONS);
    const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
    const mainFields = options.mainFields ?? DEFAULT_MAIN_FIELDS;

    const pkgCache = new Map<string, PackageJson | null>();

    const readPkg = async (dir: string): Promise<PackageJson | null> => {
        const cached = pkgCache.get(dir);
        if (cached !== undefined) return cached;
        const text = await fs.read(`${dir}/package.json`);
        if (text === null) {
            pkgCache.set(dir, null);
            return null;
        }
        let raw: Record<string, unknown>;
        try {
            raw = JSON.parse(text) as Record<string, unknown>;
        } catch {
            pkgCache.set(dir, null);
            return null;
        }
        const browserRaw = raw.browser;
        let browser: string | Record<string, string | false> | undefined;
        if (typeof browserRaw === 'string') {
            browser = browserRaw;
        } else if (isPlainObject(browserRaw)) {
            const map: Record<string, string | false> = {};
            for (const [k, v] of Object.entries(browserRaw)) {
                if (typeof v === 'string') map[k] = v;
                else if (v === false) map[k] = false;
            }
            browser = map;
        }
        const wsRaw = raw.workspaces;
        let workspaces: string[] | undefined;
        if (Array.isArray(wsRaw)) {
            workspaces = wsRaw.filter((x): x is string => typeof x === 'string');
        } else if (isPlainObject(wsRaw) && Array.isArray((wsRaw as { packages?: unknown }).packages)) {
            workspaces = (wsRaw as { packages: unknown[] }).packages.filter((x): x is string => typeof x === 'string');
        }
        const pkg: PackageJson = {
            dir,
            name: typeof raw.name === 'string' ? raw.name : undefined,
            exports: raw.exports === null ? undefined : raw.exports,
            browser,
            module: typeof raw.module === 'string' ? raw.module : undefined,
            main: typeof raw.main === 'string' ? raw.main : undefined,
            workspaces,
            sideEffects: parseSideEffects(raw.sideEffects),
        };
        pkgCache.set(dir, pkg);
        return pkg;
    };

    const loadAsFile = async (path: string): Promise<string | null> => {
        if (await fs.exists(path)) return path;
        for (const ext of extensions) {
            if (await fs.exists(path + ext)) return path + ext;
        }
        return null;
    };

    const loadAsIndex = async (dir: string): Promise<string | null> => {
        for (const ext of extensions) {
            const cand = `${dir}/index${ext}`;
            if (await fs.exists(cand)) return cand;
        }
        return null;
    };

    const applyBrowserRemap = (pkg: PackageJson, absPath: string): string => {
        const map = pkg.browser;
        if (map === undefined || typeof map === 'string') return absPath;
        const rel = relativeTo(pkg.dir, absPath);
        for (const candidate of browserKeyCandidates(rel, extensions)) {
            if (Object.hasOwn(map, candidate)) {
                const mapped = map[candidate];
                if (mapped === false) return EMPTY_MODULE_ID;
                return normalizePath(`${pkg.dir}/${mapped}`);
            }
        }
        return absPath;
    };

    const loadAsFileOrDirectory = async (pkg: PackageJson, absPath: string): Promise<string | null> => {
        const remapped = applyBrowserRemap(pkg, absPath);
        if (remapped === EMPTY_MODULE_ID) return EMPTY_MODULE_ID;
        const asFile = await loadAsFile(remapped);
        if (asFile !== null) {
            return finishBrowserRemap(pkg, asFile);
        }
        const asIndex = await loadAsIndex(remapped);
        if (asIndex !== null) return finishBrowserRemap(pkg, asIndex);
        return null;
    };

    const finishBrowserRemap = async (pkg: PackageJson, absPath: string): Promise<string> => {
        const r = applyBrowserRemap(pkg, absPath);
        if (r === EMPTY_MODULE_ID) return EMPTY_MODULE_ID;
        if (r === absPath) return absPath;
        const f = await loadAsFile(r);
        return f ?? r;
    };

    const loadPackageRoot = async (pkg: PackageJson): Promise<string | null> => {
        const fields: Record<string, string | undefined> = {
            browser: typeof pkg.browser === 'string' ? pkg.browser : undefined,
            module: pkg.module,
            main: pkg.main,
        };
        for (const key of mainFields) {
            const value = fields[key];
            if (value === undefined) continue;
            const abs = normalizePath(`${pkg.dir}/${value}`);
            const hit = await loadAsFileOrDirectory(pkg, abs);
            if (hit !== null) return hit;
        }
        const idx = await loadAsIndex(pkg.dir);
        if (idx !== null) return finishBrowserRemap(pkg, idx);
        return null;
    };

    const finishExports = async (
        ctx: ResolveCtx,
        pkg: PackageJson,
        spec: string,
        subpath: string,
        r: PjResult,
    ): Promise<string | null> => {
        switch (r.status) {
            case 'exact': {
                if (await fs.exists(r.value)) return r.value;
                warn(ctx, spec, `The module "${relativeForMsg(pkg, r.value)}" was not found on the file system`);
                return null;
            }
            case 'inexact': {
                const hit = (await loadAsFile(r.value)) ?? (await loadAsIndex(r.value));
                if (hit !== null) return hit;
                warn(ctx, spec, `The module "${relativeForMsg(pkg, r.value)}" was not found on the file system`);
                return null;
            }
            case 'null':
                warn(
                    ctx,
                    spec,
                    r.blocked
                        ? `The path "${subpath}" is not exported by package "${pkg.name ?? '?'}" — explicitly disabled by the package author`
                        : `The path "${subpath}" is not exported by package "${pkg.name ?? '?'}"`,
                );
                return null;
            case 'no-conditions':
                warn(
                    ctx,
                    spec,
                    `None of the conditions in the package definition (${listConds(r.conditions)}) match any of the currently active conditions (${listConds([...conditions])})`,
                );
                return null;
            case 'invalid':
                warn(ctx, spec, `The path "${subpath}" is not exported by package "${pkg.name ?? '?'}" ${r.reason}`.trim());
                return null;
            case 'undefined':
                warn(ctx, spec, `The path "${subpath}" is not exported by package "${pkg.name ?? '?'}"`);
                return null;
        }
    };

    /** Resolve `specifier`/`subpath` against a located package (node_modules OR workspace
     *  member): its `exports` if present, else the mainFields / subpath file. */
    const resolveInPackage = async (
        ctx: ResolveCtx,
        pkg: PackageJson,
        specifier: string,
        subpath: string,
    ): Promise<string | null> => {
        if (pkg.exports !== undefined) {
            const mixed = mixedExportsKeys(pkg.exports);
            if (mixed !== null) {
                warn(
                    ctx,
                    specifier,
                    `This object cannot contain keys that both start with "." and don't (${mixed.key} vs ${mixed.prev})`,
                );
                return null;
            }
            const r = exportsResolve(pkg.exports, subpath, pkg.dir, conditions);
            return finishExports(ctx, pkg, specifier, subpath, r);
        }
        if (subpath === '.') {
            const hit = await loadPackageRoot(pkg);
            if (hit !== null) return hit;
        } else {
            const abs = normalizePath(`${pkg.dir}/${subpath.slice(2)}`);
            const hit = await loadAsFileOrDirectory(pkg, abs);
            if (hit !== null) return hit;
        }
        warn(ctx, specifier, `The module "${specifier}" was not found on the file system`);
        return null;
    };

    /** Install-free workspace member: locate `name`'s package dir via the nearest ancestor
     *  `workspaces` field. The Fs contract has no directory listing, so a `glob/*` member is
     *  located by convention — its dir basename matches the specifier's last segment (explicit
     *  paths are matched exactly). Returns the member dir, or null. */
    const findWorkspaceMember = async (fromDir: string, name: string): Promise<string | null> => {
        const last = name.slice(name.lastIndexOf('/') + 1);
        for (let dir: string | null = fromDir; dir !== null; dir = parentDir(dir)) {
            const rootPkg = await readPkg(dir);
            if (rootPkg === null || rootPkg.workspaces === undefined) continue;
            for (const pat of rootPkg.workspaces) {
                const candidate = pat.endsWith('/*') ? joinPath(dir, `${pat.slice(0, -2)}/${last}`) : joinPath(dir, pat);
                const memberPkg = await readPkg(candidate);
                if (memberPkg !== null && memberPkg.name === name) return candidate;
            }
            return null; // workspace root found but no matching member
        }
        return null;
    };

    const resolveId = async (
        ctx: ResolveCtx,
        specifier: string,
        importer: string | null,
        skipBrowserMap = false,
    ): Promise<string | null | undefined> => {
        if (specifier.startsWith('\0')) return null;

        if (specifier.startsWith('.') || specifier.startsWith('/')) {
            if (importer === null) return null;
            const owner = await findBrowserMapOwner(readPkg, dirnameOf(importer));
            if (owner === null) return null;
            const abs = joinPath(dirnameOf(importer), specifier);
            const hit = await loadAsFileOrDirectory(owner, abs);
            if (hit === EMPTY_MODULE_ID) return EMPTY_MODULE_ID;
            const remapped = applyBrowserRemap(owner, abs);
            if (remapped !== abs) return hit;
            return null;
        }

        const parsed = parsePackageName(specifier);
        if (parsed === null) return null;
        const { name, subpath } = parsed;

        const importerDir = importer === null ? '' : dirnameOf(importer);

        if (!skipBrowserMap) {
            const owner = await findBrowserMapOwner(readPkg, importerDir);
            if (owner !== null) {
                const map = owner.browser as Record<string, string | false>;
                if (Object.hasOwn(map, specifier)) {
                    const mapped = map[specifier];
                    if (mapped === false) return EMPTY_MODULE_ID;
                    if (mapped.startsWith('.')) {
                        const hit = await loadAsFileOrDirectory(owner, normalizePath(`${owner.dir}/${mapped}`));
                        if (hit !== null) return hit;
                    } else {
                        return resolveId(ctx, mapped, importer, true);
                    }
                }
            }
        }

        const selfPkg = await findEnclosingPackage(readPkg, importerDir, name);
        if (selfPkg !== null && selfPkg.exports !== undefined) {
            const mixed = mixedExportsKeys(selfPkg.exports);
            if (mixed !== null) {
                warn(
                    ctx,
                    specifier,
                    `This object cannot contain keys that both start with "." and don't (${mixed.key} vs ${mixed.prev})`,
                );
                return null;
            }
            const r = exportsResolve(selfPkg.exports, subpath, selfPkg.dir, conditions);
            return finishExports(ctx, selfPkg, specifier, subpath, r);
        }

        for (let dir: string | null = importerDir; dir !== null; dir = parentDir(dir)) {
            if (baseName(dir) === 'node_modules') continue;
            const pkgDir = joinPath(dir, `node_modules/${name}`);
            const pkg = await readPkg(pkgDir);
            if (pkg === null) continue;

            return resolveInPackage(ctx, pkg, specifier, subpath);
        }

        // Install-free workspace member fallback (no node_modules/<name> found).
        const memberDir = await findWorkspaceMember(importerDir, name);
        if (memberDir !== null) {
            const pkg = await readPkg(memberDir);
            if (pkg !== null) return resolveInPackage(ctx, pkg, specifier, subpath);
        }
        return null;
    };

    return {
        resolve: async (specifier, importer) => (await resolveId(warnCtx, specifier, importer)) ?? null,
        load: (id) => (id === EMPTY_MODULE_ID ? '' : null),
        packageFor: (id) => findOwningPackage(readPkg, dirnameOf(id)),
    };
}

function warn(ctx: ResolveCtx, spec: string, note: string): void {
    ctx.warn(`Could not resolve "${spec}": ${note}`);
}

const listConds = (c: string[]): string => c.map((k) => `"${k}"`).join(', ');

/** Base name of a posix dir path. */
function baseName(dir: string): string {
    const i = dir.lastIndexOf('/');
    return i === -1 ? dir : dir.slice(i + 1);
}

/** Parent dir, or null once at root. */
function parentDir(dir: string): string | null {
    if (dir === '/' || dir === '') return null;
    const parent = dirnameOf(dir);
    if (parent === dir) return null;
    return parent;
}

/** Package-relative path ("./...") of an absolute path under pkgDir. */
function relativeTo(pkgDir: string, absPath: string): string {
    if (absPath.startsWith(pkgDir + '/')) return './' + absPath.slice(pkgDir.length + 1);
    if (absPath === pkgDir) return '.';
    return absPath;
}

function browserKeyCandidates(rel: string, extensions: string[]): string[] {
    const out: string[] = [];
    const add = (r: string): void => {
        out.push(r);
        if (r.startsWith('./')) out.push(r.slice(2));
    };
    add(rel);
    for (const ext of extensions) {
        if (rel.endsWith(ext)) {
            const base = rel.slice(0, -ext.length);
            add(base);
            if (base.endsWith('/index')) add(base.slice(0, -'/index'.length));
            break;
        }
    }
    return out;
}

function relativeForMsg(pkg: PackageJson, absPath: string): string {
    return relativeTo(pkg.dir, absPath);
}

async function findEnclosingPackage(
    readPkg: (dir: string) => Promise<PackageJson | null>,
    startDir: string,
    name: string,
): Promise<PackageJson | null> {
    for (let dir: string | null = startDir; dir !== null; dir = parentDir(dir)) {
        if (baseName(dir) === 'node_modules') return null;
        const pkg = await readPkg(dir);
        if (pkg !== null) {
            return pkg.name === name ? pkg : null;
        }
    }
    return null;
}

/** Nearest enclosing `package.json`, walking up from a file's directory. Unlike
 *  `findEnclosingPackage` this does not stop at a `node_modules` boundary or filter by name: the
 *  owner of `…/node_modules/pkg/dist/a.js` IS `…/node_modules/pkg`. */
async function findOwningPackage(
    readPkg: (dir: string) => Promise<PackageJson | null>,
    startDir: string,
): Promise<PackageJson | null> {
    for (let dir: string | null = startDir; dir !== null; dir = parentDir(dir)) {
        const pkg = await readPkg(dir);
        if (pkg !== null) return pkg;
    }
    return null;
}

async function findBrowserMapOwner(
    readPkg: (dir: string) => Promise<PackageJson | null>,
    startDir: string,
): Promise<PackageJson | null> {
    for (let dir: string | null = startDir; dir !== null; dir = parentDir(dir)) {
        const pkg = await readPkg(dir);
        if (pkg !== null && pkg.browser !== undefined && typeof pkg.browser !== 'string') return pkg;
    }
    return null;
}
