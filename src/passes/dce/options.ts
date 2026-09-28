// Port of oxc_minifier/src/options.rs, reduced to what `CompressOptions::dce()` and rolldown pass.

import type { EngineTargets, EsFeature, PropertyReadSideEffects } from '../../analysis/side-effects.ts';

/** oxc `EngineTargets`, as the two queries the tree-shake pipeline makes of it. */
export type CompressTargets = EngineTargets & {
    /** oxc `EngineTargets::has_feature`: true when some target engine lacks `feature` and needs it transformed. */
    hasFeature: (feature: string) => boolean;
};

/** `esnext`: every engine feature is available. */
export const ESNEXT_TARGETS: CompressTargets = {
    hasFeature: () => false,
    supportsEsFeature: (_feature: EsFeature) => true,
};

const featureYear = (feature: string): number => Number(/^ES(\d{4})/.exec(feature)?.[1] ?? 0);

/** `EngineTargets::from_target("es2015")`, which rolldown's chunk-level `dce-only` pass uses so it
 *  introduces no syntax newer than ES2015. */
export const ES2015_TARGETS: CompressTargets = {
    hasFeature: (feature) => featureYear(feature) > 2015,
    supportsEsFeature: (feature: EsFeature) => featureYear(feature) <= 2015,
};

export type CompressOptionsUnused ='remove' | 'keep-assign' | 'keep';

export type CompressOptionsKeepNames = { function: boolean; class: boolean };

export type TreeShakeOptions = {
    annotations: boolean;
    manualPureFunctions: readonly string[];
    propertyReadSideEffects: PropertyReadSideEffects;
    propertyWriteSideEffects: boolean;
    unknownGlobalSideEffects: boolean;
    invalidImportSideEffects: boolean;
};

export type CompressOptions = {
    target: CompressTargets;
    dropDebugger: boolean;
    dropConsole: boolean;
    joinVars: boolean;
    sequences: boolean;
    unused: CompressOptionsUnused;
    keepNames: CompressOptionsKeepNames;
    treeshake: TreeShakeOptions;
    dropLabels: ReadonlySet<string>;
    maxIterations: number | null;
};

/** oxc `TreeShakeOptions::default()`. */
export function defaultTreeShakeOptions(): TreeShakeOptions {
    return {
        annotations: true,
        manualPureFunctions: [],
        propertyReadSideEffects: 'all',
        propertyWriteSideEffects: true,
        unknownGlobalSideEffects: true,
        invalidImportSideEffects: false,
    };
}

/** oxc `CompressOptions::dce()`. */
export function dceOptions(): CompressOptions {
    return {
        target: ESNEXT_TARGETS,
        keepNames: { function: true, class: true },
        dropDebugger: false,
        dropConsole: false,
        joinVars: false,
        sequences: false,
        unused: 'remove',
        treeshake: defaultTreeShakeOptions(),
        dropLabels: new Set(),
        maxIterations: null,
    };
}

/** What rolldown's chunk-level `dce-only` minify passes (`minify_options.rs`): `CompressOptions::dce()` at
 *  an ES2015 target, with the bundle's treeshake options as given. */
export function rolldownChunkDceOptions(treeshake: Partial<TreeShakeOptions> = {}): CompressOptions {
    return { ...dceOptions(), target: ES2015_TARGETS, treeshake: { ...defaultTreeShakeOptions(), ...treeshake } };
}

/** What rolldown's `pre_process_ecma_ast` step 5 passes: `CompressOptions::dce()` with the bundle's
 *  target and `TreeShakeOptions::from(&bundle_options.treeshake)`, forcing `invalid_import_side_effects`. */
export function rolldownDceOptions(
    target: CompressTargets = ESNEXT_TARGETS,
    treeshake: Partial<TreeShakeOptions> = {},
): CompressOptions {
    return {
        ...dceOptions(),
        target,
        treeshake: { ...defaultTreeShakeOptions(), ...treeshake, invalidImportSideEffects: true },
    };
}
