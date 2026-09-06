import type { CompressMode } from '../passes/compress/index.ts';
import { type GetHash, type HashCharacters, hasherByType } from '../util/hash.ts';

/**
 * One module's contribution to a chunk, as both oracles report it on `OutputChunk.modules`.
 *
 * `code` is the module's region of the RENDERED chunk — its text before any chunk-level
 * post-processing. shakeup's cosmetic compress (and rolldown's minifier, and a `renderChunk` plugin)
 * run over the assembled chunk afterwards and neither bundler restates these; Rollup documents
 * `renderedLength` the same way.
 */
export type RenderedModule = {
    code: string | null;
    renderedLength: number;
    /** The module's exported names that SURVIVED — shaken-away ones are not listed. */
    renderedExports: string[];
};

/** Slim `PreRenderedChunk` passed to filename functions. */
export type PreRenderedChunk = {
    name: string;
    isEntry: boolean;
    isDynamicEntry: boolean;
    facadeModuleId: string | null;
    moduleIds: string[];
    exports: string[];
    type: 'chunk';
};

export type ChunkFileNamesFn = (chunk: PreRenderedChunk) => string;
/** Addon (banner/footer/intro/outro) function — sync only. */
export type AddonFn = (chunk: PreRenderedChunk) => string;

export type ExportsMode = 'auto' | 'named' | 'default' | 'none';

export type SourcemapIgnoreList = boolean | string | RegExp | ((source: string, mapPath: string) => boolean);

export type OutputOptionsNaming = {
    /** Which comment classes to preserve. `true` (the default, as in rolldown) keeps legal
     *  (`@license`, `@preserve`, `/*!`) and JSDoc; `false` keeps neither. */
    comments?: OutputCommentsOption;
    // placement
    dir?: string;
    file?: string;
    // naming patterns
    entryFileNames?: string | ChunkFileNamesFn; // default '[name].js'
    chunkFileNames?: string | ChunkFileNamesFn; // default '[name]-[hash].js'
    assetFileNames?: string | ChunkFileNamesFn; // default 'assets/[name]-[hash][extname]'
    hashCharacters?: HashCharacters; // default 'base64'
    sanitizeFileName?: boolean | ((name: string) => string); // default true
    // addons
    banner?: string | AddonFn;
    footer?: string | AddonFn;
    intro?: string | AddonFn;
    outro?: string | AddonFn;
    // ESM shaping
    exports?: ExportsMode;
    externalLiveBindings?: boolean; // pure ESM: accept, no-op
    // sourcemaps
    sourcemap?: boolean | 'inline' | 'hidden';
    sourcemapExcludeSources?: boolean;
    sourcemapIgnoreList?: SourcemapIgnoreList;
    /** Preserve a class's `.name` when deconfliction renames its binding: `class foo {}` emitted as
     *  `class foo$1 {}` would otherwise answer `'foo$1'`. Off by default, as in rolldown and esbuild
     *  — Rollup does it unconditionally. Implemented with Rollup's zero-runtime mechanism
     *  (`let foo$1 = class foo {}`), not rolldown's `__name` helper. Classes only so far; a renamed
     *  FUNCTION still loses its name, because the same rewrite would change hoisting. */
    keepNames?: boolean;
    topLevelVar?: boolean; // not implemented — needs module-init wrapping
    /** `true` = full minify (whitespace + mangle + compress). The object form opts into each
     *  sub-stage independently (esbuild's `minifyWhitespace`/`minifyIdentifiers`/`minifySyntax`):
     *  each field defaults to `false`, so `{ compress: true }` runs ONLY the compress passes. */
    minify?: boolean | MinifyOptions;
    /** Run the OPTIMIZE tier — the directive-gated hot-path optimizations (`@optimize`/`@inline`/
     *  `@sroa`/`@unroll` → function inlining, loop unrolling, SROA, flow-sensitive inlining). They fire
     *  only where a source directive opts in, so `true` (the default) is safe; set `false` to ignore
     *  all directives for a faster, directive-free build, or to A/B the tier. Independent of `minify`:
     *  the two tiers are orthogonal (minify = whitespace/mangle/compress; optimize = directive opts). */
    optimize?: boolean;
};

