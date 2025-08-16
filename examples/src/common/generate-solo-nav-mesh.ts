import { box3, vec2, vec3 } from 'maaths';
import {
    addTile,
    buildCompactHeightfield,
    BuildContext,
    buildContours,
    buildDistanceField,
    buildNavMeshBvTree,
    buildPolyMesh,
    buildPolyMeshDetail,
    buildRegions,
    calculateGridSize,
    calculateMeshBounds,
    type CompactHeightfield,
    ContourBuildFlags,
    type ContourSet,
    createHeightfield,
    createNavMesh,
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    type Heightfield,
    markWalkableTriangles,
    type NavMesh,
    type NavMeshTile,
    type PolyMesh,
    type PolyMeshDetail,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    rasterizeTriangles,
    WALKABLE_AREA,
} from 'nav3d';

export type SoloNavMeshInput = {
    positions: Float32Array;
    indices: Uint32Array;
};

export type SoloNavMeshOptions = {
    cellSize: number;
    cellHeight: number;
    walkableRadiusVoxels: number;
    walkableRadiusWorld: number;
    walkableClimbVoxels: number;
    walkableClimbWorld: number;
    walkableHeightVoxels: number;
    walkableHeightWorld: number;
    walkableSlopeAngleDegrees: number;
    borderSize: number;
    minRegionArea: number;
    mergeRegionArea: number;
    maxSimplificationError: number;
    maxEdgeLength: number;
    maxVerticesPerPoly: number;
    detailSampleDistance: number;
    detailSampleMaxError: number;
};

export type SoloNavMeshIntermediates = {
    input: SoloNavMeshInput;
    triAreaIds: Uint8Array;
    heightfield: Heightfield;
    compactHeightfield: CompactHeightfield;
    contourSet: ContourSet;
    polyMesh: PolyMesh;
    polyMeshDetail: PolyMeshDetail;
};

export type SoloNavMeshResult = {
    navMesh: NavMesh;
    intermediates: SoloNavMeshIntermediates;
};

