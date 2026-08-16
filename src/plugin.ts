import type { Semantic } from './analysis/semantic';
import type { Program } from './ast';
import { applyEdits, type Edit } from './emit';
import type { Fs } from './fs';

/** Context passed to every plugin hook. */
export type PluginCtx = {
    warn(message: string): void;
    fs: Fs;
};

/** resolveId: string = resolved id, false = external, null/undefined = pass */
export type ResolveIdResult = string | false | null | undefined;
/** transform: string = replace source, Edit[] = patch it, null/undefined = pass */
export type TransformResult = string | Edit[] | null | undefined;

/** Id filter for a hook; non-matching ids skip the handler entirely. */
export type HookFilter = { id?: RegExp | RegExp[] };
/** A hook given as a bare function or as `{ filter, handler }`. */
export type WithFilter<F> = F | { filter?: HookFilter; handler: F };

/** Info handed to the `moduleParsed` hook after a module is parsed and analyzed. */
export type ModuleParsedInfo = {
    id: string;
    source: string;
    program: Program;
    nodeCount: number;
    semantic: Semantic;
};

/** A value or a promise of it. Hooks may be sync or async; the drivers below stay
 *  fully synchronous when no hook returns a thenable (P4 sync fast path). */
export type MaybePromise<T> = T | Promise<T>;

const isThenable = (x: unknown): x is Promise<unknown> =>
    x !== null && typeof x === 'object' && typeof (x as { then?: unknown }).then === 'function';

/** Unwrap a driver result in a synchronous context (bundle mode requires sync
 *  plugins). Throws if a hook went async — a clear error, not a silent hang. */
export function assertSync<T>(x: MaybePromise<T>): T {
    if (isThenable(x)) throw new Error('async plugin hook is not supported in this (synchronous) build context');
    return x as T;
}

/** A plugin: a name plus any of the rollup-shaped build hooks. Every hook may
 *  return a promise; the dev server awaits, bundle mode requires sync. */
export type Plugin = {
    name: string;
    buildStart?: (ctx: PluginCtx) => MaybePromise<void>;
    resolveId?: WithFilter<(ctx: PluginCtx, specifier: string, importer: string | null) => MaybePromise<ResolveIdResult>>;
    load?: WithFilter<(ctx: PluginCtx, id: string) => MaybePromise<string | null | undefined>>;
    transform?: WithFilter<(ctx: PluginCtx, code: string, id: string) => MaybePromise<TransformResult>>;
    moduleParsed?: (ctx: PluginCtx, info: ModuleParsedInfo) => MaybePromise<void>;
    renderChunk?: (ctx: PluginCtx, code: string) => string | null | undefined;
    buildEnd?: (ctx: PluginCtx) => MaybePromise<void>;
};

type Compiled<F> = { plugin: string; matches: ((id: string) => boolean) | null; handler: F };

/** Plugins flattened into dense per-hook arrays so hot loops skip feature tests. */
export type Pipeline = {
    buildStart: Compiled<NonNullable<Plugin['buildStart']>>[];
    resolveId: Compiled<Extract<NonNullable<Plugin['resolveId']>, (...a: never[]) => unknown>>[];
    load: Compiled<Extract<NonNullable<Plugin['load']>, (...a: never[]) => unknown>>[];
    transform: Compiled<Extract<NonNullable<Plugin['transform']>, (...a: never[]) => unknown>>[];
    moduleParsed: Compiled<NonNullable<Plugin['moduleParsed']>>[];
    renderChunk: Compiled<NonNullable<Plugin['renderChunk']>>[];
    buildEnd: Compiled<NonNullable<Plugin['buildEnd']>>[];
};

function compileMatcher(filter: HookFilter | undefined): ((id: string) => boolean) | null {
    if (filter?.id === undefined) return null;
    const patterns = Array.isArray(filter.id) ? filter.id : [filter.id];
    return (id: string) => patterns.some((p) => p.test(id));
}

function normalize<F>(plugin: string, hook: WithFilter<F> | undefined): Compiled<F> | null {
    if (hook === undefined) return null;
    if (typeof hook === 'function') return { plugin, matches: null, handler: hook as F };
    const h = hook as { filter?: HookFilter; handler: F };
    return { plugin, matches: compileMatcher(h.filter), handler: h.handler };
}