/** Per-stage minify toggles (esbuild model). Each defaults to false in the object form. */
export type MinifyOptions = {
    /** Elide readability whitespace + syntactic-form shortening in the printer. */
    whitespace?: boolean;
    /** Rename bindings to short base54 names (deconflict/mangle). */
    mangle?: boolean;
    /** AST compress passes (dead-code, fold-constants, …) — the P4 pipeline. */
    compress?: boolean | 'dce';
};

/** Fully-resolved minify sub-stage flags. */
/** `compress` is a MODE, not a flag: `'full'` runs every pass, `'dce'` runs only the passes that
 *  change which code EXISTS (removals + the folds they need), and `false` runs none. See
 *  `CompressMode` in `passes/compress` — the split is oxc's `CompressionMode`, and it is what allows
 *  optimisation to behave identically in dev and in a bundle while only the cosmetic tier differs. */
export type ResolvedMinify = { whitespace: boolean; mangle: boolean; compress: CompressMode | false };

/** Resolve the `minify` option: `true` = all stages on; an object opts into each stage (default
 *  false per field); falsy = all off. Resolved once and threaded so whitespace/mangle/compress
 *  never drift apart. */
/** `comments: true | false | { legal?, jsdoc? }`, defaulting to rolldown's `true`. `normal` is not
 *  offered — rolldown does not print ordinary comments and neither do we, because an AST printer
 *  cannot place them faithfully. */
export function normalizeComments(c: OutputCommentsOption | undefined): { legal: boolean; jsdoc: boolean } {
    if (c === false) return { legal: false, jsdoc: false };
    if (c === undefined || c === true) return { legal: true, jsdoc: true };
    return { legal: c.legal ?? true, jsdoc: c.jsdoc ?? true };
}

export type OutputCommentsOption = boolean | { legal?: boolean; jsdoc?: boolean };

/** The comment classes a given print actually emits, given whether it is minifying.
 *
 *  rolldown's `minify_chunks.rs:33-40` verbatim: **JSDoc is dropped when whitespace is removed** and
 *  legal is kept. Minified output is not read by humans, so the docs are dead weight — keeping them
 *  cost 8.5% on a minified crashcat bundle — while a licence has to survive precisely because
 *  everything around it is being stripped. */
export function effectiveComments(c: { legal: boolean; jsdoc: boolean }, minify: boolean): { legal: boolean; jsdoc: boolean } {
    return { legal: c.legal, jsdoc: c.jsdoc && !minify };
}

export function resolveMinify(minify: boolean | MinifyOptions | undefined): ResolvedMinify {
    if (minify === true) return { whitespace: true, mangle: true, compress: 'full' };
    if (minify !== null && typeof minify === 'object') {
        return {
            whitespace: minify.whitespace === true,
            mangle: minify.mangle === true,
            // Omitted → `'dce'`: the semantic tier is ALWAYS on. Only an explicit `false` opts out.
            compress: minify.compress === true ? 'full' : minify.compress === false ? false : 'dce',
        };
    }
    // No `minify` at all still runs the SEMANTIC tier. Optimisation (what code exists, which branch
    // is taken) is then identical in dev and in a bundle; only the cosmetic tier is gated on `minify`.
    return { whitespace: false, mangle: false, compress: 'dce' };
}

