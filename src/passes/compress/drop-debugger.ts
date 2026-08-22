// B1 — drop `debugger` statements (esbuild `minifySyntax`, terser `drop_debugger`). A `debugger`
// is a no-op without devtools attached, so removing it is always safe + behavior-preserving.
import { N } from '../../ast.ts';
import { hookTable, type Visitor } from '../traverse.ts';

export const dropDebugger: Visitor = {
    name: 'dropDebugger',
    enter: hookTable({
        [N.DebuggerStatement]: (_node, ctx) => {
            ctx.remove();
        },
    }),
    exit: null,
};
