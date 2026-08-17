import { bench, group } from '@pmndrs/labs';
import { createBuildContext } from '../../src/bundle';
import { makeGraph } from '../_graph';

// The dev-loop metric: a warm BuildContext rebuilding after a single body-only edit. The graph is
// primed once in setup; each measured iteration edits one module and rebuilds, reusing the parse,
// link, tree-shake and render caches for everything else.
group('incremental rebuild @bundle @incremental', () => {
    for (const N of [100, 300, 600]) {
        bench(`rebuild after 1 body edit, ${N} modules`, function* () {
            const g = makeGraph(N);
            const ctx = createBuildContext(g.opts());
            ctx.rebuild();
            let v = 0;
            yield () => {
                g.editBody(N >> 1, v++);
                ctx.rebuild();
            };
        });
    }
});
