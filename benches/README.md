# shakeup benches

Performance benchmarks powered by [`@pmndrs/labs`](https://github.com/pmndrs/labs) — statistically
rigorous benchmarking (Mann-Whitney U, Cliff's delta, adaptive sampling) with baseline comparison.
A run only reports a change when it is statistically significant *and* the effect size is
meaningful, so results survive a noisy machine.

Benches import directly from `../src`, so there is no build step. The module graphs are synthesised
in memory (`_graph.ts`), so runs are self-contained and deterministic — no disk, no fixtures.

## Usage

Run from the repo root:

```sh
pnpm bench                # run all benches, save results with auto timestamp
pnpm bench "incremental"  # filter by file/bench name
pnpm bench "@bundle"      # filter by tag (@parse, @bundle, @full, @incremental)
pnpm bench -n "v1" -b     # save with a name and set as baseline
pnpm bench compare        # compare latest run against the baseline
pnpm bench run            # run without saving
```

## Layout

- `parse/` — parser + analyzer throughput on a large single module (`@parse`)
- `bundle/full.bench.ts` — cold full builds across graph sizes (`@full`)
- `bundle/incremental.bench.ts` — the dev-loop metric: warm `BuildContext` rebuilding after one
  body-only edit, reusing the parse / link / tree-shake / render caches (`@incremental`)

Prefer the larger graph sizes (300, 600) for regression comparisons — they run well above this
machine's micro-bench noise floor. Use the small sizes to localise a regression once one shows up.

## Writing a bench

Benches use a generator: code before `yield` is setup, the yielded function is measured, code after
is teardown. Chain `.gc('inner')` to force GC between samples.

```ts
import { bench, group } from '@pmndrs/labs';

group('my group @mytag', () => {
  bench('my bench', function* () {
    // setup
    yield () => {
      // measured
    };
    // teardown
  });
});
```

Results are saved to `.labs/` (gitignored).
