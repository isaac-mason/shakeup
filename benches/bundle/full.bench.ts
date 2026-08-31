import { bench, group } from '@pmndrs/labs';
import { bundle } from '../../src/bundler/bundle.ts';
import { makeGraph } from '../_graph.ts';

group('full build @bundle @full', () => {
    for (const N of [100, 300, 600]) {
        bench(`cold build ${N} modules`, function* () {
            const g = makeGraph(N);
            yield async () => {
                await bundle(g.opts());
            };
        });
    }
});
