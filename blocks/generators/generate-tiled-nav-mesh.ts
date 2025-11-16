import { type Box3, box3, vec2 } from 'mathcat';
import {
    addTile,
    BuildContext,
    type BuildContextState,
    buildCompactHeightfield,
    buildContours,
    buildDistanceField,
    buildPolyMesh,
    buildPolyMeshDetail,
    buildRegions,
    buildTile,
    type CompactHeightfield,
    ContourBuildFlags,
    type ContourSet,
    calculateGridSize,
    calculateMeshBounds,
    createHeightfield,
    createNavMesh,
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    type Heightfield,
    markWalkableTriangles,
    type NavMesh,
    type NavMeshTileParams,
    type PolyMesh,
    type PolyMeshDetail,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    rasterizeTriangles,
    WALKABLE_AREA,
} from 'navcat';
import * as chunkyTriMesh from '../geometry/chunky-tri-mesh';

export type TiledNavMeshInput = {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
};

export type TiledNavMeshOptions = {
    cellSize: number;
    cellHeight: number;
    tileSizeVoxels: number;
    tileSizeWorld: number;
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

export type TiledNavMeshIntermediates = {
    buildContext: BuildContextState;
    input: TiledNavMeshInput;
    inputBounds: Box3;
    chunkyTriMesh: chunkyTriMesh.ChunkyTriMesh;
    triAreaIds: Uint8Array[];
    heightfield: Heightfield[];
    compactHeightfield: CompactHeightfield[];
    contourSet: ContourSet[];
    polyMesh: PolyMesh[];
    polyMeshDetail: PolyMeshDetail[];
};

export type TiledNavMeshResult = {
    navMesh: NavMesh;
    intermediates: TiledNavMeshIntermediates;
};

const buildNavMeshTile = (
    ctx: BuildContextState,
    positions: ArrayLike<number>,
    inputChunkyTriMesh: chunkyTriMesh.ChunkyTriMesh,
    tileBounds: Box3,
    cellSize: number,
    cellHeight: number,
    borderSize: number,
    walkableSlopeAngleDegrees: number,
    walkableClimbVoxels: number,
    walkableHeightVoxels: number,
    walkableRadiusVoxels: number,
    tileSizeVoxels: number,
    minRegionArea: number,
    mergeRegionArea: number,
    maxSimplificationError: number,
    maxEdgeLength: number,
    maxVerticesPerPoly: number,
    detailSampleDistance: number,
    detailSampleMaxError: number,
) => {
    // Expand the heightfield bounding box by border size to find the extents of geometry we need to build this tile.
    //
    // This is done in order to make sure that the navmesh tiles connect correctly at the borders,
    // and the obstacles close to the border work correctly with the dilation process.
    // No polygons (or contours) will be created on the border area.
    //
    // IMPORTANT!
    //
    //   :''''''''':
    //   : +-----+ :
    //   : |     | :
    //   : |     |<--- tile to build
    //   : |     | :
    //   : +-----+ :<-- geometry needed
    //   :.........:
    //
    // You should use this bounding box to query your input geometry.
    //
    // For example if you build a navmesh for terrain, and want the navmesh tiles to match the terrain tile size
    // you will need to pass in data from neighbour terrain tiles too! In a simple case, just pass in all the 8 neighbours,
    // or use the bounding box below to only pass in a sliver of each of the 8 neighbours.

    /* 1. expand the tile bounds by the border size */

    const expandedTileBounds = box3.clone(tileBounds);

    expandedTileBounds[0][0] -= borderSize * cellSize;
    expandedTileBounds[0][2] -= borderSize * cellSize;

    expandedTileBounds[1][0] += borderSize * cellSize;
    expandedTileBounds[1][2] += borderSize * cellSize;

    /* 2. query chunks overlapping the tile bounds */

    const tbmin: [number, number] = [expandedTileBounds[0][0], expandedTileBounds[0][2]];
    const tbmax: [number, number] = [expandedTileBounds[1][0], expandedTileBounds[1][2]];

    const chunks = chunkyTriMesh.getChunksOverlappingRect(inputChunkyTriMesh, tbmin, tbmax);

    /* 3. create heightfield for rasterization */

    const heightfieldWidth = Math.floor(tileSizeVoxels + borderSize * 2);
    const heightfieldHeight = Math.floor(tileSizeVoxels + borderSize * 2);

    const heightfield = createHeightfield(heightfieldWidth, heightfieldHeight, expandedTileBounds, cellSize, cellHeight);

    /* 4. allocate triAreaIds for max chunk size (memory efficient!) */

    const triAreaIds = new Uint8Array(inputChunkyTriMesh.maxTrisPerChunk).fill(0);

    /* 5. rasterize triangles chunk by chunk */

    for (const chunkIndex of chunks) {
        const node = inputChunkyTriMesh.nodes[chunkIndex];
        const startIdx = node.index * 3;
        const triangleCount = node.count;

        // Get this chunk's triangles
        const chunkTriangles = inputChunkyTriMesh.triangles.slice(startIdx, startIdx + triangleCount * 3);

        // Reset and mark walkable triangles for this chunk
        triAreaIds.fill(0);
        markWalkableTriangles(positions, chunkTriangles, triAreaIds.subarray(0, triangleCount), walkableSlopeAngleDegrees);

        // Rasterize this chunk's triangles
        rasterizeTriangles(
            ctx,
            heightfield,
            positions,
            chunkTriangles,
            triAreaIds.subarray(0, triangleCount),
            walkableClimbVoxels,
        );
    }

    /* 6. filter walkable surfaces */

    filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
    filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
    filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

    /* 7. build the compact heightfield */

    const compactHeightfield = buildCompactHeightfield(ctx, walkableHeightVoxels, walkableClimbVoxels, heightfield);

    /* 8. erode the walkable area by the agent radius / walkable radius */

    erodeWalkableArea(walkableRadiusVoxels, compactHeightfield);

    /* 9. prepare for region partitioning by calculating a distance field along the walkable surface */

    buildDistanceField(compactHeightfield);

    /* 10. partition the walkable surface into simple regions without holes */

    buildRegions(ctx, compactHeightfield, borderSize, minRegionArea, mergeRegionArea);

    /* 11. trace and simplify region contours */

    const contourSet = buildContours(
        ctx,
        compactHeightfield,
        maxSimplificationError,
        maxEdgeLength,
        ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
    );

    /* 12. build polygons mesh from contours */

    const polyMesh = buildPolyMesh(ctx, contourSet, maxVerticesPerPoly);

    for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
        if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
            polyMesh.areas[polyIndex] = 0;
        }

        if (polyMesh.areas[polyIndex] === 0) {
            polyMesh.flags[polyIndex] = 1;
        }
    }

    /* 13. create detail mesh which allows to access approximate height on each polygon */

    const polyMeshDetail = buildPolyMeshDetail(ctx, polyMesh, compactHeightfield, detailSampleDistance, detailSampleMaxError);

    return {
        triAreaIds,
        expandedTileBounds,
        heightfield,
        compactHeightfield,
        contourSet,
        polyMesh,
        polyMeshDetail,
    };
};

