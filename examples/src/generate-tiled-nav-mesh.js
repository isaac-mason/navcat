import { box3, triangle3, vec2, vec3 } from 'maaths';
import {
    BuildContext,
    ContourBuildFlags,
    WALKABLE_AREA,
    buildCompactHeightfield,
    buildContours,
    buildDistanceField,
    buildNavMeshBvTree,
    buildPolyMesh,
    buildPolyMeshDetail,
    buildRegions,
    calculateGridSize,
    calculateMeshBounds,
    createHeightfield,
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    markWalkableTriangles,
    navMesh,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    rasterizeTriangles,
} from 'nav3d';

/**
 * @typedef {Object} TiledNavMeshInput
 * @property {Float32Array} positions - The input mesh positions
 * @property {Uint32Array} indices - The input mesh indices
 */

/**
 * @typedef {Object} TiledNavMeshOptions
 * @property {number} cellSize - The size of the voxel cells in world units
 * @property {number} cellHeight - The height of the voxel cells in world units
 * @property {number} tileSizeVoxels - The size of each tile in voxels
 * @property {number} walkableRadiusWorld - The radius of the agent in world units
 * @property {number} walkableClimbWorld - The maximum height the agent can climb in world units
 * @property {number} walkableHeightWorld - The minimum height clearance for the agent in world units
 * @property {number} walkableSlopeAngleDegrees - The maximum slope angle in degrees that the agent can walk on
 * @property {number} borderSize - The size of the border around each tile heightfield
 * @property {number} minRegionArea - The minimum area of a region
 * @property {number} mergeRegionArea - The area threshold for merging regions
 * @property {number} maxSimplificationError - The maximum error allowed during contour simplification
 * @property {number} maxEdgeLength - The maximum edge length for contours
 * @property {number} maxVerticesPerPoly - The maximum number of vertices per polygon
 * @property {number} detailSampleDistance - The sampling distance for detail mesh generation
 * @property {number} detailSampleMaxError - The maximum error for detail mesh sampling
 */

/**
 * @typedef {Object} TiledNavMeshIntermediates
 * @property {TiledNavMeshInput} input - The input mesh data
 * @property {import('maaths').Box3} inputBounds - The bounds of the input mesh
 * @property {Uint8Array[]} triAreaIds - Triangle area IDs for each tile
 * @property {import('nav3d').Heightfield[]} heightfield - The voxel heightfields for each tile
 * @property {import('nav3d').CompactHeightfield[]} compactHeightfield - The compact heightfields for each tile
 * @property {import('nav3d').ContourSet[]} contourSet - The contour sets for each tile
 * @property {import('nav3d').PolyMesh[]} polyMesh - The polygon meshes for each tile
 * @property {import('nav3d').PolyMeshDetail[]} polyMeshDetail - The detailed polygon meshes for each tile
 */

/**
 * @typedef {Object} TiledNavMeshResult
 * @property {import('nav3d').NavMesh} navMesh - The generated tiled navigation mesh
 * @property {TiledNavMeshIntermediates} intermediates - Intermediate data structures for debugging
 */

/**
 * Generates a tiled navigation mesh from input geometry.
 *
 * @param {TiledNavMeshInput} input - The input mesh data containing positions and indices
 * @param {TiledNavMeshOptions} options - Configuration options for navmesh generation
 * @returns {TiledNavMeshResult} The generated navigation mesh and intermediate data
 */
