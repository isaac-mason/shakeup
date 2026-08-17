import { bench, group } from '@pmndrs/labs';
import { createBuildContext } from '../../src/bundle';
import { makeGraph } from '../_graph';

// The dev-loop metric: a warm BuildContext rebuilding after a single body-only edit. The graph is
// primed once in setup; each measured iteration edits one module and rebuilds, reusing the parse,
// link, tree-shake and render caches for everything else.
group('incremental rebuild @bundle @incremental', () => {
    for (const N of [100, 300, 600]) {
        // Auto-detect: rebuild() hashes every module to find the change.
        bench(`auto-detect rebuild after 1 body edit, ${N} modules`, async function* () {
            const g = makeGraph(N);
            const ctx = createBuildContext(g.opts());
            await ctx.rebuild();
            let v = 0;
            yield async () => {
                g.editBody(N >> 1, v++);
                await ctx.rebuild();
            };
        });

        // Signal mode: the Watcher tells us exactly what changed, so unchanged modules skip
        // load+transform+hash+parse entirely (resolution still runs).
        bench(`signal-mode rebuild after 1 body edit, ${N} modules`, async function* () {
            const g = makeGraph(N);
            const ctx = createBuildContext(g.opts());
            await ctx.rebuild();
            const id = `/m${N >> 1}.ts`;
            let v = 0;
            yield async () => {
                g.editBody(N >> 1, v++);
                await ctx.rebuild([{ kind: 'update', id }]);
            };
        });
    }
});
