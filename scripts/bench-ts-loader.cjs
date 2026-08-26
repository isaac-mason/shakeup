// Minimal TypeScript loader for the webpack arm of `pnpm standing`. webpack needs a loader FILE
// (a path it can require), so this cannot be inline like rollup's plugin. esbuild's transform is
// used so the TS-stripping cost is identical to what the rollup arm pays.
const { transformSync } = require('esbuild');
module.exports = function tsLoader(source) {
    return transformSync(source, { loader: this.resourcePath.endsWith('.tsx') ? 'tsx' : 'ts' }).code;
};