/** Flatten a plugin list into a {@link Pipeline}, compiling each hook's id filter. */
export function compilePipeline(plugins: readonly Plugin[]): Pipeline {
    const pipeline: Pipeline = {
        buildStart: [],
        resolveId: [],
        load: [],
        transform: [],
        moduleParsed: [],
        renderChunk: [],
        buildEnd: [],
    };
    for (const p of plugins) {
        const bs = normalize(p.name, p.buildStart);
        if (bs !== null) pipeline.buildStart.push(bs);
        const ri = normalize(p.name, p.resolveId);
        if (ri !== null) pipeline.resolveId.push(ri as Pipeline['resolveId'][number]);
        const ld = normalize(p.name, p.load);
        if (ld !== null) pipeline.load.push(ld as Pipeline['load'][number]);
        const tr = normalize(p.name, p.transform);
        if (tr !== null) pipeline.transform.push(tr as Pipeline['transform'][number]);
        const mp = normalize(p.name, p.moduleParsed);
        if (mp !== null) pipeline.moduleParsed.push(mp);
        const rc = normalize(p.name, p.renderChunk);
        if (rc !== null) pipeline.renderChunk.push(rc);
        const be = normalize(p.name, p.buildEnd);
        if (be !== null) pipeline.buildEnd.push(be);
    }
    return pipeline;
}

/** first-wins resolveId. Stays synchronous unless a hook returns a promise, then
 *  resumes the loop after it settles (sync fast path). */
export function runResolveId(
    pipeline: Pipeline,
    ctx: PluginCtx,
    specifier: string,
    importer: string | null,
): MaybePromise<ResolveIdResult> {
    const hooks = pipeline.resolveId;
    let i = 0;
    const step = (): MaybePromise<ResolveIdResult> => {
        while (i < hooks.length) {
            const hook = hooks[i++];
            if (hook.matches !== null && !hook.matches(specifier)) continue;
            const r = (hook.handler as (c: PluginCtx, s: string, im: string | null) => MaybePromise<ResolveIdResult>)(
                ctx,
                specifier,
                importer,
            );
            if (isThenable(r)) return r.then((v) => (v !== null && v !== undefined ? (v as ResolveIdResult) : step()));
            if (r !== null && r !== undefined) return r;
        }
        return null;
    };
    return step();
}

/** first-wins load (sync fast path). */
export function runLoad(pipeline: Pipeline, ctx: PluginCtx, id: string): MaybePromise<string | null> {
    const hooks = pipeline.load;
    let i = 0;
    const step = (): MaybePromise<string | null> => {
        while (i < hooks.length) {
            const hook = hooks[i++];
            if (hook.matches !== null && !hook.matches(id)) continue;
            const r = (hook.handler as (c: PluginCtx, i: string) => MaybePromise<string | null | undefined>)(ctx, id);
            if (isThenable(r)) return r.then((v) => (v !== null && v !== undefined ? (v as string) : step()));
            if (r !== null && r !== undefined) return r;
        }
        return null;
    };
    return step();
}

/** sequential transform chain; Edit[] results patch the running code (sync fast path). */
export function runTransform(pipeline: Pipeline, ctx: PluginCtx, code: string, id: string): MaybePromise<string> {
    const hooks = pipeline.transform;
    let current = code;
    let i = 0;
    const apply = (r: TransformResult): void => {
        if (r !== null && r !== undefined) current = typeof r === 'string' ? r : applyEdits(current, r);
    };
    const step = (): MaybePromise<string> => {
        while (i < hooks.length) {
            const hook = hooks[i++];
            if (hook.matches !== null && !hook.matches(id)) continue;
            const r = (hook.handler as (c: PluginCtx, code: string, i: string) => MaybePromise<TransformResult>)(
                ctx,
                current,
                id,
            );
            if (isThenable(r)) {
                return r.then((res) => {
                    apply(res as TransformResult);
                    return step();
                });
            }
            apply(r);
        }
        return current;
    };
    return step();
}

/** sequential moduleParsed hooks (post-parse AST access; sync fast path). */
export function runModuleParsed(pipeline: Pipeline, ctx: PluginCtx, info: ModuleParsedInfo): MaybePromise<void> {
    const hooks = pipeline.moduleParsed;
    let i = 0;
    const step = (): MaybePromise<void> => {
        while (i < hooks.length) {
            const r = hooks[i++].handler(ctx, info);
            if (isThenable(r)) return r.then(() => step());
        }
    };
    return step();
}
