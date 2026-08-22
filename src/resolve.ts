import { dirnameOf, type Fs, joinPath, type MaybePromise } from './fs';
import type { ParseCache } from './graph-types';
import { createNodeResolver } from './node-resolve';
import type { Plugin } from './plugin';

/** Automatic-runtime JSX options. No `runtime`/`factory`/`fragment`/`development` —
 * automatic runtime only. */
export type JSXOptions = {
    importSource?: string;
    pure?: boolean;
};

/** Resolve JSX options against defaults (importSource 'react', pure true). */
export function resolveJSXOptions(jsx: JSXOptions | undefined): { importSource: string; pure: boolean } {
    return { importSource: jsx?.importSource ?? 'react', pure: jsx?.pure ?? true };
}

/** Entry surface. `string` = single unnamed entry; `string[]` = several unnamed entries;
 *  `Record<name, specifier>` = named entries. */
export type InputOption = string | string[] | Record<string, string>;

/** A low-level resolver override: specifier+importer → resolved id / null. May be sync or async. */
export type ResolveFn = (specifier: string, importer: string | null) => MaybePromise<string | null>;

/** Deployment target picking `mainFields`/`conditionNames` defaults. */
export type Platform = 'node' | 'browser' | 'neutral';

/** `resolve:{}` config — surfaces the core relative-probe resolver's knobs. */
export type ResolveOptions = {
    /** Probe extensions, replacing the hard-coded set. Default ['.tsx','.ts','.jsx','.js','.json']. */
    extensions?: string[];
    /** `import './x.js'` → try these instead, in order (e.g. {'.js':['.ts','.js']}). */
    extensionAlias?: Record<string, string[]>;
    /** Directory index basenames. Default ['index']. */
    mainFiles?: string[];
    /** Pre-resolve string→string alias: `key` / `key/…` rewrites to the target then resolves. */
    alias?: Record<string, string>;
    /** false disables the `fs.realpath` deref (symlink preservation). Default true. */
    symlinks?: boolean;
    mainFields?: string[];
    conditionNames?: string[];
    /** package "exports" field lookup path. */
    exportsFields?: string[][];
    /** package "browser" alias field. */
    aliasFields?: string[][];
};

/** Fully-resolved {@link ResolveOptions} with platform defaults applied. */
export type NormalizedResolve = {
    extensions: string[];
    extensionAlias: Record<string, string[]>;
    mainFiles: string[];
    alias: Record<string, string>;
    symlinks: boolean;
    mainFields: string[];
    conditionNames: string[];
    exportsFields: string[][];
    aliasFields: string[][];
};

const DEFAULT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.json'];

/** Resolve platform → (mainFields, conditionNames) defaults. We emit ESM, so conditions are
 *  import-kind. */
function platformDefaults(platform: Platform): { mainFields: string[]; conditionNames: string[] } {
    switch (platform) {
        case 'browser':
            return { mainFields: ['browser', 'module', 'main'], conditionNames: ['import', 'browser', 'default'] };
        case 'neutral':
            return { mainFields: [], conditionNames: ['import', 'default'] };
        default:
            return { mainFields: ['main', 'module'], conditionNames: ['import', 'node', 'default'] };
    }
}

/** Normalize a {@link ResolveOptions} + platform into a {@link NormalizedResolve}. */
export function normalizeResolve(resolve: ResolveOptions | undefined, platform: Platform | undefined): NormalizedResolve {
    const r = resolve ?? {};
    const defaults = platformDefaults(platform ?? 'browser');
    return {
        extensions: r.extensions ?? DEFAULT_EXTENSIONS,
        extensionAlias: r.extensionAlias ?? {},
        mainFiles: r.mainFiles ?? ['index'],
        alias: r.alias ?? {},
        symlinks: r.symlinks ?? true,
        mainFields: r.mainFields ?? defaults.mainFields,
        conditionNames: r.conditionNames ?? defaults.conditionNames,
        exportsFields: r.exportsFields ?? [['exports']],
        aliasFields: r.aliasFields ?? [],
    };
}

/** The pipeline surface shared by `bundle()` and `createDevServer()` — how modules are
 *  loaded and resolved. Both extend it so resolution/transform config cannot drift between
 *  the dev and prod paths. */
export type CommonOptions = {
    fs?: Fs;
    external?: string[] | ((specifier: string) => boolean);
    /** A low-level resolver function OR a {@link ResolveOptions} config. */
    resolve?: ResolveFn | ResolveOptions;
    /** Deployment target → mainFields/conditionNames defaults. Default 'browser'. */
    platform?: Platform;
    plugins?: Plugin[];
    jsx?: JSXOptions;
};

