/** biome-ignore-all lint/correctness/noUnusedVariables: examples */

/* SNIPPET_START: generationFull */

/* SNIPPET_START: input */
import * as Nav from 'navcat';

type Vec3 = [number, number, number];
type Box3 = [Vec3, Vec3];

// flat array of vertex positions [x1, y1, z1, x2, y2, z2, ...]
const positions: number[] = [];

// flat array of triangle vertex indices
const indices: number[] = [];

// build context to capture diagnostic messages, warnings, and errors
const ctx = Nav.BuildContext.create();
/* SNIPPET_END: input */

/* SNIPPET_START: walkableTriangles */
// CONFIG: agent walkable slope angle
const walkableSlopeAngleDegrees = 45;

// allocate an array to hold the area ids for each triangle
const triAreaIds = new Uint8Array(indices.length / 3).fill(0);

// mark triangles as walkable or not depending on their slope angle
Nav.markWalkableTriangles(positions, indices, triAreaIds, walkableSlopeAngleDegrees);
/* SNIPPET_END: walkableTriangles */

/* SNIPPET_START: rasterize */
// CONFIG: heightfield cell size and height, in world units
const cellSize = 0.2;
const cellHeight = 0.2;

// CONFIG: agent walkable climb
const walkableClimbWorld = 0.5; // in world units
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);

// CONFIG: agent walkable height
const walkableHeightWorld = 1.0; // in world units
const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);

// calculate the bounds of the input geometry
const bounds: Box3 = [[0, 0, 0], [0, 0, 0]];
Nav.calculateMeshBounds(bounds, positions, indices);

// calculate the grid size of the heightfield
const [heightfieldWidth, heightfieldHeight] = Nav.calculateGridSize([0, 0], bounds, cellSize);

// create the heightfield
const heightfield = Nav.createHeightfield(heightfieldWidth, heightfieldHeight, bounds, cellSize, cellHeight);

// rasterize the walkable triangles into the heightfield
Nav.rasterizeTriangles(ctx, heightfield, positions, indices, triAreaIds, walkableClimbVoxels);

// filter walkable surfaces
Nav.filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
Nav.filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
Nav.filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);
/* SNIPPET_END: rasterize */

/* SNIPPET_START: compactHeightfield */
// build the compact heightfield
const compactHeightfield = Nav.buildCompactHeightfield(ctx, walkableHeightVoxels, walkableClimbVoxels, heightfield);

// CONFIG: agent radius
const walkableRadiusWorld = 0.6; // in world units
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);

// erode the walkable area by the agent radius / walkable radius
Nav.erodeWalkableArea(walkableRadiusVoxels, compactHeightfield);

// OPTIONAL: you can use utilities like markBoxArea here on the compact heightfield to mark custom areas
// see the "Custom Query Filters and Custom Area Types" section of the docs for more info
/* SNIPPET_END: compactHeightfield */

/* SNIPPET_START: compactHeightfieldRegions */
// prepare for region partitioning by calculating a distance field along the walkable surface
Nav.buildDistanceField(compactHeightfield);

// CONFIG: borderSize, relevant if you are building a tiled navmesh
const borderSize = 0;

// CONFIG: minRegionArea
const minRegionArea = 8; // world units

// CONFIG: mergeRegionArea
const mergeRegionArea = 20; // world units

// partition the walkable surface into simple regions without holes
Nav.buildRegions(ctx, compactHeightfield, borderSize, minRegionArea, mergeRegionArea);
/* SNIPPET_END: compactHeightfieldRegions */

/* SNIPPET_START: contours */
// CONFIG: maxSimplificationError
const maxSimplificationError = 1.3; // world units

// CONFIG: maxEdgeLength
const maxEdgeLength = 6.0; // world units

// trace and simplify region contours
const contourSet = Nav.buildContours(
    ctx,
    compactHeightfield,
    maxSimplificationError,
    maxEdgeLength,
    Nav.ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
);
/* SNIPPET_END: contours */

