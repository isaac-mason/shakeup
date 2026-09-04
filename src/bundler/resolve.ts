import type { CompressMode } from '../passes/compress/index.ts';
import { dirnameOf, type Fs, joinPath, type MaybePromise } from './fs.ts';
import type { ParseCache } from './graph-types.ts';
import { createNodeResolver, packageSideEffectsFor } from './node-resolve.ts';
import type { ModuleType, Plugin } from './plugin.ts';

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
/** What the base resolver discovered, beyond the id itself.
 *
 *  rolldown's resolver returns a RECORD, not a path — `ResolveReturn { path, module_def_format,
 *  package_json }` (`rolldown_resolver/src/resolver.rs:78`) — so facts found while resolving reach
 *  the loader instead of being recomputed or lost. `package.json#sideEffects` is the one shakeup was
 *  dropping on the floor: `readPkg` already loads the manifest for `exports`/`main`, then returned
 *  only a string, which made the field unreachable by construction. */
export type ResolvedIdInfo = {
    id: string;
    /** From `package.json#sideEffects`. Absent = the manifest said nothing; a PLUGIN's value always
     *  wins over this (rolldown `normalize_side_effects`, `ecma_module_view_factory.rs:171`). */
    moduleSideEffects?: boolean;
};

/** A user-supplied `resolve` function may keep returning a bare id — the record form is a superset,
 *  mirroring how a plugin's `resolveId` may return a string or a `PartialResolvedId`. */
export type ResolveFn = (specifier: string, importer: string | null) => MaybePromise<string | ResolvedIdInfo | null>;

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
    /** Directory a relative specifier resolves against when there is NO importer — a plugin's
     *  `this.resolve('./x')`, or a relative entry. Rollup uses `resolve(source)`, i.e. the process
     *  cwd (`utils/resolveId.ts`); rolldown's resolver holds the same as `self.cwd` and falls back to
     *  it "matching Rollup's behavior of resolving bare relative paths against CWD when no importer
     *  is present" (`rolldown_resolver/src/resolver.rs`). Explicit here because shakeup also runs in
     *  the browser, where there is no `process`. Default: `process.cwd()` if there is one, else `/`. */
    cwd?: string;
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
    cwd: string;
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
        cwd: r.cwd ?? defaultCwd(),
    };
}

/** `process.cwd()` where there is a process, `/` in the browser. */
function defaultCwd(): string {
    const p = (globalThis as { process?: { cwd?: () => string } }).process;
    return typeof p?.cwd === 'function' ? p.cwd() : '/';
}

/** The pipeline surface shared by `bundle()` and `createDevServer()` — how modules are
 *  loaded and resolved. Both extend it so resolution/transform config cannot drift between
 *  the dev and prod paths. */
export type CommonOptions = {
    fs?: Fs;
    /** Specifiers to leave as imports. The FUNCTION form takes Rollup's three arguments —
     *  `(id, parentId, isResolved)` — because real configs branch on the importer; passing only the
     *  specifier made every call look like an entry resolution. */
    external?: string[] | ((specifier: string, parentId?: string, isResolved?: boolean) => boolean | undefined);
    /** A low-level resolver function OR a {@link ResolveOptions} config. */
    resolve?: ResolveFn | ResolveOptions;
    /** Deployment target → mainFields/conditionNames defaults. Default 'browser'. */
    platform?: Platform;
    plugins?: Plugin[];
    jsx?: JSXOptions;
};

/** Inputs to {@link buildGraph}. */
/** `treeshake.moduleSideEffects` — the DEFAULT a module's side-effect flag falls back to, and
 *  rolldown's option of the same name (`treeshake.rs:206`).
 *
 *  `false` treats every module as side-effect-free, so a module whose exports nothing uses is dropped
 *  whole. A FUNCTION is asked per module and may answer `undefined` to defer. `true` is the default
 *  and defers to the manifest and then to per-statement analysis, which is what rolldown's
 *  `Boolean(true) => None` means — it is not "assume side effects".
 *
 *  PRECEDENCE, from rolldown's `normalize_side_effects` (`ecma_module_view_factory.rs:171`):
 *  plugin hook, then THIS, then `package.json#sideEffects`, then per-statement analysis. */
export type ModuleSideEffectsOption = boolean | ((id: string, external: boolean) => boolean | undefined);

export type TreeshakeOptions = {
    moduleSideEffects?: ModuleSideEffectsOption;
};

