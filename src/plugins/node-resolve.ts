// npm resolution plugin — bare-specifier resolution over the sync Fs seam.
//
// Distilled from esbuild internal/resolver/{resolver.go,package_json.go}; see
// llm/notes/npm-resolution.md for the design and file:line citations. Browser-
// first, ESM-only. Every directory-listing `entries.Get(base)` in esbuild
// becomes an `Fs.exists(join(dir, base))` here (drops case-mismatch warnings).
//
// Scope: bare specifiers only. Relative/absolute specifiers return null so core
// handles them. Failure modes return null AFTER ctx.warn(...) with esbuild's
// diagnostic patterns; see the header of resolveId for the warn-vs-error caveat.

import { type Fs, dirnameOf, joinPath, normalizePath } from '../fs';
import type { Plugin, PluginCtx } from '../plugin';

/* ------------------------------------------------------------------ options */

export type NodeResolveOptions = {
    /** filesystem seam (same instance the bundle uses; PluginCtx has no Fs) */
    fs: Fs;
    /** active exports/imports conditions; membership-only. Default browser set. */
    conditions?: string[];
    /** legacy file-probe extensions. */
    extensions?: string[];
    /** legacy main field order. */
    mainFields?: string[];
};

const DEFAULT_CONDITIONS = ['import', 'browser', 'default']; // esbuild resolver.go:283-296 / rolldown resolver_config.rs:34-44
const DEFAULT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.json']; // rolldown resolver_config.rs:119
const DEFAULT_MAIN_FIELDS = ['browser', 'module', 'main'];

/** Sentinel id for a `browser: false` / disabled module. Load hook returns ''. */
export const EMPTY_MODULE_ID = '\0empty';

/* -------------------------------------------------------------- pkg parsing */

/** The subset of package.json this resolver reads (parse-cached per dir). */
type PkgJson = {
    dir: string;
    name: string | undefined;
    /** raw exports value (string | array | object), or undefined */
    exports: unknown;
    /**
     * The `browser` field: string form (whole-package remap) OR object map
     * (relPath -> string remap | false disable). Kept as one field per the
     * cache contract {name, exports, browser, module, main}.
     */
    browser: string | Record<string, string | false> | undefined;
    module: string | undefined;
    main: string | undefined;
};

/* ------------------------------------------------------------- name parsing */

/**
 * Split a bare specifier into (name, subpath). subpath is "." + rest.
 * Mirrors esmParsePackageName (package_json.go:1320-1349). Returns null when
 * the specifier is not a valid package specifier.
 */
function parsePackageName(spec: string): { name: string; subpath: string } | null {
    if (spec === '') return null;
    let name: string;
    const slash = spec.indexOf('/');
    if (!spec.startsWith('@')) {
        name = slash === -1 ? spec : spec.slice(0, slash);
    } else {
        if (slash === -1) return null; // "@scope" alone is not a package
        const slash2 = spec.indexOf('/', slash + 1);
        name = slash2 === -1 ? spec : spec.slice(0, slash2);
    }
    if (name.startsWith('.') || name.includes('\\') || name.includes('%')) return null;
    const subpath = '.' + spec.slice(name.length);
    return { name, subpath };
}

/* -------------------------------------------------------- exports resolution */

// pjStatus — resolution outcomes from esmPackageTargetResolve.
type PjResult =
    | { status: 'exact'; value: string } // exact target (existence check only)
    | { status: 'inexact'; value: string } // legacy `/`-suffixed key: probe
    | { status: 'null'; blocked: boolean } // null result; blocked = author null literal
    | { status: 'undefined' } // no applicable branch (keep searching)
    | { status: 'no-conditions'; conditions: string[] } // condition map, none matched
    | { status: 'invalid'; reason: string }; // invalid package target

const isUndefinedish = (r: PjResult): boolean => r.status === 'undefined' || r.status === 'no-conditions';

/** path.Join semantics for a posix package-relative target under packageURL. */
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

/**
 * esmPackageTargetResolve (package_json.go:1096-1318). Resolves a single target
 * (string | object condition map | array fallback | null) with the captured
 * `subpath` (the `*` expansion for pattern keys).
 */