/* SNIPPET_START: polyMesh */
// CONFIG: max vertices per polygon
const maxVerticesPerPoly = 5; // 3-6, higher = less polys, but more complex polys

const polyMesh = Nav.buildPolyMesh(ctx, contourSet, maxVerticesPerPoly);

for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
    // make all "areas" use a base area id of 0
    if (polyMesh.areas[polyIndex] === Nav.WALKABLE_AREA) {
        polyMesh.areas[polyIndex] = 0;
    }

    // give all base "walkable" polys all flags
    if (polyMesh.areas[polyIndex] === 0) {
        polyMesh.flags[polyIndex] = 1;
    }
}

// CONFIG: detail mesh sample distance
const sampleDist = 1.0; // world units

// CONFIG: detail mesh max sample error
const sampleMaxError = 1.0; // world units

const polyMeshDetail = Nav.buildPolyMeshDetail(ctx, polyMesh, compactHeightfield, sampleDist, sampleMaxError);
/* SNIPPET_END: polyMesh */

/* SNIPPET_START: convert */
// convert the poly mesh to a navmesh tile polys
const tilePolys = Nav.polyMeshToTilePolys(polyMesh);

// convert the poly mesh detail to a navmesh tile detail mesh
const tileDetailMesh = Nav.polyMeshDetailToTileDetailMesh(tilePolys.polys, polyMeshDetail);
/* SNIPPET_END: convert */

/* SNIPPET_START: navMesh */
// create the navigation mesh
const navMesh = Nav.createNavMesh();

// set the navmesh parameters using the poly mesh bounds
// this example is for a single tile navmesh, so the tile width/height is the same as the poly mesh bounds size
navMesh.tileWidth = polyMesh.bounds[1][0] - polyMesh.bounds[0][0];
navMesh.tileHeight = polyMesh.bounds[1][2] - polyMesh.bounds[0][2];
navMesh.origin[0] = polyMesh.bounds[0][0];
navMesh.origin[1] = polyMesh.bounds[0][1];
navMesh.origin[2] = polyMesh.bounds[0][2];

