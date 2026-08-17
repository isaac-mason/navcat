import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vec2 } from 'math';
import { box3 } from 'math/shapes';
import {
    type BuildContextState,
    buildCompactHeightfield,
    buildContours,
    buildDistanceField,
    buildRegions,
    calculateGridSize,
    calculateMeshBounds,
    type CompactHeightfield,
    ContourBuildFlags,
    type ContourSet,
    createHeightfield,
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    type Heightfield,
    markWalkableTriangles,
    type PolyMesh,
    buildPolyMesh,
    WALKABLE_AREA,
    rasterizeTriangles,
} from '../../src';
import type { SoloNavMeshOptions } from '../../blocks/generators/generate-solo-nav-mesh';

// The nav-test mesh used across the examples (examples/public/models/nav-test.glb),
// extracted to a plain positions/indices fixture so benches need no glTF loader.

type NavTestFixture = {
    vertexCount: number;
    triangleCount: number;
    positions: number[];
    indices: number[];
};

const fixturePath = fileURLToPath(new URL('./nav-test.json', import.meta.url));
const fixture: NavTestFixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

export type NavTestInput = {
    positions: Float32Array;
    indices: Uint32Array;
};

export function loadNavTestInput(): NavTestInput {
    return {
        positions: new Float32Array(fixture.positions),
        indices: new Uint32Array(fixture.indices),
    };
}

// World-space config mirrors examples/src/example-solo-navmesh.ts; voxel counts are
// derived the same way so the fixture matches what the examples generate.
const config = {
    cellSize: 0.15,
    cellHeight: 0.15,
    walkableRadiusWorld: 0.1,
    walkableClimbWorld: 0.5,
    walkableHeightWorld: 0.25,
    walkableSlopeAngleDegrees: 45,
    borderSize: 0,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxSimplificationError: 1.3,
    maxEdgeLength: 12,
    maxVerticesPerPoly: 5,
    detailSampleDistance: 6,
    detailSampleMaxError: 1,
};

export const defaultOptions: SoloNavMeshOptions = {
    cellSize: config.cellSize,
    cellHeight: config.cellHeight,
    walkableRadiusWorld: config.walkableRadiusWorld,
    walkableRadiusVoxels: Math.ceil(config.walkableRadiusWorld / config.cellSize),
    walkableClimbWorld: config.walkableClimbWorld,
    walkableClimbVoxels: Math.ceil(config.walkableClimbWorld / config.cellHeight),
    walkableHeightWorld: config.walkableHeightWorld,
    walkableHeightVoxels: Math.ceil(config.walkableHeightWorld / config.cellHeight),
    walkableSlopeAngleDegrees: config.walkableSlopeAngleDegrees,
    borderSize: config.borderSize,
    minRegionArea: config.minRegionArea,
    mergeRegionArea: config.mergeRegionArea,
    maxSimplificationError: config.maxSimplificationError,
    maxEdgeLength: config.maxEdgeLength,
    maxVerticesPerPoly: config.maxVerticesPerPoly,
    detailSampleDistance: config.detailSampleDistance < 0.9 ? 0 : config.cellSize * config.detailSampleDistance,
    detailSampleMaxError: config.cellHeight * config.detailSampleMaxError,
};

/* ------------------------------------------------------------------ *
 * Pipeline stage builders — each returns freshly-built intermediate
 * state up to (and including) a given generation stage. Benches use
 * these in setup to prepare the input for the stage they measure.
 * ------------------------------------------------------------------ */

export function markTriangles(input: NavTestInput, options = defaultOptions): Uint8Array {
    const triAreaIds = new Uint8Array(input.indices.length / 3).fill(0);
    markWalkableTriangles(input.positions, input.indices, triAreaIds, options.walkableSlopeAngleDegrees);
    return triAreaIds;
}

/** empty heightfield sized to the input mesh, ready to rasterize into. */
export function createEmptyHeightfield(input: NavTestInput, options = defaultOptions): Heightfield {
    const bounds = calculateMeshBounds(box3.create(), input.positions, input.indices);
    const [w, h] = calculateGridSize(vec2.create(), bounds, options.cellSize);
    return createHeightfield(w, h, bounds, options.cellSize, options.cellHeight);
}

export function rasterize(
    ctx: BuildContextState,
    input: NavTestInput,
    triAreaIds: Uint8Array,
    options = defaultOptions,
): Heightfield {
    const heightfield = createEmptyHeightfield(input, options);
    rasterizeTriangles(ctx, heightfield, input.positions, input.indices, triAreaIds, options.walkableClimbVoxels);
    return heightfield;
}

export function filterHeightfield(heightfield: Heightfield, options = defaultOptions): void {
    filterLowHangingWalkableObstacles(heightfield, options.walkableClimbVoxels);
    filterLedgeSpans(heightfield, options.walkableHeightVoxels, options.walkableClimbVoxels);
    filterWalkableLowHeightSpans(heightfield, options.walkableHeightVoxels);
}

/** compact heightfield straight out of buildCompactHeightfield (pre-erode). */
export function buildCompact(ctx: BuildContextState, input: NavTestInput, options = defaultOptions): CompactHeightfield {
    const triAreaIds = markTriangles(input, options);
    const heightfield = rasterize(ctx, input, triAreaIds, options);
    filterHeightfield(heightfield, options);
    return buildCompactHeightfield(ctx, options.walkableHeightVoxels, options.walkableClimbVoxels, heightfield);
}

/** compact heightfield after erosion (pre-distance-field). */
export function buildEroded(ctx: BuildContextState, input: NavTestInput, options = defaultOptions): CompactHeightfield {
    const chf = buildCompact(ctx, input, options);
    erodeWalkableArea(options.walkableRadiusVoxels, chf);
    return chf;
}

/** compact heightfield after the distance field (pre-regions). */
export function buildWithDistanceField(
    ctx: BuildContextState,
    input: NavTestInput,
    options = defaultOptions,
): CompactHeightfield {
    const chf = buildEroded(ctx, input, options);
    buildDistanceField(chf);
    return chf;
}

/** compact heightfield after region partitioning (ready for contours). */
export function buildWithRegions(ctx: BuildContextState, input: NavTestInput, options = defaultOptions): CompactHeightfield {
    const chf = buildWithDistanceField(ctx, input, options);
    buildRegions(ctx, chf, options.borderSize, options.minRegionArea, options.mergeRegionArea);
    return chf;
}

export function buildContourSet(ctx: BuildContextState, chf: CompactHeightfield, options = defaultOptions): ContourSet {
    return buildContours(
        ctx,
        chf,
        options.maxSimplificationError,
        options.maxEdgeLength,
        ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
    );
}

export function buildPolys(ctx: BuildContextState, contourSet: ContourSet, options = defaultOptions): PolyMesh {
    const polyMesh = buildPolyMesh(ctx, contourSet, options.maxVerticesPerPoly);
    for (let i = 0; i < polyMesh.nPolys; i++) {
        if (polyMesh.areas[i] === WALKABLE_AREA) polyMesh.areas[i] = 0;
        if (polyMesh.areas[i] === 0) polyMesh.flags[i] = 1;
    }
    return polyMesh;
}