function targetResolve(
    packageUrl: string,
    target: unknown,
    subpath: string,
    pattern: boolean,
    conditions: Set<string>,
): PjResult {
    // string target
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

    // null target = author-blocked (null literal -> "explicitly disabled")
    if (target === null) {
        return { status: 'null', blocked: true };
    }

    // array fallback
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

    // condition object — author key order, first applicable wins
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
        // no condition applied — friendly "no conditions match" (only for
        // condition maps, not subpath maps). Complain about the nested map if a
        // top-level key matched but its sub-conditions didn't (go:1233-1272).
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

/**
 * Specificity comparator for expansion keys (package_json.go:578-629):
 * longer base wins; no-`*` beats `*`; longer key wins on tie. Returns <0 if a
 * should come before b.
 */
function expansionLess(a: string, b: string): number {
    const starA = a.indexOf('*');
    const starB = b.indexOf('*');
    const baseA = starA >= 0 ? starA : a.length;
    const baseB = starB >= 0 ? starB : b.length;
    if (baseA > baseB) return -1;
    if (baseB > baseA) return 1;
    if (starA < 0) return 1; // a has no star -> b wins ordering (a is "less" only if...); mirror go
    if (starB < 0) return -1;
    if (a.length > b.length) return -1;
    if (b.length > a.length) return 1;
    return 0;
}

/**
 * esmPackageImportsExportsResolve (package_json.go:997-1070). Matches matchKey
 * against a subpath object: exact key first, then expansion keys by specificity.
 */
function subpathResolve(
    matchKey: string,
    matchObj: Record<string, unknown>,
    packageUrl: string,
    conditions: Set<string>,
): PjResult {
    // exact match (key not ending "/" and not containing "*")
    if (!matchKey.endsWith('/') && !matchKey.includes('*')) {
        if (Object.prototype.hasOwnProperty.call(matchObj, matchKey)) {
            return targetResolve(packageUrl, matchObj[matchKey], '', false, conditions);
        }
    }

    // expansion keys: those ending in "/" or containing "*"
    const expansionKeys = Object.keys(matchObj).filter((k) => k.endsWith('/') || k.includes('*'));
    expansionKeys.sort(expansionLess);

    for (const key of expansionKeys) {
        const star = key.indexOf('*');
        if (star >= 0) {
            const patternBase = key.slice(0, star);
            if (matchKey.startsWith(patternBase)) {
                const patternTrailer = key.slice(star + 1);
                if (
                    patternTrailer === '' ||
                    (matchKey.endsWith(patternTrailer) && matchKey.length >= key.length)
                ) {
                    const captured = matchKey.slice(patternBase.length, matchKey.length - patternTrailer.length);
                    return targetResolve(packageUrl, matchObj[key], captured, true, conditions);
                }
            }
        } else {
            // key ends in "/": prefix match, inexact (probes)
            if (matchKey.startsWith(key)) {
                const captured = matchKey.slice(key.length);
                const r = targetResolve(packageUrl, matchObj[key], captured, false, conditions);
                if (r.status === 'exact') return { status: 'inexact', value: r.value };
                return r;
            }
        }
    }

    return { status: 'null', blocked: false }; // no keys matched -> "not exported"
}

/**
 * esmPackageExportsResolve (package_json.go:960-995). Entry into the exports
 * engine for a subpath ("." or "./..."). Distinguishes sugar form (conditions
 * for ".") from subpath form.
 */
function exportsResolve(
    exports: unknown,
    subpath: string,
    packageUrl: string,
    conditions: Set<string>,
): PjResult {
    if (subpath === '.') {
        let mainExport: unknown = undefined;
        if (
            typeof exports === 'string' ||
            Array.isArray(exports) ||
            (isPlainObject(exports) && !keysStartWithDot(exports))
        ) {
            mainExport = exports;
        } else if (isPlainObject(exports) && Object.prototype.hasOwnProperty.call(exports, '.')) {
            mainExport = (exports as Record<string, unknown>)['.'];
        }
        if (mainExport !== undefined) {
            // esbuild returns any non-undefined status directly (go:974-980); a
            // null literal surfaces as the "explicitly disabled" diagnosis.
            const r = targetResolve(packageUrl, mainExport, '', false, conditions);
            if (r.status !== 'undefined') return r;
        }
    } else if (isPlainObject(exports) && keysStartWithDot(exports)) {
        const r = subpathResolve(subpath, exports, packageUrl, conditions);
        if (r.status !== 'undefined') return r;
    }
    return { status: 'undefined' }; // "not exported"
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Detect mixed `.`/non-`.` keys in an exports object (invalid configuration,
 * package_json.go:695-708). Returns the conflicting key pair, or null.
 */
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

/* ------------------------------------------------------------------ plugin */

export function nodeResolve(options: NodeResolveOptions): Plugin {
    const fs = options.fs;
    const conditions = new Set(options.conditions ?? DEFAULT_CONDITIONS);
    const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
    const mainFields = options.mainFields ?? DEFAULT_MAIN_FIELDS;

    // package.json parse cache keyed by package dir. `null` = no/invalid pkg here.
    const pkgCache = new Map<string, PkgJson | null>();

    const readPkg = (dir: string): PkgJson | null => {
        const cached = pkgCache.get(dir);
        if (cached !== undefined) return cached;
        const text = fs.read(`${dir}/package.json`);
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
        const pkg: PkgJson = {
            dir,
            name: typeof raw.name === 'string' ? raw.name : undefined,
            // esbuild parses `exports: null` as NO exports map -> legacy fallback
            // (package_json.go:808-810); normalize so the terminal rule doesn't fire
            exports: raw.exports === null ? undefined : raw.exports,
            browser,
            module: typeof raw.module === 'string' ? raw.module : undefined,
            main: typeof raw.main === 'string' ? raw.main : undefined,
        };
        pkgCache.set(dir, pkg);
        return pkg;
    };

    /* ------------------------------------------- legacy file/dir probing */

    // Try `path` exactly, then with each extension.
    const loadAsFile = (path: string): string | null => {
        if (fs.exists(path)) return path;
        for (const ext of extensions) {
            if (fs.exists(path + ext)) return path + ext;
        }
        return null;
    };

    // Try `dir` as a directory: mainFields (only for the package root dir where
    // pkg lives), then index probing. `pkg` is the enclosing package.json.
    const loadAsIndex = (dir: string): string | null => {
        for (const ext of extensions) {
            const cand = `${dir}/index${ext}`;
            if (fs.exists(cand)) return cand;
        }
        return null;
    };

    // Apply a package's browser-object remap to an absolute path. Returns the
    // remapped absolute path, EMPTY_MODULE_ID for `false`, or the same path.
    const applyBrowserRemap = (pkg: PkgJson, absPath: string): string => {
        const map = pkg.browser;
        if (map === undefined || typeof map === 'string') return absPath; // only object form remaps files
        // browser keys are package-relative like "./node-impl.js"; build the
        // relative form of absPath against the package dir.
        const rel = relativeTo(pkg.dir, absPath);
        for (const candidate of browserKeyCandidates(rel, extensions)) {
            if (Object.prototype.hasOwnProperty.call(map, candidate)) {
                const mapped = map[candidate];
                if (mapped === false) return EMPTY_MODULE_ID;
                return normalizePath(`${pkg.dir}/${mapped}`);
            }
        }
        return absPath;
    };

    // loadAsFileOrDirectory over a package subpath (legacy, no exports).
    const loadAsFileOrDirectory = (pkg: PkgJson, absPath: string): string | null => {
        const remapped = applyBrowserRemap(pkg, absPath);
        if (remapped === EMPTY_MODULE_ID) return EMPTY_MODULE_ID;
        const asFile = loadAsFile(remapped);
        if (asFile !== null) {
            // a probed file may itself be browser-remapped (e.g. index.js -> false)
            return finishBrowserRemap(pkg, asFile);
        }
        // directory: index probing (mainFields handled only at package root)
        const asIndex = loadAsIndex(remapped);
        if (asIndex !== null) return finishBrowserRemap(pkg, asIndex);
        return null;
    };

    const finishBrowserRemap = (pkg: PkgJson, absPath: string): string => {
        const r = applyBrowserRemap(pkg, absPath);
        if (r === EMPTY_MODULE_ID) return EMPTY_MODULE_ID;
        if (r === absPath) return absPath;
        // remap pointed elsewhere; probe the new target as a file
        const f = loadAsFile(r);
        return f ?? r;
    };

    // Resolve a package root via mainFields, then index. `pkgDir` is the package
    // directory (where package.json lives). subpath is "." here.
    const loadPackageRoot = (pkg: PkgJson): string | null => {
        const fields: Record<string, string | undefined> = {
            browser: typeof pkg.browser === 'string' ? pkg.browser : undefined,
            module: pkg.module,
            main: pkg.main,
        };
        for (const key of mainFields) {
            const value = fields[key];
            if (value === undefined) continue;
            const abs = normalizePath(`${pkg.dir}/${value}`);
            const hit = loadAsFileOrDirectory(pkg, abs);
            if (hit !== null) return hit;
        }
        // no main field resolved: index probing at package root (with browser remap)
        const idx = loadAsIndex(pkg.dir);
        if (idx !== null) return finishBrowserRemap(pkg, idx);
        return null;
    };

    /* --------------------------------------------------- exports outcome */

    // Turn a PjResult into a resolved id (checking existence) or a warning key.
    // Returns { id } on success, { warn } to surface a diagnostic, or null to
    // fall through (only for the not-exported → still search? no: exports are
    // terminal, so undefined here means "not exported" = warn).
    const finishExports = (
        ctx: PluginCtx,
        pkg: PkgJson,
        spec: string,
        subpath: string,
        r: PjResult,
    ): string | null => {
        switch (r.status) {
            case 'exact': {
                if (fs.exists(r.value)) return r.value;
                warn(ctx, spec, `The module "${relativeForMsg(pkg, r.value)}" was not found on the file system`);
                return null;
            }
            case 'inexact': {
                const hit = loadAsFile(r.value) ?? loadAsIndex(r.value);
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

    /* -------------------------------------------------------- resolveId */

    // NOTE (warn-vs-error friction): core (src/graph.ts) treats a bare specifier
    // that resolveId leaves null as EXTERNAL, not a build error — only relative/
    // absolute misses error. So a diagnosed npm miss can't be turned into a hard
    // build error from here; we attach the rich diagnosis via ctx.warn and return
    // null. See final report.
    const resolveId = (
        ctx: PluginCtx,
        specifier: string,
        importer: string | null,
        skipBrowserMap = false,
    ): string | null | undefined => {
        // virtual ids — leave to core.
        if (specifier.startsWith('\0')) return null;

        // relative / absolute specifiers: core normally handles them, but a
        // package's own `browser` object map remaps its relative files (incl.
        // `false` -> empty module). Only intercept when the importer sits inside
        // a browser-map package; otherwise pass to core.
        if (specifier.startsWith('.') || specifier.startsWith('/')) {
            if (importer === null) return null;
            const owner = findBrowserMapOwner(readPkg, dirnameOf(importer));
            if (owner === null) return null;
            const abs = joinPath(dirnameOf(importer), specifier);
            const hit = loadAsFileOrDirectory(owner, abs);
            // only claim the resolution when the browser map actually applied;
            // else let core resolve (avoids swallowing genuine misses/probing diffs)
            if (hit === EMPTY_MODULE_ID) return EMPTY_MODULE_ID;
            const remapped = applyBrowserRemap(owner, abs);
            if (remapped !== abs) return hit; // a remap fired -> our result wins
            return null; // no remap for this file -> core handles
        }

        const parsed = parsePackageName(specifier);
        if (parsed === null) return null;
        const { name, subpath } = parsed;

        const importerDir = importer === null ? '' : dirnameOf(importer);

        // 0. package-name browser remap: the importer's enclosing browser map may
        //    remap or disable a BARE specifier (esbuild checkPackage +
        //    checkBrowserMap packagePathKind, resolver.go:1051-1071). This is how
        //    postcss stubs "source-map-js"/"path"/"fs" for browsers.
        if (!skipBrowserMap) {
            const owner = findBrowserMapOwner(readPkg, importerDir);
            if (owner !== null) {
                const map = owner.browser as Record<string, string | false>;
                if (Object.prototype.hasOwnProperty.call(map, specifier)) {
                    const mapped = map[specifier];
                    if (mapped === false) return EMPTY_MODULE_ID;
                    if (mapped.startsWith('.')) {
                        const hit = loadAsFileOrDirectory(owner, normalizePath(`${owner.dir}/${mapped}`));
                        if (hit !== null) return hit;
                    } else {
                        // remap to another package: re-resolve, skipping the map
                        // so a self-mapping can't loop
                        return resolveId(ctx, mapped, importer, true);
                    }
                }
            }
        }

        // 1. self-reference: nearest enclosing package.json whose name === name
        //    AND has exports.
        const selfPkg = findEnclosingPackage(readPkg, importerDir, name);
        if (selfPkg !== null && selfPkg.exports !== undefined) {
            const mixed = mixedExportsKeys(selfPkg.exports);
            if (mixed !== null) {
                warn(ctx, specifier, `This object cannot contain keys that both start with "." and don't (${mixed.key} vs ${mixed.prev})`);
                return null;
            }
            const r = exportsResolve(selfPkg.exports, subpath, selfPkg.dir, conditions);
            return finishExports(ctx, selfPkg, specifier, subpath, r);
        }

        // 2. walk node_modules upward.
        for (let dir: string | null = importerDir; dir !== null; dir = parentDir(dir)) {
            if (baseName(dir) === 'node_modules') continue; // don't nest node_modules/node_modules
            const pkgDir = joinPath(dir, `node_modules/${name}`);
            const pkg = readPkg(pkgDir);
            if (pkg === null) continue;

            // exports present → terminal.
            if (pkg.exports !== undefined) {
                const mixed = mixedExportsKeys(pkg.exports);
                if (mixed !== null) {
                    warn(ctx, specifier, `This object cannot contain keys that both start with "." and don't (${mixed.key} vs ${mixed.prev})`);
                    return null;
                }
                const r = exportsResolve(pkg.exports, subpath, pkgDir, conditions);
                return finishExports(ctx, pkg, specifier, subpath, r);
            }

            // legacy path.
            if (subpath === '.') {
                const hit = loadPackageRoot(pkg);
                if (hit !== null) return hit;
            } else {
                const abs = normalizePath(`${pkgDir}/${subpath.slice(2)}`);
                const hit = loadAsFileOrDirectory(pkg, abs);
                if (hit !== null) return hit;
            }
            // package found but subpath unresolved → not found on fs.
            warn(ctx, specifier, `The module "${specifier}" was not found on the file system`);
            return null;
        }

        // not found in any node_modules — no diagnosis to add; core marks external.
        return null;
    };

    return {
        name: 'node-resolve',
        resolveId: (ctx, specifier, importer) => resolveId(ctx, specifier, importer),
        load: (_ctx, id) => (id === EMPTY_MODULE_ID ? '' : null),
    };
}

/* ---------------------------------------------------------------- helpers */

function warn(ctx: PluginCtx, spec: string, note: string): void {
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

/**
 * Browser-map key candidates for a relative path: as written, without the
 * leading "./", with a known extension stripped, and with a trailing "/index"
 * stripped — mirroring esbuild's implicit-extension/index matching direction
 * (checkPath, package_json.go:134-178).
 */
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

function relativeForMsg(pkg: PkgJson, absPath: string): string {
    return relativeTo(pkg.dir, absPath);
}

/**
 * Find the nearest enclosing package.json (walking up from `dir`) whose name
 * matches `name`. Stops at the first package.json encountered (self-reference
 * only considers the immediately enclosing package).
 */
function findEnclosingPackage(
    readPkg: (dir: string) => PkgJson | null,
    startDir: string,
    name: string,
): PkgJson | null {
    for (let dir: string | null = startDir; dir !== null; dir = parentDir(dir)) {
        if (baseName(dir) === 'node_modules') return null;
        const pkg = readPkg(dir);
        if (pkg !== null) {
            return pkg.name === name ? pkg : null; // nearest pkg only
        }
    }
    return null;
}

/**
 * Nearest enclosing package.json (walking up from `startDir`) that carries an
 * object-form `browser` map — the scope within which relative imports get
 * browser-remapped. Returns null if none.
 */
function findBrowserMapOwner(
    readPkg: (dir: string) => PkgJson | null,
    startDir: string,
): PkgJson | null {
    // esbuild's enclosingBrowserScope (resolver.go:1592-1625): the scope is the
    // nearest ancestor WITH an object browser map; intermediate package.jsons
    // without one do not reset it.
    for (let dir: string | null = startDir; dir !== null; dir = parentDir(dir)) {
        const pkg = readPkg(dir);
        if (pkg !== null && pkg.browser !== undefined && typeof pkg.browser !== 'string') return pkg;
    }
    return null;
}
