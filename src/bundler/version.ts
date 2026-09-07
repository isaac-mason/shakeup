/** shakeup's own version, reported to plugins as `this.meta.shakeupVersion`.
 *
 *  A CONSTANT rather than a read of `package.json`: this module is bundled into browser builds,
 *  where there is no `package.json` to read and no build step to inject one. `tst/version.test.ts`
 *  asserts it matches the manifest, so the duplication cannot drift silently.
 *
 *  Under `bundler/` rather than at the top of `src/`: `tst/toolchain-boundary.test.ts` holds that
 *  top-level `src/*.ts` files are package ENTRY POINTS by construction, and this is not one. Its
 *  only consumer is the plugin context's `this.meta`. */
export const VERSION = '0.0.0';