/** Inputs to {@link buildGraph}. */
export type GraphOptions = CommonOptions & {
    /** One or more entry modules. Exactly one of `input` / `entry` must be set. */
    input?: InputOption;
    /** @deprecated single-entry alias for `input`. Normalized into `input`. */
    entry?: string;
    fs: Fs;
    /** Incremental parse cache (id → parsed artifacts). Pass a persistent Map across builds
     *  to reuse unchanged modules; the build fills/reads it. See {@link createBuildContext}. */
    cache?: ParseCache;
    /** Signal-mode incremental: when set, modules whose id is NOT in `changed` are reconstructed
     *  straight from {@link ParseCache} — no load/transform/hash/parse — trusting the caller's
     *  change signal (a {@link Watcher}). Resolution still runs every build, so it stays correct
     *  under file create/delete. Omit for auto-detect (hash every module to find changes). */
    incremental?: { changed: Set<string> };
    /** Accepted and IGNORED. Present so callers can pass it today. */
    preserveEntrySignatures?: false | 'strict' | 'allow-extension' | 'exports-only';
    /** Run the AST compress passes (minify P4) during scan. A transform concern (syntactic
     *  lowering), so it lives in scan and the parse-cache key includes it. Set by `bundle()` from
     *  `output.minify`; default false. */
    compress?: boolean;
};

/** Apply string→string `alias`: exact `key` or `key/…` prefix rewrites to the target. Runs
 *  before defaultResolve, skipping other plugins' resolveId. */
function applyAlias(specifier: string, alias: Record<string, string>): string {
    for (const key of Object.keys(alias)) {
        if (specifier === key) return alias[key];
        if (specifier.startsWith(`${key}/`)) return alias[key] + specifier.slice(key.length);
    }
    return specifier;
}

/** Relative/absolute config-driven probe. Builds the probe set from `extensions` +
 *  `mainFiles`, honours `extensionAlias` (try mapped exts for a matching suffix first). */
async function defaultResolve(
    fs: Fs,
    resolve: NormalizedResolve,
    specifier: string,
    importer: string | null,
): Promise<string | null> {
    const aliased = applyAlias(specifier, resolve.alias);
    if (!aliased.startsWith('./') && !aliased.startsWith('../') && !aliased.startsWith('/')) return null;
    const base = aliased.startsWith('/') || importer === null ? aliased : joinPath(dirnameOf(importer), aliased);

    // extensionAlias: if the specifier ends in a mapped ext (e.g. '.js'), try the alternatives
    // (e.g. '.ts','.js') BEFORE the generic probe.
    for (const [ext, alts] of Object.entries(resolve.extensionAlias)) {
        if (base.endsWith(ext)) {
            const stem = base.slice(0, base.length - ext.length);
            for (const alt of alts) {
                const candidate = stem + alt;
                if (await fs.exists(candidate)) return candidate;
            }
        }
    }

    // Direct hit, then each extension, then directory-index (mainFiles × extensions).
    if (await fs.exists(base)) return base;
    for (const ext of resolve.extensions) {
        if (await fs.exists(base + ext)) return base + ext;
    }
    for (const main of resolve.mainFiles) {
        for (const ext of resolve.extensions) {
            const candidate = `${base}/${main}${ext}`;
            if (await fs.exists(candidate)) return candidate;
        }
    }
    return null;
}

/** Build the base resolver from a resolve option (function or config) + platform — shared by
 *  {@link buildGraph} and the dev server so dev and prod resolve identically. A function
 *  bypasses the built-in probe entirely; a config drives it. */
export function makeBaseResolve(
    fs: Fs,
    resolve: ResolveFn | ResolveOptions | undefined,
    platform: Platform | undefined,
    warn: (message: string) => void,
): ResolveFn {
    if (typeof resolve === 'function') return resolve;
    const normalized = normalizeResolve(resolve, platform);
    const node = createNodeResolver({
        fs,
        conditions: normalized.conditionNames,
        extensions: normalized.extensions,
        mainFields: normalized.mainFields,
        warn,
    });
    // Node resolution first — it handles bare specifiers (node_modules / package `exports` /
    // workspace member) and browser-field remaps, and returns null for a plain relative import
    // (no browser-map owner). Those fall to the built-in probe (alias / extensionAlias /
    // extensions / mainFiles).
    return async (s, i) =>
        (await node.resolve(applyAlias(s, normalized.alias), i)) ?? (await defaultResolve(fs, normalized, s, i));
}

/** Whether a specifier is externalized by the `external` option. */
export function isExternalSpecifier(external: CommonOptions['external'], specifier: string): boolean {
    if (external === undefined) return false;
    if (typeof external === 'function') return external(specifier);
    return external.includes(specifier);
}

export function isExternal(options: GraphOptions, specifier: string): boolean {
    return isExternalSpecifier(options.external, specifier);
}
