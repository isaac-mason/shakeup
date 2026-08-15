import type { Program } from './ast';
import { type Edit, applyEdits } from './emit';
import type { Fs } from './fs';
import type { Semantic } from './analysis/semantic';

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

/** A plugin: a name plus any of the rollup-shaped build hooks. */
export type Plugin = {
    name: string;
    buildStart?: (ctx: PluginCtx) => void;
    resolveId?: WithFilter<(ctx: PluginCtx, specifier: string, importer: string | null) => ResolveIdResult>;
    load?: WithFilter<(ctx: PluginCtx, id: string) => string | null | undefined>;
    transform?: WithFilter<(ctx: PluginCtx, code: string, id: string) => TransformResult>;
    moduleParsed?: (ctx: PluginCtx, info: ModuleParsedInfo) => void;
    renderChunk?: (ctx: PluginCtx, code: string) => string | null | undefined;
    buildEnd?: (ctx: PluginCtx) => void;
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

/** first-wins resolveId over the compiled pipeline (string | false | null) */
export function runResolveId(
    pipeline: Pipeline,
    ctx: PluginCtx,
    specifier: string,
    importer: string | null,
): ResolveIdResult {
    for (const hook of pipeline.resolveId) {
        if (hook.matches !== null && !hook.matches(specifier)) continue;
        const result = (hook.handler as (c: PluginCtx, s: string, i: string | null) => ResolveIdResult)(
            ctx,
            specifier,
            importer,
        );
        if (result !== null && result !== undefined) return result;
    }
    return null;
}

/** first-wins load */
export function runLoad(pipeline: Pipeline, ctx: PluginCtx, id: string): string | null {
    for (const hook of pipeline.load) {
        if (hook.matches !== null && !hook.matches(id)) continue;
        const result = (hook.handler as (c: PluginCtx, i: string) => string | null | undefined)(ctx, id);
        if (result !== null && result !== undefined) return result;
    }
    return null;
}

/** sequential transform chain; Edit[] results are applied to the running code */
export function runTransform(pipeline: Pipeline, ctx: PluginCtx, code: string, id: string): string {
    let current = code;
    for (const hook of pipeline.transform) {
        if (hook.matches !== null && !hook.matches(id)) continue;
        const result = (hook.handler as (c: PluginCtx, code: string, i: string) => TransformResult)(ctx, current, id);
        if (result === null || result === undefined) continue;
        current = typeof result === 'string' ? result : applyEdits(current, result);
    }
    return current;
}
