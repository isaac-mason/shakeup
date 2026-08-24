import { bench, group } from '@pmndrs/labs';
import { bundle } from '../../src/bundle';
import { makeDeepModule, makeGraph } from '../_graph';

// The MINIFY tier had no bench coverage at all: `makeGraph().opts()` passes no `output`, so every
// existing bundle bench measured parse/link/tree-shake/render with compress and mangle switched off.
// That is the tier the compress fixed point lives in — the one whose cost is dominated by how many
// whole-program walks each iteration performs — so every perf claim about it was previously made from
// ad-hoc timing scripts rather than from labs' sampling. It isn't any more.
//
// The three variants separate the tiers, so a regression lands on a specific one instead of on "minify":
//   plain    — no minify at all, the existing baseline shape (parse/link/render only)
//   minify   — compress + mangle, `optimize` at its default
//   no-opt   — compress + mangle with the Closure-derived optimize tier off, isolating its share
group('minify @bundle @minify', () => {
    for (const N of [100, 300]) {
        bench(`plain build ${N} modules`, function* () {
            const g = makeGraph(N);
            yield async () => {
                await bundle(g.opts());
            };
        });

        bench(`minified build ${N} modules`, function* () {
            const g = makeGraph(N);
            yield async () => {
                await bundle({ ...g.opts(), output: { minify: true } });
            };
        });

        bench(`minified, optimize off, ${N} modules`, function* () {
            const g = makeGraph(N);
            yield async () => {
                await bundle({ ...g.opts(), output: { minify: true, optimize: false } });
            };
        });
    }
});

// Statement-list DEPTH, the axis `makeGraph` cannot express (see `makeDeepModule`). Without this the
// suite is blind to anything superlinear in statement-list length — which is where the compress
// statement-list passes (inline, join-vars, dead-code, remove-unused-expr) all do their work.
group('minify deep @bundle @minify @deep', () => {
    for (const [fns, stmts] of [[4, 150], [4, 400]] as const) {
        bench(`minified, ${fns} fns x ${stmts} stmts`, function* () {
            const g = makeDeepModule(fns, stmts);
            yield async () => {
                await bundle({ ...g.opts(), output: { minify: true } });
            };
        });
    }
});