// create the navmesh tile
const tile: Nav.NavMeshTile = {
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

// OPTIONAL: build a bounding volume tree to accelerate spatial queries for this tile
Nav.buildNavMeshBvTree(tile);

// add the tile to the navmesh
Nav.addTile(navMesh, tile);
/* SNIPPET_END: navMesh */

/* SNIPPET_END: generationFull */

{
    /* SNIPPET_START: findPath */
    const start: Vec3 = [1, 0, 1];
    const end: Vec3 = [8, 0, 8];
    const halfExtents: Vec3 = [0.5, 0.5, 0.5];

    // find a path from start to end
    const findPathResult = Nav.findPath(navMesh, start, end, halfExtents, Nav.DEFAULT_QUERY_FILTER);

    if (findPathResult.success) {
        const points = findPathResult.path.map((p) => p.position);
        console.log('path points:', points); // [ [x1, y1, z1], [x2, y2, z2], ... ]
    }
    /* SNIPPET_END: findPath */
}

{
    /* SNIPPET_START: findNearestPoly */
    const position: Vec3 = [1, 0, 1];
    const halfExtents: Vec3 = [0.5, 0.5, 0.5];

    // find the nearest nav mesh poly node to the position
    const findNearestPolyResult = Nav.createFindNearestPolyResult();
    Nav.findNearestPoly(findNearestPolyResult, navMesh, position, halfExtents, Nav.DEFAULT_QUERY_FILTER);

    console.log(findNearestPolyResult.success); // true if a nearest poly was found
    console.log(findNearestPolyResult.ref); // the nearest poly's node ref, or 0 if none found
    console.log(findNearestPolyResult.point); // the nearest point on the poly in world space [x, y, z]
    /* SNIPPET_END: findNearestPoly */

    /* SNIPPET_START: getClosestPointOnPoly */
    const polyRef = findNearestPolyResult.ref;
    const getClosestPointOnPolyResult = Nav.createGetClosestPointOnPolyResult();

    Nav.getClosestPointOnPoly(getClosestPointOnPolyResult, navMesh, polyRef, position);

    console.log(getClosestPointOnPolyResult.success); // true if a closest point was found
    console.log(getClosestPointOnPolyResult.isOverPoly); // true if the position was inside the poly
    console.log(getClosestPointOnPolyResult.closestPoint); // the closest point on the poly in world space [x, y, z]
    /* SNIPPET_END: getClosestPointOnPoly */
}

{
    /* SNIPPET_START: getClosestPointOnDetailEdges */
    const position: Vec3 = [1, 0, 1];
    const halfExtents: Vec3 = [0.5, 0.5, 0.5];

    // find the nearest nav mesh poly node to the position
    const nearestPoly = Nav.findNearestPoly(
        Nav.createFindNearestPolyResult(),
        navMesh,
        position,
        halfExtents,
        Nav.DEFAULT_QUERY_FILTER,
    );

    const tileAndPoly = Nav.getTileAndPolyByRef(nearestPoly.ref, navMesh);

    const closestPoint: Vec3 = [0, 0, 0];
    const onlyBoundaryEdges = false;

    const squaredDistance = Nav.getClosestPointOnDetailEdges(
        closestPoint,
        tileAndPoly.tile!,
        tileAndPoly.poly!,
        tileAndPoly.polyIndex,
        position,
        onlyBoundaryEdges,
    );

    console.log(squaredDistance); // squared distance from position to closest point
    console.log(closestPoint); // the closest point on the detail edges in world space [x, y, z]
    /* SNIPPET_END: getClosestPointOnDetailEdges */
}

{
    /* SNIPPET_START: findNodePath */
    const start: Vec3 = [1, 0, 1];
    const end: Vec3 = [8, 0, 8];
    const halfExtents: Vec3 = [0.5, 0.5, 0.5];

    // find the nearest nav mesh poly node to the start position
    const startNode = Nav.findNearestPoly(
        Nav.createFindNearestPolyResult(),
        navMesh,
        start,
        halfExtents,
        Nav.DEFAULT_QUERY_FILTER,
    );

    // find the nearest nav mesh poly node to the end position
    const endNode = Nav.findNearestPoly(Nav.createFindNearestPolyResult(), navMesh, end, halfExtents, Nav.DEFAULT_QUERY_FILTER);

    // find a "node" path from start to end
    if (startNode.success && endNode.success) {
        const nodePath = Nav.findNodePath(
            navMesh,
            startNode.ref,
            endNode.ref,
            startNode.point,
            endNode.point,
            Nav.DEFAULT_QUERY_FILTER,
        );

        console.log(nodePath.success); // true if a partial or full path was found
        console.log(nodePath.path); // ['0,0,1', '0,0,5', '0,0,8', ... ]
    }
    /* SNIPPET_END: findNodePath */
}

{
    /* SNIPPET_START: findStraightPath */
    const start: Vec3 = [1, 0, 1];
    const end: Vec3 = [8, 0, 8];

    // array of nav mesh node refs, often retrieved from a call to findNodePath
    const findStraightPathNodes: Nav.NodeRef[] = [
        /* ... */
    ];

    // find the nearest nav mesh poly node to the start position
    const straightPathResult = Nav.findStraightPath(navMesh, start, end, findStraightPathNodes);

    console.log(straightPathResult.success); // true if a partial or full path was found
    console.log(straightPathResult.path); // [ { position: [x, y, z], nodeType: NodeType, nodeRef: NodeRef }, ... ]
    /* SNIPPET_END: findStraightPath */
}

{
    /* SNIPPET_START: moveAlongSurface */
    const start: Vec3 = [1, 0, 1];
    const end: Vec3 = [8, 0, 8];
    const halfExtents: Vec3 = [0.5, 0.5, 0.5];

    const startNode = Nav.findNearestPoly(
        Nav.createFindNearestPolyResult(),
        navMesh,
        start,
        halfExtents,
        Nav.DEFAULT_QUERY_FILTER,
    );

    const moveAlongSurfaceResult = Nav.moveAlongSurface(navMesh, startNode.ref, start, end, Nav.DEFAULT_QUERY_FILTER);

    console.log(moveAlongSurfaceResult.success); // true if the move was successful
    console.log(moveAlongSurfaceResult.resultPosition); // the resulting position after the move [x, y, z]
    console.log(moveAlongSurfaceResult.resultRef); // the resulting poly node ref after the move, or 0 if none
    console.log(moveAlongSurfaceResult.visited); // array of node refs that were visited during the move
    /* SNIPPET_END: moveAlongSurface */
}

{
    /* SNIPPET_START: raycast */
    const start: Vec3 = [1, 0, 1];
    const end: Vec3 = [8, 0, 8];
    const halfExtents: Vec3 = [0.5, 0.5, 0.5];

    const startNode = Nav.findNearestPoly(
        Nav.createFindNearestPolyResult(),
        navMesh,
        start,
        halfExtents,
        Nav.DEFAULT_QUERY_FILTER,
    );

    const raycastResult = Nav.raycast(navMesh, startNode.ref, start, end, Nav.DEFAULT_QUERY_FILTER);

    console.log(raycastResult.t); // the normalized distance along the ray where an obstruction was found, or 1.0 if none
    console.log(raycastResult.hitNormal); // the normal of the obstruction hit, or [0, 0, 0] if none
    console.log(raycastResult.hitEdgeIndex); // the index of the edge of the poly that was hit, or -1 if none
    console.log(raycastResult.path); // array of node refs that were visited during the raycast
    /* SNIPPET_END: raycast */
}

{
    /* SNIPPET_START: getPolyHeight */
    const position: Vec3 = [1, 0, 1];
    const halfExtents: Vec3 = [0.5, 0.5, 0.5];

    const nearestPoly = Nav.findNearestPoly(
        Nav.createFindNearestPolyResult(),
        navMesh,
        position,
        halfExtents,
        Nav.DEFAULT_QUERY_FILTER,
    );

    const tileAndPoly = Nav.getTileAndPolyByRef(nearestPoly.ref, navMesh);

    if (nearestPoly.success) {
        const getPolyHeightResult = Nav.createGetPolyHeightResult();
        Nav.getPolyHeight(getPolyHeightResult, tileAndPoly.tile!, tileAndPoly.poly!, tileAndPoly.polyIndex, position);

        console.log(getPolyHeightResult.success); // true if a height was found
        console.log(getPolyHeightResult.height); // the height of the poly at the position
    }
    /* SNIPPET_END: getPolyHeight */
}

{
    /* SNIPPET_START: findRandomPoint */
    const randomPoint = Nav.findRandomPoint(navMesh, Nav.DEFAULT_QUERY_FILTER, Math.random);

    console.log(randomPoint.success); // true if a random point was found
    console.log(randomPoint.position); // [x, y, z]
    console.log(randomPoint.ref); // the poly node ref that the random point is on

    /* SNIPPET_END: findRandomPoint */
}

{
    /* SNIPPET_START: findRandomPointAroundCircle */
    const center: Vec3 = [5, 0, 5];
    const radius = 3.0; // world units

    const halfExtents: Vec3 = [0.5, 0.5, 0.5];

    const centerNode = Nav.findNearestPoly(
        Nav.createFindNearestPolyResult(),
        navMesh,
        center,
        halfExtents,
        Nav.DEFAULT_QUERY_FILTER,
    );

    if (centerNode.success) {
        const randomPointAroundCircle = Nav.findRandomPointAroundCircle(
            navMesh,
            centerNode.ref,
            center,
            radius,
            Nav.DEFAULT_QUERY_FILTER,
            Math.random,
        );

        console.log(randomPointAroundCircle.success); // true if a random point was found
        console.log(randomPointAroundCircle.position); // [x, y, z]
        console.log(randomPointAroundCircle.randomRef); // the poly node ref that the random point is on
    }
    /* SNIPPET_END: findRandomPointAroundCircle */
}

{
    /* SNIPPET_START: getPortalPoints */
    const startNodeRef: Nav.NodeRef = '0,0,1'; // example poly node ref, usually retrieved from a pathfinding call
    const endNodeRef: Nav.NodeRef = '0,0,8'; // example poly node ref, usually retrieved from a pathfinding call

    const left: Vec3 = [0, 0, 0];
    const right: Vec3 = [0, 0, 0];

    const getPortalPointsSuccess = Nav.getPortalPoints(navMesh, startNodeRef, endNodeRef, left, right);

    console.log(getPortalPointsSuccess); // true if the portal points were found
    console.log('left:', left);
    console.log('right:', right);
    /* SNIPPET_END: getPortalPoints */
}

{
    /* SNIPPET_START: isValidNodeRef */
    const nodeRef: Nav.NodeRef = '0,0,1';

    // true if the node ref is valid, useful to call after updating tiles to validate the reference is still valid
    const isValid = Nav.isValidNodeRef(navMesh, nodeRef);
    console.log(isValid);
    /* SNIPPET_END: isValidNodeRef */
}

{
    /* SNIPPET_START: getNodeAreaAndFlags */
    const nodeRef: Nav.NodeRef = '0,0,1';

    const areaAndFlags = Nav.getNodeAreaAndFlags(Nav.createGetNodeAreaAndFlagsResult(), navMesh, nodeRef);
    console.log(areaAndFlags.success);
    console.log(areaAndFlags.area);
    console.log(areaAndFlags.flags);
    /* SNIPPET_END: getNodeAreaAndFlags */
}

{
    /* SNIPPET_START: queryPolygons */
    
    // find all polys within a box area
    const bounds: Box3 = [
        [0, 0, 0],
        [1, 1, 1],
    ];

    const queryPolygonsResult = Nav.queryPolygons(navMesh, bounds, Nav.DEFAULT_QUERY_FILTER);

    console.log(queryPolygonsResult); // array of node refs that overlap the box area
    /* SNIPPET_END: queryPolygons */
}

{
    /* SNIPPET_START: queryPolygonsInTile */
    const tile = Object.values(navMesh.tiles)[0]; // example tile
    const bounds: Box3 = tile.bounds;

    const outNodeRefs: Nav.NodeRef[] = [];

    Nav.queryPolygonsInTile(outNodeRefs, navMesh, tile, bounds, Nav.DEFAULT_QUERY_FILTER);
    /* SNIPPET_END: queryPolygonsInTile */
}

{
    /* SNIPPET_START: offMeshConnections */
    // define a bidirectional off-mesh connection between two points
    const bidirectionalOffMeshConnection: Nav.OffMeshConnection = {
        // start position in world space
        start: [0, 0, 0],
        // end position in world space
        end: [1, 0, 1],
        // radius of the connection endpoints, if it's too small a poly may not be found to link the connection to
        radius: 0.5,
        // the direction of the off-mesh connection (START_TO_END or BIDIRECTIONAL)
        direction: Nav.OffMeshConnectionDirection.BIDIRECTIONAL,
        // flags for the off-mesh connection, you can use this for custom behaviour with query filters
        flags: 1,
        // area id for the off-mesh connection, you can use this for custom behaviour with query filters
        area: 0,
    };

    // add the off-mesh connection to the nav mesh, returns the off-mesh connection id
    const bidirectionalOffMeshConnectionId = Nav.addOffMeshConnection(navMesh, bidirectionalOffMeshConnection);

    // true if the off-mesh connection is linked to polys, false if a suitable poly couldn't be found
    Nav.isOffMeshConnectionConnected(navMesh, bidirectionalOffMeshConnectionId);

    // retrieve the off-mesh connection attachment info, which contains the start and end poly node refs that the connection is linked to
    const offMeshConnectionAttachment = navMesh.offMeshConnectionAttachments[bidirectionalOffMeshConnectionId];

    if (offMeshConnectionAttachment) {
        console.log(offMeshConnectionAttachment.start); // the start poly node ref that the off-mesh connection is linked to
        console.log(offMeshConnectionAttachment.end); // the end poly node ref that the off-mesh connection is linked to
    }

    // remove the off-mesh connection from the nav mesh
    Nav.removeOffMeshConnection(navMesh, bidirectionalOffMeshConnectionId);

    // define a one-way off-mesh connection (e.g. a teleporter that only goes one way)
    const oneWayTeleporterOffMeshConnection: Nav.OffMeshConnection = {
        start: [2, 0, 2],
        end: [3, 1, 3],
        radius: 0.5,
        direction: Nav.OffMeshConnectionDirection.START_TO_END,
        flags: 1,
        area: 0,
        // optional cost override, if not provided the cost will be the distance from start to end
        // making the cost 0 means the teleporter will be more preferred over normal walkable paths
        cost: 0,
    };

    // add the off-mesh connection to the nav mesh, returns the off-mesh connection id
    const oneWayTeleporterOffMeshConnectionId = Nav.addOffMeshConnection(navMesh, oneWayTeleporterOffMeshConnection);

    // remove the off-mesh connection from the nav mesh
    Nav.removeOffMeshConnection(navMesh, oneWayTeleporterOffMeshConnectionId);
    /* SNIPPET_END: offMeshConnections */
}

{
    /* SNIPPET_START: debug */
    const triangleAreaIdsHelper = Nav.createTriangleAreaIdsHelper({ positions, indices }, triAreaIds);

    const heightfieldHelper = Nav.createHeightfieldHelper(heightfield);

    const compactHeightfieldSolidHelper = Nav.createCompactHeightfieldSolidHelper(compactHeightfield);

    const compactHeightfieldDistancesHelper = Nav.createCompactHeightfieldDistancesHelper(compactHeightfield);

    const compactHeightfieldRegionsHelper = Nav.createCompactHeightfieldRegionsHelper(compactHeightfield);

    const rawContoursHelper = Nav.createRawContoursHelper(contourSet);

    const simplifiedContoursHelper = Nav.createSimplifiedContoursHelper(contourSet);

    const polyMeshHelper = Nav.createPolyMeshHelper(polyMesh);

    const polyMeshDetailHelper = Nav.createPolyMeshDetailHelper(polyMeshDetail);

    const navMeshHelper = Nav.createNavMeshHelper(navMesh);

    const navMeshPolyHelper = Nav.createNavMeshPolyHelper(navMesh, '0,0,1');

    const navMeshTileBvTreeHelper = Nav.createNavMeshTileBvTreeHelper(tile);

    const navMeshBvTreeHelper = Nav.createNavMeshBvTreeHelper(navMesh);

    const navMeshLinksHelper = Nav.createNavMeshLinksHelper(navMesh);

    const navMeshTilePortalsHelper = Nav.createNavMeshTilePortalsHelper(tile);

    const navMeshPortalsHelper = Nav.createNavMeshPortalsHelper(navMesh);

    const findNodePathResult = Nav.findNodePath(navMesh, '0,0,1', '0,0,8', [1, 0, 1], [8, 0, 8], Nav.DEFAULT_QUERY_FILTER);
    const searchNodesHelper = Nav.createSearchNodesHelper(findNodePathResult.nodes);

    const navMeshOffMeshConnectionsHelper = Nav.createNavMeshOffMeshConnectionsHelper(navMesh);
    /* SNIPPET_END: debug */
}
