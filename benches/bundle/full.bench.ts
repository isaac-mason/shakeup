import { bench, group } from '@pmndrs/labs';
import { bundle } from '../../src/bundle';
import { makeGraph } from '../_graph';

group('full build @bundle @full', () => {
    for (const N of [100, 300, 600]) {
        bench(`cold build ${N} modules`, function* () {
            const g = makeGraph(N);
            yield () => {
                bundle(g.opts());
            };
        });
    }
});
