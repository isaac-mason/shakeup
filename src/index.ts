// THE BUNDLER'S PUBLIC API — `shakeup`.
//
// Every line here is deliberate. This file was 25 bare `export *` lines producing 148 runtime values,
// which meant nothing had been chosen: `buildGraph`, `linkGraph`, `deconflictChunk`, `retireSymbol`,
// `allocId` and `packRef` were all package API, so renaming any internal was a breaking change.
//
// The shape follows rolldown's own entry (`packages/rolldown/src/index.ts`): a SMALL, explicit set of
// values — it ships 7 — beside a LARGE set of types, roughly 120, and not one `export *` anywhere.
// Values are the commitment; types only describe what the values already accept and return, so they
// are exported liberally via `export type *`, which takes every type from a module and none of its
// values. That is what keeps the value list honest without forcing a hand-maintained type list that
// would drift the moment a signature changed.
//
// The LANGUAGE TOOLCHAIN — parser, AST, semantic analysis — is not here. It is `shakeup/ast`, mirroring
// the `src/` split where `bundler/` depends on the toolchain and never the reverse
// (`tst/toolchain-boundary.test.ts`). Splitting the entries the same way means a consumer who wants an
// AST does not pull in a bundler, and the package's two halves stay legible from the outside.
//
// Note `ast/estree.ts` is deliberately absent from BOTH entries: its only import is
// `@typescript-eslint/types`, a devDependency, and this package ships ZERO runtime dependencies.
// Exporting it would break a consumer install, and no local test can catch that (devDeps are present
// here). `tst/node-native-entry.test.ts` guards what it can — that both entries load under plain node.

// ── building ────────────────────────────────────────────────────────────────────────────────────
export { bundle, createBuildContext } from './bundler/bundle.ts';
export type * from './bundler/bundle.ts';

// Types the build options and result are made of, defined in the modules that own them. These are
// reachable from `BundleOptions`/`BundleResult` already — naming them is what lets a consumer write
// down the type of something they are holding.
export type * from './bundler/graph-types.ts';
export type * from './bundler/output-options.ts';
export type * from './bundler/resolve.ts';
// A plugin that resolves modules ITSELF never runs shakeup's resolver, so it never gets the
// `package.json#sideEffects` verdict that resolution normally carries back — and a bundle built
// through such a plugin would silently ignore every manifest in `node_modules`. This is the one
// piece of the resolver a self-resolving plugin cannot do without, so it is named here.
export { packageSideEffectsFor } from './bundler/node-resolve.ts';
export type * from './bundler/treeshake.ts';
export type * from './bundler/generate/context.ts';
export type * from './util/sourcemap.ts';

// ── the filesystem a build reads through ────────────────────────────────────────────────────────
// `createMemoryFs` only: the path helpers beside it (`joinPath`, `normalizePath`, …) are internal
// plumbing, and `shakeup/node` supplies the real-filesystem implementation.
export { createMemoryFs } from './bundler/fs.ts';
export type * from './bundler/fs.ts';

// ── plugins ─────────────────────────────────────────────────────────────────────────────────────
// The hook RUNNERS (`runLoad`, `runTransform`, `runResolveId`, …) stay internal — they are how the
// bundler drives a plugin, not something a plugin author calls.
export { asset } from './bundler/plugins/asset.ts';
export { css } from './bundler/plugins/css.ts';
export { json } from './bundler/plugins/json.ts';
export { worker } from './bundler/plugins/worker.ts';
export type * from './bundler/plugin.ts';
export type * from './bundler/plugins/asset.ts';
export type * from './bundler/plugins/css.ts';
export type * from './bundler/plugins/worker.ts';

// ── dev: transform, server, runner, environments ────────────────────────────────────────────────
// This is the surface the makecat integration needs (replacing rolldown + vite-module-runner), which
// is why it is public while the pipeline stages behind it are not.
export { devTransform } from './bundler/transform.ts';
export type * from './bundler/transform.ts';
export { createDevServer, watch } from './bundler/runtime/dev-server.ts';
export type * from './bundler/runtime/dev-server.ts';
export { createModuleRunner, defaultEvaluator } from './bundler/runtime/module-runner.ts';
export type * from './bundler/runtime/module-runner.ts';
export { createEnvironment } from './bundler/runtime/environment.ts';
export type * from './bundler/runtime/environment.ts';
export { attachEnvironment, connectEnvironment, createEnvironmentBridge } from './bundler/runtime/transport.ts';
export type * from './bundler/runtime/transport.ts';
export type * from './bundler/watch.ts';