/** Fully-resolved output naming config with defaults applied. */
export type NormalizedOutputNaming = {
    dir: string;
    file: string | null;
    entryFileNames: string | ChunkFileNamesFn;
    chunkFileNames: string | ChunkFileNamesFn;
    assetFileNames: string | ChunkFileNamesFn;
    hashCharacters: HashCharacters;
    getHash: GetHash;
    sanitizeFileName: (name: string) => string;
    banner: AddonFn;
    footer: AddonFn;
    intro: AddonFn;
    outro: AddonFn;
    exports: ExportsMode;
    sourcemap: boolean | 'inline' | 'hidden';
    /** Which comment classes survive into the output. rolldown's defaults
     *  (`rolldown_common/.../comments.rs:26`): legal and JSDoc on, normal comments never. */
    comments: { legal: boolean; jsdoc: boolean };
    sourcemapExcludeSources: boolean;
    sourcemapIgnoreList: (source: string, mapPath: string) => boolean;
    minify: boolean;
    /** See {@link OutputOptions.keepNames}. */
    keepNames: boolean;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: RFC2396 invalid-char class, verbatim from rollup.
const INVALID_CHAR_REGEX = /[\x00-\x1f"#$%&*+,:;<=>?[\]^`{|}\x7f]/g;
const DRIVE_LETTER_REGEX = /^[a-z]:/i;

export function sanitizeFileName(name: string): string {
    const match = DRIVE_LETTER_REGEX.exec(name);
    const driveLetter = match ? match[0] : '';
    // ':' allowed only as a windows drive letter; otherwise strip (NTFS ADS hazard).
    return driveLetter + name.slice(driveLetter.length).replace(INVALID_CHAR_REGEX, '_');
}

const isAbsolutePath = (name: string): boolean => name[0] === '/' || /^[a-z]:/i.test(name);

/** True iff `name` starts with "/", "./", "../" or a windows drive letter — such patterns/
 *  substitutions are rejected: subdirectories are written `subdir/[name]` (no leading slash). */
export function isPathFragment(name: string): boolean {
    return name[0] === '/' || (name[0] === '.' && (name[1] === '/' || name[1] === '.')) || isAbsolutePath(name);
}

const PATTERN_REGEX = /\[(\w+)(:\d+)?]/g;

/** Expand `pattern` (`[name]`, `[hash]`, `[hash:12]`, `[format]`, `[ext]`, `[extname]`) using
 *  the given `replacements`. `:size` is valid only on `[hash]`. Throws on invalid patterns. */
export function renderNamePattern(
    pattern: string,
    patternName: string,
    replacements: Record<string, (size?: number) => string>,
): string {
    if (isPathFragment(pattern)) {
        throw new Error(
            `Invalid pattern "${pattern}" for "${patternName}", patterns can be neither absolute nor relative paths. ` +
                `To store files in a subdirectory, write its name without a leading slash: subdirectory/pattern.`,
        );
    }
    return pattern.replace(PATTERN_REGEX, (_match, type: string, size: string | undefined) => {
        if (!Object.hasOwn(replacements, type) || (size && type !== 'hash')) {
            throw new Error(`"[${type}${size || ''}]" is not a valid placeholder in the "${patternName}" pattern.`);
        }
        const replacement = replacements[type](size ? Number.parseInt(size.slice(1), 10) : undefined);
        if (isPathFragment(replacement)) {
            throw new Error(
                `Invalid substitution "${replacement}" for placeholder "[${type}]" in "${patternName}" pattern, ` +
                    `can be neither absolute nor relative path.`,
            );
        }
        return replacement;
    });
}

/** Collision-suffix a NON-HASHED name against `reserved` (lowercased keyset): split
 *  `dir + base + ext` at the first '.' after position 1, append 2,3,… */
export function makeUnique(name: string, reserved: Set<string>): string {
    if (!reserved.has(name.toLowerCase())) return name;
    const slashIndex = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    const directory = name.slice(0, slashIndex + 1);
    const fileName = name.slice(slashIndex + 1);
    const dotIndex = fileName.indexOf('.', 1);
    const base = directory + (dotIndex === -1 ? fileName : fileName.slice(0, dotIndex));
    const extension = dotIndex === -1 ? '' : fileName.slice(dotIndex);
    let uniqueName: string;
    let uniqueIndex = 1;
    // biome-ignore lint/suspicious/noAssignInExpressions: mirrors rollup makeUnique loop.
    while (reserved.has((uniqueName = `${base}${++uniqueIndex}${extension}`).toLowerCase()));
    return uniqueName;
}

const HP_LEFT = '!~{';
const HP_RIGHT = '}~';
const HP_OVERHEAD = HP_LEFT.length + HP_RIGHT.length; // 5

export const MAX_HASH_SIZE = 21;
export const DEFAULT_HASH_SIZE = 8;

// Alphabet order (0-9 a-z A-Z _ $) is load-bearing for short unique tokens.
const B64_INDEX = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';

function toBase64Index(value: number): string {
    let out = '';
    let v = value;
    do {
        out = B64_INDEX[v % 64] + out;
        v = (v / 64) | 0;
    } while (v !== 0);
    return out;
}

export type HashPlaceholderGenerator = (patternName: string, hashSize: number) => string;

/** A closure yielding unique, fixed-width, content-free placeholder tokens in creation order. */
export function getHashPlaceholderGenerator(): HashPlaceholderGenerator {
    let nextIndex = 0;
    return (patternName, hashSize) => {
        if (hashSize > MAX_HASH_SIZE) {
            throw new Error(
                `Hashes cannot be longer than ${MAX_HASH_SIZE} characters, received ${hashSize}. Check the "${patternName}" option.`,
            );
        }
        const placeholder = `${HP_LEFT}${toBase64Index(++nextIndex).padStart(hashSize - HP_OVERHEAD, '0')}${HP_RIGHT}`;
        if (placeholder.length > hashSize) {
            throw new Error(
                `To generate hashes for this number of chunks (currently ${nextIndex}), you need a minimum hash size of ${placeholder.length}, received ${hashSize}. Check the "${patternName}" option.`,
            );
        }
        return placeholder;
    };
}

const REPLACER_REGEX = new RegExp(`${HP_LEFT}[0-9a-zA-Z_$]{1,${MAX_HASH_SIZE - HP_OVERHEAD}}${HP_RIGHT}`, 'g');

/** Substitute every placeholder in `code` with its resolved hash (unknown ones untouched). */
export const replacePlaceholders = (code: string, hashesByPlaceholder: Map<string, string>): string =>
    code.replace(REPLACER_REGEX, (placeholder) => hashesByPlaceholder.get(placeholder) || placeholder);

/** Substitute only `placeholder` with `value` (collision-retry helper). */
export const replaceSinglePlaceholder = (code: string, placeholder: string, value: string): string =>
    code.replace(REPLACER_REGEX, (match) => (match === placeholder ? value : match));

/** Canonicalize every OWN-set placeholder in `code` to a zero-filled token of equal length AND
 *  record which were present. This makes the content hash independent of dependency hash VALUES
 *  while still recording the dependency edges (the crux of deterministic cyclic hashing). */
export function replacePlaceholdersWithDefaultAndGetContainedPlaceholders(
    code: string,
    placeholders: Set<string>,
): { containedPlaceholders: Set<string>; transformedCode: string } {
    const containedPlaceholders = new Set<string>();
    const transformedCode = code.replace(REPLACER_REGEX, (placeholder) => {
        if (placeholders.has(placeholder)) {
            containedPlaceholders.add(placeholder);
            return `${HP_LEFT}${'0'.repeat(placeholder.length - HP_OVERHEAD)}${HP_RIGHT}`;
        }
        return placeholder;
    });
    return { containedPlaceholders, transformedCode };
}

const toAddonFn = (v: string | AddonFn | undefined): AddonFn => {
    if (v === undefined) return () => '';
    if (typeof v === 'function') return v;
    return () => v;
};

/** Resolve an {@link OutputOptionsNaming} into a {@link NormalizedOutputNaming}, applying
 *  defaults. `warnings`/`multiChunk` drive validation (`file` guard, warnings). */
export function normalizeOutputOptions(
    output: OutputOptionsNaming | undefined,
    legacySourcemap: boolean | undefined,
    multiChunk: boolean,
    warnings: string[],
): NormalizedOutputNaming {
    const o = output ?? {};
    if (o.topLevelVar === true) warnings.push('output.topLevelVar is not implemented (needs module-init wrapping) — ignored.');
    if (o.file !== undefined && multiChunk) {
        throw new Error('"output.file" is only valid for a single-chunk build. Use "output.dir" for multiple chunks.');
    }

    const sanitizeOpt = o.sanitizeFileName;
    const sanitize =
        sanitizeOpt === false ? (name: string) => name : typeof sanitizeOpt === 'function' ? sanitizeOpt : sanitizeFileName;

    const hashCharacters = o.hashCharacters ?? 'base64';

    const exportsMode = o.exports ?? 'auto';
    if (!['auto', 'named', 'default', 'none'].includes(exportsMode)) {
        throw new Error(`"output.exports" must be "auto", "named", "default" or "none", received "${exportsMode}".`);
    }

    // VALUE VALIDATION for options we accept but do not act on (`interop`, `generatedCode`).
    //
    // Worth doing precisely BECAUSE they are unimplemented: silently ignoring an option a user set is
    // a worse failure than rejecting a bad value for it — the build looks configured and is not.
    // These reject invalid VALUES only; every value rollup accepts is still accepted here (and then
    // ignored), so nothing that works today breaks. Messages transcribed from rollup's `logs.ts`.
    const GENERATED_CODE_PRESETS = ['es5', 'es2015'];
    const gc = (o as { generatedCode?: unknown }).generatedCode;
    if (typeof gc === 'string' && !GENERATED_CODE_PRESETS.includes(gc)) {
        throw new Error(
            `Invalid value ${JSON.stringify(gc)} for option "output.generatedCode" - valid values are "es2015" and "es5". You can also supply an object for more fine-grained control.`,
        );
    }
    if (gc !== null && typeof gc === 'object') {
        const preset = (gc as { preset?: unknown }).preset;
        if (preset !== undefined && (typeof preset !== 'string' || !GENERATED_CODE_PRESETS.includes(preset))) {
            throw new Error(
                `Invalid value ${JSON.stringify(preset)} for option "output.generatedCode.preset" - valid values are "es2015" and "es5".`,
            );
        }
    }
    const INTEROP_VALUES = ['compat', 'auto', 'esModule', 'default', 'defaultOnly'];
    const interop = (o as { interop?: unknown }).interop;
    if (typeof interop === 'string' && !INTEROP_VALUES.includes(interop)) {
        throw new Error(
            `Invalid value ${JSON.stringify(interop)} for option "output.interop" - use one of "compat", "auto", "esModule", "default", "defaultOnly".`,
        );
    }

    const sm = o.sourcemap ?? legacySourcemap ?? false;
    const ignore = normalizeIgnoreList(o.sourcemapIgnoreList);

    return {
        dir: o.dir ?? 'dist',
        file: o.file ?? null,
        entryFileNames: o.entryFileNames ?? '[name].js',
        chunkFileNames: o.chunkFileNames ?? '[name]-[hash].js',
        assetFileNames: o.assetFileNames ?? 'assets/[name]-[hash][extname]',
        hashCharacters,
        getHash: hasherByType[hashCharacters],
        sanitizeFileName: sanitize,
        banner: toAddonFn(o.banner),
        footer: toAddonFn(o.footer),
        intro: toAddonFn(o.intro),
        outro: toAddonFn(o.outro),
        exports: exportsMode,
        sourcemap: sm,
        sourcemapExcludeSources: o.sourcemapExcludeSources ?? false,
        sourcemapIgnoreList: ignore,
        minify: resolveMinify(o.minify).whitespace, // printer whitespace/syntactic gate
        keepNames: o.keepNames === true,
        comments: normalizeComments(o.comments),
    };
}

/** Resolve `sourcemapIgnoreList` into a predicate. Default: /node_modules/. */
function normalizeIgnoreList(v: SourcemapIgnoreList | undefined): (source: string, mapPath: string) => boolean {
    if (v === undefined) return (source) => source.includes('node_modules');
    if (v === false) return () => false;
    if (v === true) return () => true;
    if (typeof v === 'string') return (source) => source.includes(v);
    if (v instanceof RegExp) return (source) => v.test(source);
    // A user FUNCTION must actually answer the question. rollup validates the return
    // (`sourcemapIgnoreList function must return a boolean.`) rather than letting `undefined` fall
    // through as a silent "not ignored" — which is exactly the sort of misconfiguration that looks
    // like it worked. Wrapped rather than checked once, because the answer is per-source.
    return (source, mapPath) => {
        const r = v(source, mapPath);
        if (typeof r !== 'boolean') throw new Error('sourcemapIgnoreList function must return a boolean.');
        return r;
    };
}
