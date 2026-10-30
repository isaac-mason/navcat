# navcat benches

Performance benchmarks powered by [`@pmndrs/labs`](https://github.com/pmndrs/labs) — statistically rigorous benchmarking (Mann-Whitney U, Cliff's delta, adaptive sampling) with baseline comparison.

Benches import directly from `../src` and `../blocks`, so no build step is needed.

## Usage

Run from the repo root:

```sh
pnpm bench                 # run all benches, save results with auto timestamp
pnpm bench "findPath"      # filter by file/bench name
pnpm bench "@generate"     # filter by tag (@generate, @query)
pnpm bench -n "v0.4.1" -b  # save with a name and set as baseline
pnpm bench compare         # compare latest run against the baseline
pnpm bench run             # run without saving
```

## Layout

Benches are split into the two halves of the navigation pipeline:

- `generate/` — navmesh generation (`@generate`), broken into the same stages as
  `generateSoloNavMesh` (`blocks/generators/generate-solo-nav-mesh.ts`), plus a full
  end-to-end bench.
- `query/` — navmesh queries (`@query`), starting with `findPath`.

All benches run on the **nav-test** mesh used across the examples
(`examples/public/models/nav-test.glb`), extracted to `fixtures/nav-test.json` so
benches need no glTF loader. `fixtures/nav-test.ts` loads it, derives the same
options the examples use, and exposes helpers that build each intermediate stage.

## Generation stages

Each generation stage is benchmarked in isolation: setup builds the intermediate
state up to that stage, and the measured function runs only that stage.

The `full pipeline` bench (`generateSoloNavMesh`) is the headline regression
sentinel — it runs well above the per-stage noise floor. Use the per-stage benches
to localise a regression once the full bench moves.

A few stages (`erode` / `build distance field` / `build regions`) mutate the
compact heightfield in place and so need a fresh copy each iteration. To keep the
reset out of the timing, they yield an object with a numbered **arg factory**
instead of a plain function:

```ts
yield {
  0: () => structuredClone(pristine), // run untimed before each sample
  bench: (chf) => erodeWalkableArea(radius, chf), // measured
};
```

labs calls the numbered factories outside the timed window each sample, so the
`structuredClone` reset is never counted — only the stage itself is measured.

## Writing a bench

Benches use a generator: code before `yield` is setup, the yielded function is
measured, code after is teardown. Chain `.gc(true)` to force GC between samples.

```ts
import { bench, group } from '@pmndrs/labs';

group('my group @mytag', () => {
  bench('my bench', function* () {
    // setup
    yield () => {
      // measured
    };
    // teardown
  }).gc(true);
});
```

Results are saved to `.labs/` (gitignored). Comparisons only report a change when
it is statistically significant and the effect size is meaningful — see the labs
README for details.