export function generateTiledNavMesh(input, options) {
    console.time('navmesh generation');

    const { positions, indices } = input;

    /* 0. define generation parameters */
    const {
        cellSize,
        cellHeight,
        tileSizeVoxels,
        walkableRadiusWorld,
        walkableClimbWorld,
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

    const tileSizeWorld = tileSizeVoxels * cellSize;
    const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
    const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
    const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);

    const ctx = BuildContext.create();

    /**
     * Builds a single tile of the navigation mesh
     * @param {ArrayLike<number>} positions - Mesh positions
     * @param {ArrayLike<number>} indices - Mesh indices
     * @param {import('maaths').Box3} tileBounds - The bounds of the tile to build
     * @param {number} cellSize - Voxel cell size
     * @param {number} cellHeight - Voxel cell height
     * @param {number} borderSize - Border size around tile
     * @param {number} walkableSlopeAngleDegrees - Maximum walkable slope angle
     * @returns {Object} Tile generation intermediates
     */
    const buildTile = (
        positions,
        indices,
        tileBounds,
        cellSize,
        cellHeight,
        borderSize,
        walkableSlopeAngleDegrees,
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

        const expandedTileBounds = structuredClone(tileBounds);

        expandedTileBounds[0][0] -= borderSize * cellSize;
        expandedTileBounds[0][2] -= borderSize * cellSize;

        expandedTileBounds[1][0] += borderSize * cellSize;
        expandedTileBounds[1][2] += borderSize * cellSize;

        /* 2. get triangles overlapping the tile bounds */

        const trianglesInBox = [];

        const triangle = triangle3.create();

        for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i];
            const b = indices[i + 1];
            const c = indices[i + 2];

            vec3.fromBuffer(triangle[0], positions, a * 3);
            vec3.fromBuffer(triangle[1], positions, b * 3);
            vec3.fromBuffer(triangle[2], positions, c * 3);

            if (box3.intersectsTriangle3(expandedTileBounds, triangle)) {
                trianglesInBox.push(a, b, c);
            }
        }

        /* 3. mark walkable triangles */

        const triAreaIds = new Uint8Array(trianglesInBox.length / 3).fill(0);

        markWalkableTriangles(
            positions,
            trianglesInBox,
            triAreaIds,
            walkableSlopeAngleDegrees,
        );

        /* 4. rasterize the triangles to a voxel heightfield */

        const heightfieldWidth = Math.floor(tileSizeVoxels + borderSize * 2);
        const heightfieldHeight = Math.floor(tileSizeVoxels + borderSize * 2);

        const heightfield = createHeightfield(
            heightfieldWidth,
            heightfieldHeight,
            expandedTileBounds,
            cellSize,
            cellHeight,
        );

        rasterizeTriangles(
            ctx,
            heightfield,
            positions,
            trianglesInBox,
            triAreaIds,
            walkableClimbVoxels,
        );

        /* 5. filter walkable surfaces */

        filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
        filterLedgeSpans(
            heightfield,
            walkableHeightVoxels,
            walkableClimbVoxels,
        );
        filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

        /* 6. partition walkable surface to simple regions. */

        const compactHeightfield = buildCompactHeightfield(
            walkableHeightVoxels,
            walkableClimbVoxels,
            heightfield,
        );

        /* 7. erode the walkable area by the agent radius / walkable radius */

        erodeWalkableArea(walkableRadiusVoxels, compactHeightfield);

        /* 8. prepare for region partitioning by calculating a distance field along the walkable surface */

        buildDistanceField(compactHeightfield);

        /* 9. partition the walkable surface into simple regions without holes */

        buildRegions(
            ctx,
            compactHeightfield,
            borderSize,
            minRegionArea,
            mergeRegionArea,
        );
        // buildRegionsMonotone(compactHeightfield, borderSize, minRegionArea, mergeRegionArea);
        // buildLayerRegions(compactHeightfield, borderSize, minRegionArea);

        /* 10. trace and simplify region contours */

        const contourSet = buildContours(
            compactHeightfield,
            maxSimplificationError,
            maxEdgeLength,
            ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
        );

        /* 11. build polygons mesh from contours */

        const polyMesh = buildPolyMesh(contourSet, maxVerticesPerPoly);

        for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
            if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
                polyMesh.areas[polyIndex] = 0;
            }

            if (polyMesh.areas[polyIndex] === 0) {
                polyMesh.flags[polyIndex] = 1;
            }
        }

        /* 12. create detail mesh which allows to access approximate height on each polygon */

        const polyMeshDetail = buildPolyMeshDetail(
            ctx,
            polyMesh,
            compactHeightfield,
            detailSampleDistance,
            detailSampleMaxError,
        );

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

    /* 1. calculate mesh bounds and create tiled nav mesh */

    /** @type {import('maaths').Box3} */
    const meshBounds = calculateMeshBounds(box3.create(), positions, indices);
    const gridSize = calculateGridSize(vec2.create(), meshBounds, cellSize);

    /** @type {import('nav3d').NavMesh} */
    const nav = navMesh.create();
    nav.tileWidth = tileSizeWorld;
    nav.tileHeight = tileSizeWorld;
    nav.origin = meshBounds[0];

    /* 2. initialize intermediates for debugging */

    /** @type {TiledNavMeshIntermediates} */
    const intermediates = {
        input: {
            positions,
            indices,
        },
        inputBounds: meshBounds,
        triAreaIds: [],
        heightfield: [],
        compactHeightfield: [],
        contourSet: [],
        polyMesh: [],
        polyMeshDetail: [],
    };

    /* 3. generate tiles */

    const nTilesX = Math.floor(
        (gridSize[0] + tileSizeVoxels - 1) / tileSizeVoxels,
    );
    const nTilesY = Math.floor(
        (gridSize[1] + tileSizeVoxels - 1) / tileSizeVoxels,
    );

    for (let tileX = 0; tileX < nTilesX; tileX++) {
        for (let tileY = 0; tileY < nTilesY; tileY++) {
            /** @type {import('maaths').Box3} */
            const tileBounds = [
                [
                    meshBounds[0][0] + tileX * tileSizeWorld,
                    meshBounds[0][1],
                    meshBounds[0][2] + tileY * tileSizeWorld,
                ],
                [
                    meshBounds[0][0] + (tileX + 1) * tileSizeWorld,
                    meshBounds[1][1],
                    meshBounds[0][2] + (tileY + 1) * tileSizeWorld,
                ],
            ];

            const {
                triAreaIds,
                polyMesh,
                polyMeshDetail,
                heightfield,
                compactHeightfield,
                contourSet,
            } = buildTile(
                positions,
                indices,
                tileBounds,
                cellSize,
                cellHeight,
                borderSize,
                walkableSlopeAngleDegrees,
            );

            intermediates.triAreaIds.push(triAreaIds);
            intermediates.heightfield.push(heightfield);
            intermediates.compactHeightfield.push(compactHeightfield);
            intermediates.contourSet.push(contourSet);
            intermediates.polyMesh.push(polyMesh);
            intermediates.polyMeshDetail.push(polyMeshDetail);

            const tilePolys = polyMeshToTilePolys(polyMesh);

            const tileDetailMesh = polyMeshDetailToTileDetailMesh(
                tilePolys.polys,
                maxVerticesPerPoly,
                polyMeshDetail,
            );

            /** @type {import('nav3d').NavMeshTile} */
            const tile = {
                id: -1,
                bounds: polyMesh.bounds,
                vertices: tilePolys.vertices,
                polys: tilePolys.polys,
                detailMeshes: tileDetailMesh.detailMeshes,
                detailVertices: tileDetailMesh.detailVertices,
                detailTriangles: tileDetailMesh.detailTriangles,
                tileX,
                tileY,
                tileLayer: 0,
                bvTree: null,
                cellSize,
                cellHeight,
                walkableHeight: walkableHeightWorld,
                walkableRadius: walkableRadiusWorld,
                walkableClimb: walkableClimbWorld,
            };

            buildNavMeshBvTree(tile);

            navMesh.addTile(nav, tile);
        }
    }

    console.timeEnd('navmesh generation');

    return {
        navMesh: nav,
        intermediates,
    };
}