export type GraphOptions = CommonOptions & {
    /** `false` disables tree-shaking entirely; an object configures it. */
    treeshake?: boolean | TreeshakeOptions;
    /** Compile-time global replacement (esbuild/Vite `define`). Keys are a bare identifier
     *  (`__DEV__`) or a dotted global chain (`process.env.NODE_ENV`); VALUES ARE JS SOURCE, so a
     *  string replacement needs its own quotes: `{ 'process.env.NODE_ENV': '"production"' }`.
     *
     *  Only FREE references are replaced, so a local binding of the same name is untouched, and
     *  assignment targets are never substituted. Runs before compress, so the substituted literal
     *  feeds constant folding and dead-code elimination — which is what actually shrinks (and, on a
     *  browser target where `process` does not exist, un-breaks) real dependencies. */
    define?: Record<string, string>;
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
    compress?: CompressMode | false;
    /** Extension → {@link ModuleType}, overriding the built-in map. The leading dot is optional:
     *  `{ '.png': 'dataurl', wgsl: 'text' }`. rolldown's option of the same name, and the only way
     *  to reach `base64`/`dataurl`/`binary` by extension — neither oracle maps any extension to
     *  them by default, since which one a `.png` should use is a build decision. An import
     *  attribute (`with { type: 'text' }`) or a plugin's `moduleType` still wins over this. */
    moduleTypes?: Record<string, ModuleType>;
    /** Run the OPTIMIZE tier (directive-gated: `@optimize`/`@inline`/`@sroa`/`@unroll` → function
     *  inlining, loop unrolling, SROA, flow-sensitive inlining). These fire only where a source
     *  directive opts in, so `true` is safe as the default; set `false` to IGNORE all directives —
     *  a faster, directive-free build (e.g. dev), or to A/B the tier's effect. Part of the
     *  parse-cache key, like `compress`, since it changes the emitted AST. Default true. */
    optimize?: boolean;
    /** Report early errors that need the semantic model — strict-mode rules, scope and symbol rules.
     *  Default TRUE, matching rolldown, which runs oxc's checker on every module and FAILS the build
     *  on any error (`pre_process_ecma_ast.rs:70`). Set `false` to bundle input you know is invalid. */
    checkSyntaxErrors?: boolean;
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
    // No importer — a plugin's `this.resolve('./x')` or a relative entry — resolves against the cwd,
    // which is what both Rollup and rolldown do. Returning the specifier untouched left
    // `custom-resolve-options` with `id: './main.js'` where Rollup gives an absolute path, and made
    // `this.resolve` answer null whenever the process cwd was not the fixture directory.
    const base = aliased.startsWith('/') ? aliased : joinPath(importer === null ? resolve.cwd : dirnameOf(importer), aliased);

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
    return async (s, i) => {
        const raw = (await node.resolve(applyAlias(s, normalized.alias), i)) ?? (await defaultResolve(fs, normalized, s, i));
        if (raw === null) return null;
        // Deref BEFORE looking up the owner. `scan` keys a module — and its pending options — by the
        // post-realpath id, so reporting `sideEffects` against the symlinked path would file it under
        // a key nothing reads. Under pnpm those differ for every dependency, which is precisely the
        // case this is for. `scan` derefs again downstream; realpath is idempotent and memoized.
        const id = normalized.symlinks ? ((await fs.realpath?.(raw)) ?? raw) : raw;
        // Enrich BOTH branches: a relative import inside a package inherits that package's
        // `sideEffects` just as a bare one does, which is what makes `sideEffects: false` apply
        // package-wide. oxc-resolver returns the owning manifest for every resolve; shakeup splits
        // bare/relative resolution, so the lookup is applied here where they rejoin.
        const pkg = await node.packageFor(id);
        if (pkg === null) return id;
        const sideEffects = packageSideEffectsFor(pkg, id);
        return sideEffects === undefined ? id : { id, moduleSideEffects: sideEffects };
    };
}

/** Whether a specifier is externalized by the `external` option. */
export function isExternalSpecifier(
    external: CommonOptions['external'],
    specifier: string,
    parentId?: string,
    isResolved = false,
): boolean {
    if (external === undefined) return false;
    if (typeof external === 'function') {
        // `\0` is the reserved marker for a plugin's VIRTUAL module — never a real specifier, so it
        // is never offered to the predicate. rolldown wraps a function `external` with exactly this
        // (`bindingify-input-options.ts:172`), and Rollup's
        // `external-ignore-reserved-null-marker` throws if the id ever reaches the hook.
        // The ARRAY form is not filtered, in either bundler: naming a `\0` id there is explicit.
        if (specifier.startsWith('\0')) return false;
        // TRUTHY, not `=== true`: rolldown normalises with `measured(...) ?? false`
        // (`bindingify-input-options.ts:173`), so `undefined` means "not external" and anything else
        // truthy means it is. A first cut used `=== true` and quietly disagreed with both oracles.
        return Boolean(external(specifier, parentId, isResolved) ?? false);
    }
    return external.includes(specifier);
}

export function isExternal(options: GraphOptions, specifier: string, parentId?: string): boolean {
    return isExternalSpecifier(options.external, specifier, parentId);
}