export function generateSoloNavMesh(
    input: SoloNavMeshInput,
    options: SoloNavMeshOptions,
): SoloNavMeshResult {
    console.time('navmesh generation');

    const { positions, indices } = input;

    /* 0. define generation parameters */
    const {
        cellSize,
        cellHeight,
        walkableRadiusVoxels,
        walkableRadiusWorld,
        walkableClimbVoxels,
        walkableClimbWorld,
        walkableHeightVoxels,
        walkableHeightWorld,
        walkableSlopeAngleDegrees,
        borderSize,
        minRegionArea,
        mergeRegionArea,
        maxSimplificationError,
        maxEdgeLength,
        maxVerticesPerPoly,
        detailSampleDistance,
        detailSampleMaxError,
    } = options;

    const ctx = BuildContext.create();

    /* 1. input positions and indices are already provided */

    console.time('mark walkable triangles');

    /* 2. mark walkable triangles */
    const triAreaIds = new Uint8Array(indices.length / 3).fill(0);
    markWalkableTriangles(
        positions,
        indices,
        triAreaIds,
        walkableSlopeAngleDegrees,
    );

    console.timeEnd('mark walkable triangles');

    /* 3. rasterize the triangles to a voxel heightfield */

    console.time('rasterize triangles');

    const bounds = calculateMeshBounds(box3.create(), positions, indices);
    const [heightfieldWidth, heightfieldHeight] = calculateGridSize(
        vec2.create(),
        bounds,
        cellSize,
    );

    const heightfield = createHeightfield(
        heightfieldWidth,
        heightfieldHeight,
        bounds,
        cellSize,
        cellHeight,
    );

    rasterizeTriangles(
        ctx,
        heightfield,
        positions,
        indices,
        triAreaIds,
        walkableClimbVoxels,
    );

    console.timeEnd('rasterize triangles');

    /* 4. filter walkable surfaces */

    // Once all geoemtry is rasterized, we do initial pass of filtering to
    // remove unwanted overhangs caused by the conservative rasterization
    // as well as filter spans where the character cannot possibly stand.

    console.time('filter walkable surfaces');

    filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
    filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
    filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

    console.timeEnd('filter walkable surfaces');

    /* 5. partition walkable surface to simple regions. */

    // Compact the heightfield so that it is faster to handle from now on.
    // This will result more cache coherent data as well as the neighbours
    // between walkable cells will be calculated.

    console.time('build compact heightfield');

    const compactHeightfield = buildCompactHeightfield(
        walkableHeightVoxels,
        walkableClimbVoxels,
        heightfield,
    );

    console.timeEnd('build compact heightfield');

    /* 6. erode the walkable area by the agent radius / walkable radius */

    console.time('erode walkable area');

    erodeWalkableArea(walkableRadiusVoxels, compactHeightfield);

    console.timeEnd('erode walkable area');

    /* 7. prepare for region partitioning by calculating a distance field along the walkable surface */

    console.time('build compact heightfield distance field');

    buildDistanceField(compactHeightfield);

    console.timeEnd('build compact heightfield distance field');

    /* 8. partition the walkable surface into simple regions without holes */

    console.time('build compact heightfield regions');

    // Partition the heightfield so that we can use simple algorithm later to triangulate the walkable areas.
    // There are 3 partitioning methods, each with some pros and cons:
    // 1) Watershed partitioning
    //   - the classic Recast partitioning
    //   - creates the nicest tessellation
    //   - usually slowest
    //   - partitions the heightfield into nice regions without holes or overlaps
    //   - the are some corner cases where this method creates produces holes and overlaps
    //      - holes may appear when a small obstacles is close to large open area (triangulation can handle this)
    //      - overlaps may occur if you have narrow spiral corridors (i.e stairs), this make triangulation to fail
    //   * generally the best choice if you precompute the navmesh, use this if you have large open areas
    // 2) Monotone partitioning
    //   - fastest
    //   - partitions the heightfield into regions without holes and overlaps (guaranteed)
    //   - creates long thin polygons, which sometimes causes paths with detours
    //   * use this if you want fast navmesh generation
    // 3) Layer partitoining
    //   - quite fast
    //   - partitions the heighfield into non-overlapping regions
    //   - relies on the triangulation code to cope with holes (thus slower than monotone partitioning)
    //   - produces better triangles than monotone partitioning
    //   - does not have the corner cases of watershed partitioning
    //   - can be slow and create a bit ugly tessellation (still better than monotone)
    //     if you have large open areas with small obstacles (not a problem if you use tiles)
    //   * good choice to use for tiled navmesh with medium and small sized tiles

    buildRegions(
        ctx,
        compactHeightfield,
        borderSize,
        minRegionArea,
        mergeRegionArea,
    );
    // buildRegionsMonotone(compactHeightfield, borderSize, minRegionArea, mergeRegionArea);
    // buildLayerRegions(compactHeightfield, borderSize, minRegionArea);

    console.timeEnd('build compact heightfield regions');

    /* 9. trace and simplify region contours */

    console.time('trace and simplify region contours');

    const contourSet = buildContours(
        compactHeightfield,
        maxSimplificationError,
        maxEdgeLength,
        ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
    );

    console.timeEnd('trace and simplify region contours');

    /* 10. build polygons mesh from contours */

    console.time('build polygons mesh from contours');

    const polyMesh = buildPolyMesh(contourSet, maxVerticesPerPoly);

    for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
        if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
            polyMesh.areas[polyIndex] = 0;
        }

        if (polyMesh.areas[polyIndex] === 0) {
            polyMesh.flags[polyIndex] = 1;
        }
    }

    console.timeEnd('build polygons mesh from contours');

    /* 11. create detail mesh which allows to access approximate height on each polygon */

    console.time('build detail mesh from contours');

    const polyMeshDetail = buildPolyMeshDetail(
        ctx,
        polyMesh,
        compactHeightfield,
        detailSampleDistance,
        detailSampleMaxError,
    );

    console.timeEnd('build detail mesh from contours');

    console.timeEnd('navmesh generation');

    /* store intermediates for debugging */

    const intermediates: SoloNavMeshIntermediates = {
        input: {
            positions,
            indices,
        },
        triAreaIds,
        heightfield,
        compactHeightfield,
        contourSet,
        polyMesh,
        polyMeshDetail,
    };

    /* create a single tile nav mesh */

    const nav = createNavMesh();
    nav.tileWidth = polyMesh.bounds[1][0] - polyMesh.bounds[0][0];
    nav.tileHeight = polyMesh.bounds[1][2] - polyMesh.bounds[0][2];
    vec3.copy(nav.origin, polyMesh.bounds[0]);

    const tilePolys = polyMeshToTilePolys(polyMesh);

    const tileDetailMesh = polyMeshDetailToTileDetailMesh(
        tilePolys.polys,
        maxVerticesPerPoly,
        polyMeshDetail,
    );

    const tile: NavMeshTile = {
        id: -1,
        bounds: polyMesh.bounds,
        vertices: tilePolys.vertices,
        polys: tilePolys.polys,
        detailMeshes: tileDetailMesh.detailMeshes,
        detailVertices: tileDetailMesh.detailVertices,
        detailTriangles: tileDetailMesh.detailTriangles,
        tileX: 0,
        tileY: 0,
        tileLayer: 0,
        bvTree: null,
        cellSize,
        cellHeight,
        walkableHeight: walkableHeightWorld,
        walkableRadius: walkableRadiusWorld,
        walkableClimb: walkableClimbWorld,
    };

    buildNavMeshBvTree(tile);

    addTile(nav, tile);

    return {
        navMesh: nav,
        intermediates,
    };
}
