import { describe, expect, it } from 'vitest';
import * as ast from '../src/ast.ts';
import * as api from '../src/index.ts';

// THE PUBLIC SURFACE, PINNED.
//
// `src/index.ts` was 25 bare `export *` lines producing 148 runtime values — nothing had been chosen,
// so `buildGraph`, `linkGraph`, `retireSymbol` and `packRef` were all package API and every internal
// rename was a breaking change. The lists below are the curated replacement.
//
// This test is deliberately BRITTLE: adding an export makes it fail. That is the feature. A public
// surface should only grow on purpose, and the diff that grows it should say so out loud. Update the
// list in the same commit that adds the export — never the other way round.
//
// Types are NOT pinned here and are exported liberally (`export type *`), because a type only
// describes what a value already accepts or returns. Values are the commitment; this guards those.

const BUNDLER = [
    'asset', 'attachEnvironment', 'bundle', 'connectEnvironment', 'createBuildContext', 'createDevServer',
    'createEnvironment', 'createEnvironmentBridge', 'createMemoryFs', 'createModuleRunner', 'css',
    'defaultEvaluator', 'devTransform', 'json', 'watch', 'worker',
].sort();

const TOOLCHAIN = [
    'CHILD_FIELDS', 'DEFS', 'FL', 'N', 'NODE_TYPE_NAMES', 'OP', 'SCOPE', 'SPAN', 'SYM', 'TYPE_COUNT',
    'TYPE_NAME', 'VAR_KIND', 'analyze', 'assign', 'bigInt', 'binding', 'bool', 'boundBinding', 'boundRef',
    'cloneNode', 'computed', 'create', 'createScope', 'createSemantic', 'emptyObject', 'exprStmt', 'idName',
    'isIdentifier', 'isJSXNode', 'isPureExpr', 'isPureStatement', 'isTypeOnlyNode', 'jsxIdent', 'jsxText',
    'labelId', 'lineColOf', 'lookupValue', 'mayHaveSideEffects', 'member', 'node', 'nullLit', 'num', 'parse',
    'parseWithDiagnostics', 'privateName', 'ref', 'regExp', 'scopeOf', 'set', 'statementListOf', 'str',
    'symbolName', 'symbolOf', 'templateElement', 'void0', 'walk', 'walkChildren', 'walkRefIdents',
].sort();

describe('the published surface is what we chose', () => {
    it('shakeup exports exactly the bundler API', () => {
        expect(Object.keys(api).sort()).toEqual(BUNDLER);
    });

    it('shakeup/ast exports exactly the toolchain API', () => {
        expect(Object.keys(ast).sort()).toEqual(TOOLCHAIN);
    });
});

describe('internals stay internal', () => {
    // Named individually rather than counted: these are the specific things that WERE public and are
    // the ones a careless `export *` would put back. A count alone would not say which leaked.
    const surface = new Set([...Object.keys(api), ...Object.keys(ast)]);

    it.each([
        ['pipeline stages', ['buildGraph', 'linkGraph', 'deconflictChunk', 'deconflictWholeBundle', 'treeshake']],
        ['plugin hook runners', ['runLoad', 'runTransform', 'runResolveId', 'runModuleParsed', 'compilePipeline']],
        ['Semantic mutators', ['retireSymbol', 'declareLocal', 'declareSyntheticImport', 'attachScopeNode', 'refFor']],
        ['node-id allocation', ['allocId', 'peekNextId']],
        ['symbol packing', ['packRef', 'refMod', 'refSym']],
        ['sourcemap builders', ['addSegment', 'encodeMappings', 'newMappings', 'joinParts']],
        ['resolver internals', ['createNodeResolver', 'makeBaseResolve', 'normalizeResolve']],
    ])('%s are not exported', (_label, names) => {
        expect(names.filter((n) => surface.has(n))).toEqual([]);
    });

    it('the ESTree projection is absent — it imports a devDependency', () => {
        // The package has ZERO runtime dependencies. `ast/estree.ts` imports `@typescript-eslint/types`,
        // so exporting it would break a consumer install — and no local test could catch that, because
        // devDeps are installed here. This is the only guard.
        expect(surface.has('astToEstree')).toBe(false);
    });
});