export function generateTiledNavMesh(input: TiledNavMeshInput, options: TiledNavMeshOptions): TiledNavMeshResult {
    const { positions, indices } = input;

    /* 0. define generation parameters */
    const {
        cellSize,
        cellHeight,
        tileSizeVoxels,
        tileSizeWorld,
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

    /* 1. calculate mesh bounds and create tiled nav mesh */

    const meshBounds = calculateMeshBounds(box3.create(), positions, indices);
    const gridSize = calculateGridSize(vec2.create(), meshBounds, cellSize);

    const nav = createNavMesh();
    nav.tileWidth = tileSizeWorld;
    nav.tileHeight = tileSizeWorld;
    nav.origin = meshBounds[0];

    /* 2. build chunky tri mesh for efficient spatial queries */

    const inputChunkyTriMesh = chunkyTriMesh.create(positions, indices);

    /* 3. initialize intermediates for debugging */

    const intermediates: TiledNavMeshIntermediates = {
        buildContext: ctx,
        input: {
            positions,
            indices,
        },
        inputBounds: meshBounds,
        chunkyTriMesh: inputChunkyTriMesh,
        triAreaIds: [],
        heightfield: [],
        compactHeightfield: [],
        contourSet: [],
        polyMesh: [],
        polyMeshDetail: [],
    };

    /* 4. generate tiles */

    const nTilesX = Math.floor((gridSize[0] + tileSizeVoxels - 1) / tileSizeVoxels);
    const nTilesY = Math.floor((gridSize[1] + tileSizeVoxels - 1) / tileSizeVoxels);

    for (let tileX = 0; tileX < nTilesX; tileX++) {
        for (let tileY = 0; tileY < nTilesY; tileY++) {
            const tileBounds: Box3 = [
                [meshBounds[0][0] + tileX * tileSizeWorld, meshBounds[0][1], meshBounds[0][2] + tileY * tileSizeWorld],
                [
                    meshBounds[0][0] + (tileX + 1) * tileSizeWorld,
                    meshBounds[1][1],
                    meshBounds[0][2] + (tileY + 1) * tileSizeWorld,
                ],
            ];

            const { triAreaIds, polyMesh, polyMeshDetail, heightfield, compactHeightfield, contourSet } = buildNavMeshTile(
                ctx,
                positions,
                inputChunkyTriMesh,
                tileBounds,
                cellSize,
                cellHeight,
                borderSize,
                walkableSlopeAngleDegrees,
                walkableClimbVoxels,
                walkableHeightVoxels,
                walkableRadiusVoxels,
                tileSizeVoxels,
                minRegionArea,
                mergeRegionArea,
                maxSimplificationError,
                maxEdgeLength,
                maxVerticesPerPoly,
                detailSampleDistance,
                detailSampleMaxError,
            );

            if (polyMesh.vertices.length === 0) continue;

            intermediates.triAreaIds.push(triAreaIds);
            intermediates.heightfield.push(heightfield);
            intermediates.compactHeightfield.push(compactHeightfield);
            intermediates.contourSet.push(contourSet);
            intermediates.polyMesh.push(polyMesh);
            intermediates.polyMeshDetail.push(polyMeshDetail);

            const tilePolys = polyMeshToTilePolys(polyMesh);

            const tileDetailMesh = polyMeshDetailToTileDetailMesh(tilePolys.polys, polyMeshDetail);

            const tileParams: NavMeshTileParams = {
                bounds: polyMesh.bounds,
                vertices: tilePolys.vertices,
                polys: tilePolys.polys,
                detailMeshes: tileDetailMesh.detailMeshes,
                detailVertices: tileDetailMesh.detailVertices,
                detailTriangles: tileDetailMesh.detailTriangles,
                tileX,
                tileY,
                tileLayer: 0,
                cellSize,
                cellHeight,
                walkableHeight: walkableHeightWorld,
                walkableRadius: walkableRadiusWorld,
                walkableClimb: walkableClimbWorld,
            };

            const tile = buildTile(tileParams);

            addTile(nav, tile);
        }
    }

    return {
        navMesh: nav,
        intermediates,
    };
}
