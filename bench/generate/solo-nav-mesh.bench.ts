import { bench, group } from '@pmndrs/labs';
import { generateSoloNavMesh } from '../../blocks/generators/generate-solo-nav-mesh';
import {
    BuildContext,
    type BuildContextState,
    buildCompactHeightfield,
    buildDistanceField,
    buildPolyMeshDetail,
    buildRegions,
    type CompactHeightfield,
    erodeWalkableArea,
    type Heightfield,
    markWalkableTriangles,
    rasterizeTriangles,
} from '../../src';
import {
    buildCompact,
    buildContourSet,
    buildEroded,
    buildPolys,
    buildWithDistanceField,
    buildWithRegions,
    createEmptyHeightfield,
    defaultOptions,
    filterHeightfield,
    loadNavTestInput,
    markTriangles,
    rasterize,
} from '../fixtures/nav-test';

// Solo navmesh generation, broken into the same stages as generateSoloNavMesh
// (blocks/generators/generate-solo-nav-mesh.ts), measured on the nav-test mesh.
//
// Each bench isolates one stage: setup builds the intermediate state up to that
// stage, the measured function runs only the stage.
//
// Stages that mutate the compact heightfield in place (erode / distance field /
// regions) need a fresh copy each iteration. Instead of cloning inside the timed
// function, they yield `{ 0: factory, bench }`: labs calls the numbered arg
// factories *outside* the timed window each sample, so the structuredClone reset
// is not counted — only the stage itself is measured.
group('solo navmesh generation — nav-test @generate', () => {
    bench('mark walkable triangles', function* () {
        const input = loadNavTestInput();
        const triAreaIds = new Uint8Array(input.indices.length / 3);

        yield () => {
            markWalkableTriangles(input.positions, input.indices, triAreaIds, defaultOptions.walkableSlopeAngleDegrees);
        };
    }).gc(true);

    bench('rasterize triangles', function* () {
        const input = loadNavTestInput();
        const triAreaIds = markTriangles(input);

        // fresh empty heightfield + context each sample (untimed) — rasterizeTriangles
        // accumulates spans, so it must start from an empty field every run.
        yield {
            0: () => createEmptyHeightfield(input),
            1: () => BuildContext.create(),
            bench: (heightfield: Heightfield, ctx: BuildContextState) => {
                rasterizeTriangles(
                    ctx,
                    heightfield,
                    input.positions,
                    input.indices,
                    triAreaIds,
                    defaultOptions.walkableClimbVoxels,
                );
            },
        };
    }).gc(true);

    bench('filter walkable surfaces', function* () {
        const input = loadNavTestInput();
        const pristine = rasterize(BuildContext.create(), input, markTriangles(input));

        yield {
            0: () => structuredClone(pristine),
            bench: (heightfield: Heightfield) => {
                filterHeightfield(heightfield);
            },
        };
    }).gc(true);

    bench('build compact heightfield', function* () {
        const input = loadNavTestInput();
        const triAreaIds = new Uint8Array(input.indices.length / 3);
        markWalkableTriangles(input.positions, input.indices, triAreaIds, defaultOptions.walkableSlopeAngleDegrees);
        const heightfield = rasterize(BuildContext.create(), input, triAreaIds);
        filterHeightfield(heightfield);

        yield () => {
            const ctx = BuildContext.create();
            return buildCompactHeightfield(
                ctx,
                defaultOptions.walkableHeightVoxels,
                defaultOptions.walkableClimbVoxels,
                heightfield,
            );
        };
    }).gc(true);

    bench('erode walkable area', function* () {
        const input = loadNavTestInput();
        const pristine = buildCompact(BuildContext.create(), input);

        yield {
            0: () => structuredClone(pristine),
            bench: (chf: CompactHeightfield) => {
                erodeWalkableArea(defaultOptions.walkableRadiusVoxels, chf);
            },
        };
    }).gc(true);

    bench('build distance field', function* () {
        const input = loadNavTestInput();
        const pristine = buildEroded(BuildContext.create(), input);

        yield {
            0: () => structuredClone(pristine),
            bench: (chf: CompactHeightfield) => {
                buildDistanceField(chf);
            },
        };
    }).gc(true);

    bench('build regions', function* () {
        const input = loadNavTestInput();
        const pristine = buildWithDistanceField(BuildContext.create(), input);

        yield {
            0: () => structuredClone(pristine),
            bench: (chf: CompactHeightfield) => {
                const ctx = BuildContext.create();
                buildRegions(ctx, chf, defaultOptions.borderSize, defaultOptions.minRegionArea, defaultOptions.mergeRegionArea);
            },
        };
    }).gc(true);

    bench('trace + simplify contours', function* () {
        const input = loadNavTestInput();
        const chf = buildWithRegions(BuildContext.create(), input);

        yield () => {
            const ctx = BuildContext.create();
            return buildContourSet(ctx, chf);
        };
    }).gc(true);

    bench('build poly mesh', function* () {
        const input = loadNavTestInput();
        const chf = buildWithRegions(BuildContext.create(), input);
        const contourSet = buildContourSet(BuildContext.create(), chf);

        yield () => {
            const ctx = BuildContext.create();
            return buildPolys(ctx, contourSet);
        };
    }).gc(true);

    bench('build poly mesh detail', function* () {
        const input = loadNavTestInput();
        const chf = buildWithRegions(BuildContext.create(), input);
        const contourSet = buildContourSet(BuildContext.create(), chf);
        const polyMesh = buildPolys(BuildContext.create(), contourSet);

        yield () => {
            const ctx = BuildContext.create();
            return buildPolyMeshDetail(
                ctx,
                polyMesh,
                chf,
                defaultOptions.detailSampleDistance,
                defaultOptions.detailSampleMaxError,
            );
        };
    }).gc(true);
});

// Full end-to-end generation — the headline regression sentinel. Runs well above
// the micro-stage noise floor; use the per-stage benches above to localise a
// regression once this one moves.
group('solo navmesh generation — full pipeline @generate', () => {
    bench('generateSoloNavMesh (nav-test)', function* () {
        const input = loadNavTestInput();

        yield () => {
            return generateSoloNavMesh(input, defaultOptions);
        };
    }).gc(true);
});
