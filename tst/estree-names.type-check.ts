// Type-only: every name in `ESTREE_NAME` is a REAL `@typescript-eslint` AST node type. Compiled by
// `tsc --noEmit` (no `.test.ts` suffix, so vitest does not run it).
//
// This check used to live in `src/ast/estree.ts` as a `satisfies` clause. It cannot: shakeup ships
// raw TypeScript with zero runtime dependencies, so a consumer typechecking our sources resolves
// every import in them, and `@typescript-eslint/types` is a devDependency they do not have — TS2307.
// `src/ast.ts` already documents estree as withheld from both entries for that reason; the import
// inside the module was the same mistake one level down. Here it is legal, and the check is
// unchanged in strength.
import type { AST_NODE_TYPES } from '@typescript-eslint/types';
import type { TypeName } from '../src/ast/index.ts';
import { ESTREE_NAME } from '../src/ast/estree.ts';

const _names: Record<TypeName, `${AST_NODE_TYPES}` | null> = ESTREE_NAME;
export type _Names = typeof _names;
