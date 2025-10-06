import type { Box3, Triangle3, Vec2, Vec3 } from 'maaths';
import { box3, vec2, vec3 } from 'maaths';
import { DETAIL_EDGE_BOUNDARY, POLY_NEIS_FLAG_EXT_LINK, POLY_NEIS_FLAG_EXT_LINK_DIR_MASK } from '../generate';
import { closestHeightPointTriangle, createDistancePtSegSqr2dResult, distancePtSegSqr2d, pointInPoly } from '../geometry';
import { createIndexPool, releaseIndex, requestIndex } from '../index-pool';
import {
    type NavMesh,
    type NavMeshPoly,
    type NavMeshTile,
    type NavMeshTileParams,
    type OffMeshConnection,
    type OffMeshConnectionAttachment,
    OffMeshConnectionDirection,
    type OffMeshConnectionParams,
    OffMeshConnectionSide,
} from './nav-mesh';
import { getNodeRefIndex, getNodeRefSequence, getNodeRefType, MAX_SEQUENCE, type NodeRef, NodeType, serNodeRef } from './node';

export const createNavMesh = (): NavMesh => {
    return {
        origin: [0, 0, 0],
        tileWidth: 0,
        tileHeight: 0,
        links: [],
        nodes: [],
        tiles: {},
        tilePositionToTileId: {},
        tileColumnToTileIds: {},
        offMeshConnections: {},
        offMeshConnectionAttachments: {},
        tilePositionToSequenceCounter: {},
        offMeshConnectionSequenceCounter: 0,
        nodeIndexPool: createIndexPool(),
        tileIndexPool: createIndexPool(),
        offMeshConnectionIndexPool: createIndexPool(),
        linkIndexPool: createIndexPool(),
    };
};

export const getNodeByRef = (navMesh: NavMesh, ref: NodeRef) => {
    const nodeIndex = getNodeRefIndex(ref);
    const node = navMesh.nodes[nodeIndex];
    return node;
};

export const getNodeByTileAndPoly = (navMesh: NavMesh, tile: NavMeshTile, polyIndex: number) => {
    const navMeshNodeIndex = tile.polyNodes[polyIndex];
    const navMeshNode = navMesh.nodes[navMeshNodeIndex];

    return navMeshNode;
};

export const isValidNodeRef = (navMesh: NavMesh, nodeRef: NodeRef): boolean => {
    const nodeType = getNodeRefType(nodeRef);

    if (nodeType === NodeType.POLY) {
        const node = getNodeByRef(navMesh, nodeRef);

        if (!node) {
            return false;
        }

        const tile = navMesh.tiles[node.tileId];

        if (!tile) {
            return false;
        }

        const sequence = getNodeRefSequence(nodeRef);

        if (tile.sequence !== sequence) {
            return false;
        }

        if (node.polyIndex < 0 || node.polyIndex >= tile.polys.length) {
            return false;
        }

        const poly = tile.polys[node.polyIndex];

        if (!poly) {
            return false;
        }

        return true;
    }

    if (nodeType === NodeType.OFFMESH) {
        const node = getNodeByRef(navMesh, nodeRef);

        if (!node) {
            return false;
        }

        const offMeshConnection = navMesh.offMeshConnections[node.offMeshConnectionId];

        if (!offMeshConnection) {
            return false;
        }

        const sequence = getNodeRefSequence(nodeRef);

        if (offMeshConnection.sequence !== sequence) {
            return false;
        }

        if (!isOffMeshConnectionConnected(navMesh, offMeshConnection.id)) {
            return false;
        }

        return true;
    }

    return false;
};

export const getTileAt = (navMesh: NavMesh, x: number, y: number, layer: number): NavMeshTile | undefined => {
    const tileHash = getTilePositionHash(x, y, layer);
    return navMesh.tiles[tileHash];
};

export const getTilesAt = (navMesh: NavMesh, x: number, y: number): NavMeshTile[] => {
    const tileColumnHash = getTileColumnHash(x, y);
    const tileIds = navMesh.tileColumnToTileIds[tileColumnHash];

    if (!tileIds) return [];

    const tiles: NavMeshTile[] = [];

    for (const tileId of tileIds) {
        tiles.push(navMesh.tiles[tileId]);
    }

    return tiles;
};

const getNeighbourTilesAt = (navMesh: NavMesh, x: number, y: number, side: number): NavMeshTile[] => {
    let nx = x;
    let ny = y;

    switch (side) {
        case 0:
            nx++;
            break;
        case 1:
            nx++;
            ny++;
            break;
        case 2:
            ny++;
            break;
        case 3:
            nx--;
            ny++;
            break;
        case 4:
            nx--;
            break;
        case 5:
            nx--;
            ny--;
            break;
        case 6:
            ny--;
            break;
        case 7:
            nx++;
            ny--;
            break;
    }

    return getTilesAt(navMesh, nx, ny);
};

const getTilePositionHash = (x: number, y: number, layer: number): string => {
    return `${x},${y},${layer}`;
};

const getTileColumnHash = (x: number, y: number): string => {
    return `${x},${y}`;
};

/**
 * Returns the tile x and y position in the nav mesh from a world space position.
 * @param outTilePosition the output tile position
 * @param worldX the world tile x coordinate
 * @param worldY the world tile y coordinate (along the z axis)
 */
export const worldToTilePosition = (outTilePosition: Vec2, navMesh: NavMesh, worldPosition: Vec3) => {
    outTilePosition[0] = Math.floor((worldPosition[0] - navMesh.origin[0]) / navMesh.tileWidth);
    outTilePosition[1] = Math.floor((worldPosition[2] - navMesh.origin[2]) / navMesh.tileHeight);
    return outTilePosition;
};

export type GetTileAndPolyByRefResult =
    | {
        success: false;
        tile: NavMeshTile | null;
        poly: NavMeshPoly | null;
        polyIndex: number;
    }
    | {
        success: true;
        tile: NavMeshTile;
        poly: NavMeshPoly;
        polyIndex: number;
    };

/**
 * Gets the tile and polygon from a polygon reference
 * @param ref The polygon reference
 * @param navMesh The navigation mesh
 * @returns Object containing tile and poly, or null if not found
 */
export const getTileAndPolyByRef = (ref: NodeRef, navMesh: NavMesh): GetTileAndPolyByRefResult => {
    const result = {
        success: false,
        tile: null,
        poly: null,
        polyIndex: -1,
    } as GetTileAndPolyByRefResult;

    const nodeType = getNodeRefType(ref);

    if (nodeType !== NodeType.POLY) return result;

    const { tileId, polyIndex } = getNodeByRef(navMesh, ref);

    const tile = navMesh.tiles[tileId];

    if (!tile) {
        return result;
    }

    if (polyIndex >= tile.polys.length) {
        return result;
    }

    result.poly = tile.polys[polyIndex];
    result.tile = tile;
    result.polyIndex = polyIndex;
    result.success = true;

    return result;
};

const _getPolyHeightA = vec3.create();
const _getPolyHeightB = vec3.create();
const _getPolyHeightC = vec3.create();
const _getPolyHeightTriangle: Triangle3 = [_getPolyHeightA, _getPolyHeightB, _getPolyHeightC];
const _getPolyHeightVertices: number[] = [];

export type GetPolyHeightResult = {
    success: boolean;
    height: number;
};

export const createGetPolyHeightResult = (): GetPolyHeightResult => ({
    success: false,
    height: 0,
});

/**
 * Gets the height of a polygon at a given point using detail mesh if available.
 * @param result The result object to populate
 * @param tile The tile containing the polygon
 * @param poly The polygon
 * @param polyIndex The index of the polygon in the tile
 * @param pos The position to get height for
 * @returns The result object with success flag and height
 */
export const getPolyHeight = (
    result: GetPolyHeightResult,
    tile: NavMeshTile,
    poly: NavMeshPoly,
    polyIndex: number,
    pos: Vec3,
): GetPolyHeightResult => {
    result.success = false;
    result.height = 0;

    const detailMesh = tile.detailMeshes[polyIndex];

    // build polygon vertices array
    const nv = poly.vertices.length;
    const vertices = _getPolyHeightVertices;
    for (let i = 0; i < nv; ++i) {
        const start = poly.vertices[i] * 3;
        vertices[i * 3] = tile.vertices[start];
        vertices[i * 3 + 1] = tile.vertices[start + 1];
        vertices[i * 3 + 2] = tile.vertices[start + 2];
    }

    // check if point is inside polygon
    if (!pointInPoly(nv, vertices, pos)) {
        return result;
    }

    // point is inside polygon, find height at the location
    if (detailMesh) {
        for (let j = 0; j < detailMesh.trianglesCount; ++j) {
            const t = (detailMesh.trianglesBase + j) * 4;
            const detailTriangles = tile.detailTriangles;

            // get triangle vertices
            const v: Vec3[] = _getPolyHeightTriangle;
            for (let k = 0; k < 3; ++k) {
                const vertIndex = detailTriangles[t + k];
                if (vertIndex < poly.vertices.length) {
                    // use polygon vertex
                    const polyVertIndex = poly.vertices[vertIndex] * 3;
                    v[k][0] = tile.vertices[polyVertIndex + 0];
                    v[k][1] = tile.vertices[polyVertIndex + 1];
                    v[k][2] = tile.vertices[polyVertIndex + 2];
                } else {
                    // use detail vertices
                    const detailVertIndex = (detailMesh.verticesBase + (vertIndex - poly.vertices.length)) * 3;
                    v[k][0] = tile.detailVertices[detailVertIndex + 0];
                    v[k][1] = tile.detailVertices[detailVertIndex + 1];
                    v[k][2] = tile.detailVertices[detailVertIndex + 2];
                }
            }

            const height = closestHeightPointTriangle(pos, v[0], v[1], v[2]);

            if (!Number.isNaN(height)) {
                result.success = true;
                result.height = height;
                return result;
            }
        }
    }

    // if all triangle checks failed above (can happen with degenerate triangles
    // or larger floating point values) the point is on an edge, so just select
    // closest.
    // this should almost never happen so the extra iteration here is ok.
    const closest = vec3.create();
    getClosestPointOnDetailEdges(closest, tile, poly, polyIndex, pos, false);
    result.success = true;
    result.height = closest[1];

    return result;
};

/**
 * Get flags for edge in detail triangle.
 * @param[in]	triFlags		The flags for the triangle (last component of detail vertices above).
 * @param[in]	edgeIndex		The index of the first vertex of the edge. For instance, if 0,
 *								returns flags for edge AB.
 * @returns The edge flags
 */
const getDetailTriEdgeFlags = (triFlags: number, edgeIndex: number): number => {
    return (triFlags >> (edgeIndex * 2)) & 0x3;
};

const _closestPointOnDetailEdgesTriangleVertices: Vec3[] = [vec3.create(), vec3.create(), vec3.create()];
const _closestPointOnDetailEdgesPmin = vec3.create();
const _closestPointOnDetailEdgesPmax = vec3.create();
const _closestPointOnDetailEdges_distancePtSegSqr2dResult = createDistancePtSegSqr2dResult();

/**
 * Gets the closest point on detail mesh edges to a given point
 * @param tile The tile containing the detail mesh
 * @param poly The polygon
 * @param detailMesh The detail mesh
 * @param pos The position to find closest point for
 * @param outClosestPoint Output parameter for the closest point
 * @param onlyBoundary If true, only consider boundary edges
 * @returns The squared distance to the closest point
 *  closest point
 */
export const getClosestPointOnDetailEdges = (
    outClosestPoint: Vec3,
    tile: NavMeshTile,
    poly: NavMeshPoly,
    polyIndex: number,
    pos: Vec3,
    onlyBoundary: boolean,
): number => {
    const detailMesh = tile.detailMeshes[polyIndex];

    let dmin = Number.MAX_VALUE;
    let tmin = 0;

    const pmin = vec3.set(_closestPointOnDetailEdgesPmin, 0, 0, 0);
    const pmax = vec3.set(_closestPointOnDetailEdgesPmax, 0, 0, 0);

    for (let i = 0; i < detailMesh.trianglesCount; i++) {
        const t = (detailMesh.trianglesBase + i) * 4;
        const detailTriangles = tile.detailTriangles;

        // check if triangle has boundary edges (if onlyBoundary is true)
        if (onlyBoundary) {
            const triFlags = detailTriangles[t + 3];
            const ANY_BOUNDARY_EDGE = (DETAIL_EDGE_BOUNDARY << 0) | (DETAIL_EDGE_BOUNDARY << 2) | (DETAIL_EDGE_BOUNDARY << 4);
            if ((triFlags & ANY_BOUNDARY_EDGE) === 0) {
                continue;
            }
        }

        // get triangle vertices
        const triangleVertices = _closestPointOnDetailEdgesTriangleVertices;
        for (let j = 0; j < 3; ++j) {
            const vertexIndex = detailTriangles[t + j];
            if (vertexIndex < poly.vertices.length) {
                // use main polygon vertices - vertexIndex is an index into poly.vertices
                vec3.fromBuffer(triangleVertices[j], tile.vertices, poly.vertices[vertexIndex] * 3);
            } else {
                // use detail vertices - (vertexIndex - poly.vertices.length) gives offset from verticesBase
                const detailIndex = (detailMesh.verticesBase + (vertexIndex - poly.vertices.length)) * 3;
                vec3.fromBuffer(triangleVertices[j], tile.detailVertices, detailIndex);
            }
        }

        // check each edge of the triangle
        for (let k = 0, j = 2; k < 3; j = k++) {
            const triFlags = detailTriangles[t + 3];
            const edgeFlags = getDetailTriEdgeFlags(triFlags, j);

            // skip internal edges if we want only boundaries, or skip duplicate internal edges
            if ((edgeFlags & DETAIL_EDGE_BOUNDARY) === 0 && (onlyBoundary || detailTriangles[t + j] < detailTriangles[t + k])) {
                // only looking at boundary edges and this is internal, or
                // this is an inner edge that we will see again or have already seen.
                continue;
            }

            const result = distancePtSegSqr2d(
                _closestPointOnDetailEdges_distancePtSegSqr2dResult,
                pos,
                triangleVertices[j],
                triangleVertices[k],
            );

            if (result.distSqr < dmin) {
                dmin = result.distSqr;
                tmin = result.t;
                vec3.copy(pmin, triangleVertices[j]);
                vec3.copy(pmax, triangleVertices[k]);
            }
        }
    }

    // interpolate the final closest point
    if (pmin && pmax) {
        vec3.lerp(outClosestPoint, pmin, pmax, tmin);
    }

    return dmin;
};

export type GetClosestPointOnPolyResult = {
    success: boolean;
    isOverPoly: boolean;
    closestPoint: Vec3;
};

export const createGetClosestPointOnPolyResult = (): GetClosestPointOnPolyResult => {
    return {
        success: false,
        isOverPoly: false,
        closestPoint: [0, 0, 0],
    };
};

const _getClosestPointOnPolyHeightResult = createGetPolyHeightResult();

export const getClosestPointOnPoly = (
    result: GetClosestPointOnPolyResult,
    navMesh: NavMesh,
    ref: NodeRef,
    point: Vec3,
): GetClosestPointOnPolyResult => {
    result.success = false;
    result.isOverPoly = false;
    vec3.copy(result.closestPoint, point);

    const tileAndPoly = getTileAndPolyByRef(ref, navMesh);

    if (!tileAndPoly.success) {
        return result;
    }

    result.success = true;

    const { tile, poly, polyIndex } = tileAndPoly;
    const polyHeight = getPolyHeight(_getClosestPointOnPolyHeightResult, tile, poly, polyIndex, point);

    if (polyHeight.success) {
        vec3.copy(result.closestPoint, point);
        result.closestPoint[1] = polyHeight.height;
        result.isOverPoly = true;
        return result;
    }

    getClosestPointOnDetailEdges(result.closestPoint, tile, poly, polyIndex, point, true);

    return result;
};

const _closestPointOnPolyBoundaryLineStart = vec3.create();
const _closestPointOnPolyBoundaryLineEnd = vec3.create();
const _closestPointOnPolyBoundaryVertices: number[] = [];
const _closestPointOnPolyBoundary_distancePtSegSqr2dResult = createDistancePtSegSqr2dResult();

export const getClosestPointOnPolyBoundary = (
    outClosestPoint: Vec3,
    navMesh: NavMesh,
    polyRef: NodeRef,
    point: Vec3,
): boolean => {
    const tileAndPoly = getTileAndPolyByRef(polyRef, navMesh);

    if (!tileAndPoly.success || !vec3.finite(point) || !outClosestPoint) {
        return false;
    }

    const { tile, poly } = tileAndPoly;

    const lineStart = _closestPointOnPolyBoundaryLineStart;
    const lineEnd = _closestPointOnPolyBoundaryLineEnd;

    // collect vertices
    const verticesCount = poly.vertices.length;
    const vertices = _closestPointOnPolyBoundaryVertices;
    for (let i = 0; i < verticesCount; ++i) {
        const vIndex = poly.vertices[i] * 3;
        vertices[i * 3] = tile.vertices[vIndex];
        vertices[i * 3 + 1] = tile.vertices[vIndex + 1];
        vertices[i * 3 + 2] = tile.vertices[vIndex + 2];
    }

    // if inside polygon, return the point as-is
    if (pointInPoly(verticesCount, vertices, point)) {
        vec3.copy(outClosestPoint, point);
        return true;
    }

    // otherwise clamp to nearest edge
    let dmin = Number.MAX_VALUE;
    let imin = 0;
    for (let i = 0; i < verticesCount; ++i) {
        const j = (i + 1) % verticesCount;
        const vaIndex = i * 3;
        const vbIndex = j * 3;
        lineStart[0] = vertices[vaIndex + 0];
        lineStart[1] = vertices[vaIndex + 1];
        lineStart[2] = vertices[vaIndex + 2];
        lineEnd[0] = vertices[vbIndex + 0];
        lineEnd[1] = vertices[vbIndex + 1];
        lineEnd[2] = vertices[vbIndex + 2];
        distancePtSegSqr2d(_closestPointOnPolyBoundary_distancePtSegSqr2dResult, point, lineStart, lineEnd);
        if (_closestPointOnPolyBoundary_distancePtSegSqr2dResult.distSqr < dmin) {
            dmin = _closestPointOnPolyBoundary_distancePtSegSqr2dResult.distSqr;
            imin = i;
        }
    }

    const j = (imin + 1) % verticesCount;
    const vaIndex = imin * 3;
    const vbIndex = j * 3;
    const va0 = vertices[vaIndex + 0];
    const va1 = vertices[vaIndex + 1];
    const va2 = vertices[vaIndex + 2];
    const vb0 = vertices[vbIndex + 0];
    const vb1 = vertices[vbIndex + 1];
    const vb2 = vertices[vbIndex + 2];

    // compute t on segment (xz plane)
    const pqx = vb0 - va0;
    const pqz = vb2 - va2;
    const dx = point[0] - va0;
    const dz = point[2] - va2;
    const denom = pqx * pqx + pqz * pqz;
    let t = denom > 0 ? (pqx * dx + pqz * dz) / denom : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    outClosestPoint[0] = va0 + (vb0 - va0) * t;
    outClosestPoint[1] = va1 + (vb1 - va1) * t;
    outClosestPoint[2] = va2 + (vb2 - va2) * t;

    return true;
};

export type FindNearestPolyResult = {
    success: boolean;
    ref: NodeRef;
    point: Vec3;
};

export const createFindNearestPolyResult = (): FindNearestPolyResult => {
    return {
        success: false,
        ref: 0,
        point: [0, 0, 0],
    };
};

const _findNearestPolyClosestPointResult = createGetClosestPointOnPolyResult();
const _findNearestPolyDiff = vec3.create();
const _findNearestPolyBounds = box3.create();

export const findNearestPoly = (
    result: FindNearestPolyResult,
    navMesh: NavMesh,
    center: Vec3,
    halfExtents: Vec3,
    queryFilter: QueryFilter,
): FindNearestPolyResult => {
    result.success = false;
    result.ref = 0;
    vec3.copy(result.point, center);

    // get bounds for the query
    const bounds = _findNearestPolyBounds;
    vec3.sub(bounds[0], center, halfExtents);
    vec3.add(bounds[1], center, halfExtents);

    // query polygons within the query bounds
    const polys = queryPolygons(navMesh, bounds, queryFilter);

    let nearestDistSqr = Number.MAX_VALUE;

    // find the closest polygon
    for (const ref of polys) {
        const closestPoint = getClosestPointOnPoly(_findNearestPolyClosestPointResult, navMesh, ref, center);

        if (!closestPoint.success) continue;

        const { tileId } = getNodeByRef(navMesh, ref);

        const tile = navMesh.tiles[tileId];

        if (!tile) continue;

        // calculate difference vector
        vec3.sub(_findNearestPolyDiff, center, closestPoint.closestPoint);

        let distSqr: number;

        // if a point is directly over a polygon and closer than
        // climb height, favor that instead of straight line nearest point.
        if (closestPoint.isOverPoly) {
            const heightDiff = Math.abs(_findNearestPolyDiff[1]) - tile.walkableClimb;
            distSqr = heightDiff > 0 ? heightDiff * heightDiff : 0;
        } else {
            distSqr = vec3.squaredLength(_findNearestPolyDiff);
        }

        if (distSqr < nearestDistSqr) {
            nearestDistSqr = distSqr;
            result.ref = ref;
            vec3.copy(result.point, closestPoint.closestPoint);
            result.success = true;
        }
    }

    return result;
};

const _queryPolygonsInTileBmax = vec3.create();
const _queryPolygonsInTileBmin = vec3.create();
const _queryPolygonsInTileVertex = vec3.create();

export const queryPolygonsInTile = (
    out: NodeRef[],
    navMesh: NavMesh,
    tile: NavMeshTile,
    bounds: Box3,
    filter: QueryFilter,
): void => {
    if (tile.bvTree) {
        const qmin = bounds[0];
        const qmax = bounds[1];

        let nodeIndex = 0;
        const endIndex = tile.bvTree.nodes.length;
        const tbmin = tile.bounds[0];
        const tbmax = tile.bounds[1];
        const qfac = tile.bvTree.quantFactor;

        // clamp query box to world box.
        const minx = Math.max(Math.min(qmin[0], tbmax[0]), tbmin[0]) - tbmin[0];
        const miny = Math.max(Math.min(qmin[1], tbmax[1]), tbmin[1]) - tbmin[1];
        const minz = Math.max(Math.min(qmin[2], tbmax[2]), tbmin[2]) - tbmin[2];
        const maxx = Math.max(Math.min(qmax[0], tbmax[0]), tbmin[0]) - tbmin[0];
        const maxy = Math.max(Math.min(qmax[1], tbmax[1]), tbmin[1]) - tbmin[1];
        const maxz = Math.max(Math.min(qmax[2], tbmax[2]), tbmin[2]) - tbmin[2];

        // quantize
        _queryPolygonsInTileBmin[0] = Math.floor(qfac * minx) & 0xfffe;
        _queryPolygonsInTileBmin[1] = Math.floor(qfac * miny) & 0xfffe;
        _queryPolygonsInTileBmin[2] = Math.floor(qfac * minz) & 0xfffe;
        _queryPolygonsInTileBmax[0] = Math.floor(qfac * maxx + 1) | 1;
        _queryPolygonsInTileBmax[1] = Math.floor(qfac * maxy + 1) | 1;
        _queryPolygonsInTileBmax[2] = Math.floor(qfac * maxz + 1) | 1;

        // traverse tree
        while (nodeIndex < endIndex) {
            const bvNode = tile.bvTree.nodes[nodeIndex];

            const nodeBounds = bvNode.bounds;
            const overlap =
                _queryPolygonsInTileBmin[0] <= nodeBounds[1][0] &&
                _queryPolygonsInTileBmax[0] >= nodeBounds[0][0] &&
                _queryPolygonsInTileBmin[1] <= nodeBounds[1][1] &&
                _queryPolygonsInTileBmax[1] >= nodeBounds[0][1] &&
                _queryPolygonsInTileBmin[2] <= nodeBounds[1][2] &&
                _queryPolygonsInTileBmax[2] >= nodeBounds[0][2];

            const isLeafNode = bvNode.i >= 0;

            if (isLeafNode && overlap) {
                const polyIndex = bvNode.i;
                const node = getNodeByTileAndPoly(navMesh, tile, polyIndex);

                if (filter.passFilter(node.ref, navMesh)) {
                    out.push(node.ref);
                }
            }

            if (overlap || isLeafNode) {
                nodeIndex++;
            } else {
                const escapeIndex = -bvNode.i;
                nodeIndex += escapeIndex;
            }
        }
    } else {
        const qmin = bounds[0];
        const qmax = bounds[1];

        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const poly = tile.polys[polyIndex];
            const polyRef = getNodeByTileAndPoly(navMesh, tile, polyIndex).ref;

            // must pass filter
            if (!filter.passFilter(polyRef, navMesh)) {
                continue;
            }

            // calc polygon bounds
            const firstVertexIndex = poly.vertices[0];
            vec3.fromBuffer(_queryPolygonsInTileVertex, tile.vertices, firstVertexIndex * 3);
            vec3.copy(_queryPolygonsInTileBmax, _queryPolygonsInTileVertex);
            vec3.copy(_queryPolygonsInTileBmin, _queryPolygonsInTileVertex);

            for (let j = 1; j < poly.vertices.length; j++) {
                const vertexIndex = poly.vertices[j];
                vec3.fromBuffer(_queryPolygonsInTileVertex, tile.vertices, vertexIndex * 3);
                vec3.min(_queryPolygonsInTileBmin, _queryPolygonsInTileBmin, _queryPolygonsInTileVertex);
                vec3.max(_queryPolygonsInTileBmax, _queryPolygonsInTileBmax, _queryPolygonsInTileVertex);
            }

            // check overlap with query bounds
            if (
                qmin[0] <= _queryPolygonsInTileBmax[0] &&
                qmax[0] >= _queryPolygonsInTileBmin[0] &&
                qmin[1] <= _queryPolygonsInTileBmax[1] &&
                qmax[1] >= _queryPolygonsInTileBmin[1] &&
                qmin[2] <= _queryPolygonsInTileBmax[2] &&
                qmax[2] >= _queryPolygonsInTileBmin[2]
            ) {
                out.push(polyRef);
            }
        }
    }
};

const _queryPolygonsMinTile = vec2.create();
const _queryPolygonsMaxTile = vec2.create();

export const queryPolygons = (navMesh: NavMesh, bounds: Box3, filter: QueryFilter): NodeRef[] => {
    const result: NodeRef[] = [];

    // find min and max tile positions
    const minTile = worldToTilePosition(_queryPolygonsMinTile, navMesh, bounds[0]);
    const maxTile = worldToTilePosition(_queryPolygonsMaxTile, navMesh, bounds[1]);

    // iterate through the tiles in the query bounds
    if (!vec2.finite(minTile) || !vec2.finite(maxTile)) {
        return result;
    }

    for (let x = minTile[0]; x <= maxTile[0]; x++) {
        for (let y = minTile[1]; y <= maxTile[1]; y++) {
            const tiles = getTilesAt(navMesh, x, y);

            for (const tile of tiles) {
                queryPolygonsInTile(result, navMesh, tile, bounds, filter);
            }
        }
    }

    return result;
};

const allocateNode = (navMesh: NavMesh) => {
    const nodeIndex = requestIndex(navMesh.nodeIndexPool);

    let node = navMesh.nodes[nodeIndex];

    if (!node) {
        node = navMesh.nodes[nodeIndex] = {
            allocated: true,
            index: nodeIndex,
            ref: 0,
            area: 0,
            flags: 0,
            links: [],
            type: 0,
            tileId: -1,
            polyIndex: -1,
            offMeshConnectionId: -1,
            offMeshConnectionSide: -1,
        };
    }

    return node;
};

const releaseNode = (navMesh: NavMesh, index: number) => {
    const node = navMesh.nodes[index];
    node.allocated = false;
    node.links.length = 0;
    node.ref = 0;
    node.type = 0;
    node.area = -1;
    node.flags = -1;
    node.tileId = -1;
    node.polyIndex = -1;
    node.offMeshConnectionId = -1;
    node.offMeshConnectionSide = -1;
    releaseIndex(navMesh.nodeIndexPool, index);
};

/**
 * Allocates a link and returns it's index
 */
const allocateLink = (navMesh: NavMesh) => {
    const linkIndex = requestIndex(navMesh.linkIndexPool);

    let link = navMesh.links[linkIndex];

    if (!link) {
        link = navMesh.links[linkIndex] = {
            allocated: true,
            id: 0,
            fromNodeIndex: 0,
            fromNodeRef: 0,
            toNodeIndex: 0,
            toNodeRef: 0,
            edge: 0,
            side: 0,
            bmin: 0,
            bmax: 0,
        };
    }

    link.allocated = true;
    link.id = linkIndex;

    return linkIndex;
};

/**
 * Releases a link
 */
const releaseLink = (navMesh: NavMesh, index: number) => {
    navMesh.links[index].allocated = false;
    releaseIndex(navMesh.linkIndexPool, index);
};

const connectInternalLinks = (navMesh: NavMesh, tile: NavMeshTile) => {
    // create links between polygons within the tile
    // based on the neighbor information stored in each polygon

    for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
        const poly = tile.polys[polyIndex];
        const node = getNodeByTileAndPoly(navMesh, tile, polyIndex);

        for (let edgeIndex = 0; edgeIndex < poly.vertices.length; edgeIndex++) {
            const neiValue = poly.neis[edgeIndex];

            // skip external links and border edges
            if (neiValue === 0 || neiValue & POLY_NEIS_FLAG_EXT_LINK) {
                continue;
            }

            // internal connection - create link
            const neighborPolyIndex = neiValue - 1; // convert back to 0-based indexing

            if (neighborPolyIndex >= 0 && neighborPolyIndex < tile.polys.length) {
                const linkIndex = allocateLink(navMesh);
                const link = navMesh.links[linkIndex];

                const neighbourNode = getNodeByTileAndPoly(navMesh, tile, neighborPolyIndex);

                link.fromNodeIndex = node.index;
                link.fromNodeRef = node.ref;
                link.toNodeIndex = neighbourNode.index;
                link.toNodeRef = neighbourNode.ref;
                link.edge = edgeIndex; // edge index in current polygon
                link.side = 0xff; // not a boundary link
                link.bmin = 0; // not used for internal links
                link.bmax = 0; // not used for internal links

                node.links.push(linkIndex);
            }
        }
    }
};

const oppositeTile = (side: number): number => (side + 4) & 0x7;

// Compute a scalar coordinate along the primary axis for the slab
const getSlabCoord = (v: Vec3, side: number): number => {
    if (side === 0 || side === 4) return v[0]; // x portals measure by x
    if (side === 2 || side === 6) return v[2]; // z portals measure by z
    return 0;
};

// Calculate 2D endpoints (u,y) for edge segment projected onto the portal axis plane.
// For x-portals (side 0/4) we use u = z, for z-portals (2/6) u = x.
const calcSlabEndPoints = (va: Vec3, vb: Vec3, bmin: Vec3, bmax: Vec3, side: number) => {
    if (side === 0 || side === 4) {
        if (va[2] < vb[2]) {
            bmin[0] = va[2];
            bmin[1] = va[1];
            bmax[0] = vb[2];
            bmax[1] = vb[1];
        } else {
            bmin[0] = vb[2];
            bmin[1] = vb[1];
            bmax[0] = va[2];
            bmax[1] = va[1];
        }
    } else if (side === 2 || side === 6) {
        if (va[0] < vb[0]) {
            bmin[0] = va[0];
            bmin[1] = va[1];
            bmax[0] = vb[0];
            bmax[1] = vb[1];
        } else {
            bmin[0] = vb[0];
            bmin[1] = vb[1];
            bmax[0] = va[0];
            bmax[1] = va[1];
        }
    }
};

// Overlap test of two edge slabs in (u,y) space, with tolerances px (horizontal pad) and py (vertical threshold)
const overlapSlabs = (amin: Vec3, amax: Vec3, bmin: Vec3, bmax: Vec3, px: number, py: number): boolean => {
    const minx = Math.max(amin[0] + px, bmin[0] + px);
    const maxx = Math.min(amax[0] - px, bmax[0] - px);
    if (minx > maxx) return false; // no horizontal overlap

    // Vertical overlap test via line interpolation along u
    const ad = (amax[1] - amin[1]) / (amax[0] - amin[0]);
    const ak = amin[1] - ad * amin[0];
    const bd = (bmax[1] - bmin[1]) / (bmax[0] - bmin[0]);
    const bk = bmin[1] - bd * bmin[0];
    const aminy = ad * minx + ak;
    const amaxy = ad * maxx + ak;
    const bminy = bd * minx + bk;
    const bmaxy = bd * maxx + bk;
    const dmin = bminy - aminy;
    const dmax = bmaxy - amaxy;
    if (dmin * dmax < 0) return true; // crossing
    const thr = py * 2 * (py * 2);
    if (dmin * dmin <= thr || dmax * dmax <= thr) return true; // near endpoints
    return false;
};

const _amin = vec3.create();
const _amax = vec3.create();
const _bmin = vec3.create();
const _bmax = vec3.create();

/**
 * Find connecting external polys between edge va->vb in target tile on opposite side.
 * Returns array of { ref, tmin, tmax } describing overlapping intervals along the edge.
 * @param va vertex A
 * @param vb vertex B
 * @param target target tile
 * @param side portal side
 * @returns array of connecting polygons
 */
const findConnectingPolys = (
    navMesh: NavMesh,
    va: Vec3,
    vb: Vec3,
    target: NavMeshTile | undefined,
    side: number,
): { ref: NodeRef; umin: number; umax: number }[] => {
    if (!target) return [];
    calcSlabEndPoints(va, vb, _amin, _amax, side); // store u,y
    const apos = getSlabCoord(va, side);

    const results: { ref: NodeRef; umin: number; umax: number }[] = [];

    // iterate target polys & their boundary edges (those marked ext link in that direction)
    for (let i = 0; i < target.polys.length; i++) {
        const poly = target.polys[i];
        const nv = poly.vertices.length;
        for (let j = 0; j < nv; j++) {
            const nei = poly.neis[j];

            // not an external edge
            if ((nei & POLY_NEIS_FLAG_EXT_LINK) === 0) continue;

            const dir = nei & POLY_NEIS_FLAG_EXT_LINK_DIR_MASK;

            // only edges that face the specified side from target perspective
            if (dir !== side) continue;

            const vcIndex = poly.vertices[j];
            const vdIndex = poly.vertices[(j + 1) % nv];
            const vc: Vec3 = [target.vertices[vcIndex * 3], target.vertices[vcIndex * 3 + 1], target.vertices[vcIndex * 3 + 2]];
            const vd: Vec3 = [target.vertices[vdIndex * 3], target.vertices[vdIndex * 3 + 1], target.vertices[vdIndex * 3 + 2]];

            const bpos = getSlabCoord(vc, side);

            // not co-planar enough
            if (Math.abs(apos - bpos) > 0.01) continue;

            calcSlabEndPoints(vc, vd, _bmin, _bmax, side);
            if (!overlapSlabs(_amin, _amax, _bmin, _bmax, 0.01, target.walkableClimb)) continue;

            // record overlap interval
            const polyRef = getNodeByTileAndPoly(navMesh, target, i).ref;

            results.push({
                ref: polyRef,
                umin: Math.max(_amin[0], _bmin[0]),
                umax: Math.min(_amax[0], _bmax[0]),
            });

            // proceed to next polygon (edge matched)
            break;
        }
    }
    return results;
};

const _va = vec3.create();
const _vb = vec3.create();

const connectExternalLinks = (navMesh: NavMesh, tile: NavMeshTile, target: NavMeshTile, side: number) => {
    // connect border links
    for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
        const poly = tile.polys[polyIndex];

        // get the node for this poly
        const node = getNodeByTileAndPoly(navMesh, tile, polyIndex);

        const nv = poly.vertices.length;

        for (let j = 0; j < nv; j++) {
            // skip non-portal edges
            if ((poly.neis[j] & POLY_NEIS_FLAG_EXT_LINK) === 0) {
                continue;
            }

            const dir = poly.neis[j] & POLY_NEIS_FLAG_EXT_LINK_DIR_MASK;
            if (side !== -1 && dir !== side) {
                continue;
            }

            // create new links
            const va = vec3.fromBuffer(_va, tile.vertices, poly.vertices[j] * 3);
            const vb = vec3.fromBuffer(_vb, tile.vertices, poly.vertices[(j + 1) % nv] * 3);

            // find overlaps against target tile along the opposite side direction
            const overlaps = findConnectingPolys(navMesh, va, vb, target, oppositeTile(dir));

            for (const o of overlaps) {
                // parameterize overlap interval along this edge to [0,1]
                let tmin: number;
                let tmax: number;

                if (dir === 0 || dir === 4) {
                    // x portals param by z
                    tmin = (o.umin - va[2]) / (vb[2] - va[2]);
                    tmax = (o.umax - va[2]) / (vb[2] - va[2]);
                } else {
                    // z portals param by x
                    tmin = (o.umin - va[0]) / (vb[0] - va[0]);
                    tmax = (o.umax - va[0]) / (vb[0] - va[0]);
                }

                if (tmin > tmax) {
                    const tmp = tmin;
                    tmin = tmax;
                    tmax = tmp;
                }

                tmin = Math.max(0, Math.min(1, tmin));
                tmax = Math.max(0, Math.min(1, tmax));

                const linkIndex = allocateLink(navMesh);
                const link = navMesh.links[linkIndex];

                link.fromNodeIndex = node.index;
                link.fromNodeRef = node.ref;
                link.toNodeIndex = getNodeRefIndex(o.ref);
                link.toNodeRef = o.ref;
                link.edge = j;
                link.side = dir;
                link.bmin = Math.round(tmin * 255);
                link.bmax = Math.round(tmax * 255);

                node.links.push(linkIndex);
            }
        }
    }
};

/**
 * Disconnect external links from tile to target tile
 */
const disconnectExternalLinks = (navMesh: NavMesh, tile: NavMeshTile, target: NavMeshTile) => {
    const targetId = target.id;

    for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
        const node = getNodeByTileAndPoly(navMesh, tile, polyIndex);

        const filteredLinks: number[] = [];

        for (let k = 0; k < node.links.length; k++) {
            const linkIndex = node.links[k];
            const link = navMesh.links[linkIndex];

            const neiNode = getNodeByRef(navMesh, link.toNodeRef);

            if (neiNode.tileId === targetId) {
                releaseLink(navMesh, linkIndex);
            } else {
                filteredLinks.push(linkIndex);
            }
        }

        node.links = filteredLinks;
    }
};

const disconnectOffMeshConnection = (navMesh: NavMesh, offMeshConnection: OffMeshConnection): boolean => {
    const offMeshConnectionState = navMesh.offMeshConnectionAttachments[offMeshConnection.id];

    // the off mesh connection is not connected, return false
    if (!offMeshConnectionState) return false;

    const offMeshConnectionStartNodeRef = offMeshConnectionState.startOffMeshNode;
    const offMeshConnectionEndNodeRef = offMeshConnectionState.endOffMeshNode;
    const startPolyNode = offMeshConnectionState.startPolyNode;
    const endPolyNode = offMeshConnectionState.endPolyNode;

    // release any links in the start and end polys that reference off mesh connection nodes
    const startNode = getNodeByRef(navMesh, startPolyNode);

    if (startNode) {
        for (let i = startNode.links.length - 1; i >= 0; i--) {
            const linkId = startNode.links[i];
            const link = navMesh.links[linkId];
            if (link.toNodeRef === offMeshConnectionStartNodeRef || link.toNodeRef === offMeshConnectionEndNodeRef) {
                releaseLink(navMesh, linkId);
                startNode.links.splice(i, 1);
            }
        }
    }

    const endNode = getNodeByRef(navMesh, endPolyNode);

    if (endNode) {
        for (let i = endNode.links.length - 1; i >= 0; i--) {
            const linkId = endNode.links[i];
            const link = navMesh.links[linkId];
            if (link.toNodeRef === offMeshConnectionStartNodeRef || link.toNodeRef === offMeshConnectionEndNodeRef) {
                releaseLink(navMesh, linkId);
                endNode.links.splice(i, 1);
            }
        }
    }

    // release the off mesh connection nodes links
    const offMeshStartNode = getNodeByRef(navMesh, offMeshConnectionStartNodeRef);

    if (offMeshStartNode) {
        for (let i = offMeshStartNode.links.length - 1; i >= 0; i--) {
            const linkId = offMeshStartNode.links[i];
            releaseLink(navMesh, linkId);
        }
    }

    const offMeshEndNode = getNodeByRef(navMesh, offMeshConnectionEndNodeRef);

    if (offMeshEndNode) {
        for (let i = offMeshEndNode.links.length - 1; i >= 0; i--) {
            const linkId = offMeshEndNode.links[i];
            releaseLink(navMesh, linkId);
        }
    }

    // remove the off mesh connection nodes
    releaseNode(navMesh, getNodeRefIndex(offMeshConnectionStartNodeRef));
    releaseNode(navMesh, getNodeRefIndex(offMeshConnectionEndNodeRef));

    // remove the off mesh connection state
    delete navMesh.offMeshConnectionAttachments[offMeshConnection.id];

    // the off mesh connection was disconnected, return true
    return true;
};

const _connectOffMeshConnectionNearestPolyStart = createFindNearestPolyResult();
const _connectOffMeshConnectionNearestPolyEnd = createFindNearestPolyResult();

const connectOffMeshConnection = (navMesh: NavMesh, offMeshConnection: OffMeshConnection): boolean => {
    // find polys for the start and end positions
    const startTilePolyResult = findNearestPoly(
        _connectOffMeshConnectionNearestPolyStart,
        navMesh,
        offMeshConnection.start,
        [offMeshConnection.radius, offMeshConnection.radius, offMeshConnection.radius],
        DEFAULT_QUERY_FILTER,
    );

    const endTilePolyResult = findNearestPoly(
        _connectOffMeshConnectionNearestPolyEnd,
        navMesh,
        offMeshConnection.end,
        [offMeshConnection.radius, offMeshConnection.radius, offMeshConnection.radius],
        DEFAULT_QUERY_FILTER,
    );

    // exit if we couldn't find a start or an end poly, can't connect off mesh connection
    if (!startTilePolyResult.success || !endTilePolyResult.success) {
        return false;
    }

    // get start and end poly nodes
    const startNodeRef = startTilePolyResult.ref;
    const startNode = getNodeByRef(navMesh, startNodeRef);

    const endNodeRef = endTilePolyResult.ref;
    const endNode = getNodeByRef(navMesh, endNodeRef);

    const offMeshConnectionState: OffMeshConnectionAttachment = {
        startOffMeshNode: 0,
        endOffMeshNode: 0,
        startPolyNode: startNodeRef,
        endPolyNode: endNodeRef,
    };

    // create a node for the off mesh connection start
    const offMeshStartNode = allocateNode(navMesh);
    const offMeshStartNodeRef = serNodeRef(NodeType.OFFMESH, offMeshStartNode.index, offMeshConnection.sequence);
    offMeshStartNode.type = NodeType.OFFMESH;
    offMeshStartNode.ref = offMeshStartNodeRef;
    offMeshStartNode.area = offMeshConnection.area;
    offMeshStartNode.flags = offMeshConnection.flags;
    offMeshStartNode.offMeshConnectionId = offMeshConnection.id;
    offMeshStartNode.offMeshConnectionSide = OffMeshConnectionSide.START;

    offMeshConnectionState.startOffMeshNode = offMeshStartNodeRef;

    // link the start poly to the off mesh node start
    const startPolyToOffMeshStartLinkIndex = allocateLink(navMesh);
    const startPolyToOffMeshStartLink = navMesh.links[startPolyToOffMeshStartLinkIndex];
    startPolyToOffMeshStartLink.fromNodeRef = startNode.ref;
    startPolyToOffMeshStartLink.fromNodeIndex = startNode.index;
    startPolyToOffMeshStartLink.toNodeRef = offMeshStartNode.ref;
    startPolyToOffMeshStartLink.toNodeIndex = offMeshStartNode.index;
    startPolyToOffMeshStartLink.bmin = 0; // not used for offmesh links
    startPolyToOffMeshStartLink.bmax = 0; // not used for offmesh links
    startPolyToOffMeshStartLink.side = 0; // not used for offmesh links
    startPolyToOffMeshStartLink.edge = 0; // not used for offmesh links
    startNode.links.push(startPolyToOffMeshStartLinkIndex);

    // link the off mesh start node to the end poly
    const offMeshStartToEndPolyLinkIndex = allocateLink(navMesh);
    const offMeshStartToEndPolyLink = navMesh.links[offMeshStartToEndPolyLinkIndex];
    offMeshStartToEndPolyLink.fromNodeIndex = offMeshStartNode.index;
    offMeshStartToEndPolyLink.fromNodeRef = offMeshStartNode.ref;
    offMeshStartToEndPolyLink.toNodeIndex = endNode.index;
    offMeshStartToEndPolyLink.toNodeRef = endNode.ref;
    offMeshStartToEndPolyLink.bmin = 0; // not used for offmesh links
    offMeshStartToEndPolyLink.bmax = 0; // not used for offmesh links
    offMeshStartToEndPolyLink.side = 0; // not used for offmesh links
    offMeshStartToEndPolyLink.edge = 0; // not used for offmesh links
    offMeshStartNode.links.push(offMeshStartToEndPolyLinkIndex);

    if (offMeshConnection.direction === OffMeshConnectionDirection.BIDIRECTIONAL) {
        // create a node for the off mesh connection end
        const offMeshEndNode = allocateNode(navMesh);
        const offMeshEndNodeRef = serNodeRef(NodeType.OFFMESH, offMeshEndNode.index, offMeshConnection.sequence);
        offMeshEndNode.type = NodeType.OFFMESH;
        offMeshEndNode.ref = offMeshEndNodeRef;
        offMeshEndNode.area = offMeshConnection.area;
        offMeshEndNode.flags = offMeshConnection.flags;
        offMeshEndNode.offMeshConnectionId = offMeshConnection.id;
        offMeshEndNode.offMeshConnectionSide = OffMeshConnectionSide.END;

        // link the end poly node to the off mesh end node
        const endPolyToOffMeshEndLinkIndex = allocateLink(navMesh);
        const endPolyToOffMeshEndLink = navMesh.links[endPolyToOffMeshEndLinkIndex];
        endPolyToOffMeshEndLink.fromNodeIndex = endNode.index;
        endPolyToOffMeshEndLink.fromNodeRef = endNode.ref;
        endPolyToOffMeshEndLink.toNodeIndex = offMeshEndNode.index;
        endPolyToOffMeshEndLink.toNodeRef = offMeshEndNode.ref;
        endPolyToOffMeshEndLink.bmin = 0; // not used for offmesh links
        endPolyToOffMeshEndLink.bmax = 0; // not used for offmesh links
        endPolyToOffMeshEndLink.side = 0; // not used for offmesh links
        endPolyToOffMeshEndLink.edge = 0; // not used for offmesh links
        endNode.links.push(endPolyToOffMeshEndLinkIndex);

        // link the off mesh end node to the start poly node
        const offMeshEndToStartPolyLinkIndex = allocateLink(navMesh);
        const offMeshEndToStartPolyLink = navMesh.links[offMeshEndToStartPolyLinkIndex];
        offMeshEndToStartPolyLink.fromNodeIndex = offMeshEndNode.index;
        offMeshEndToStartPolyLink.fromNodeRef = offMeshEndNode.ref;
        offMeshEndToStartPolyLink.toNodeIndex = startNode.index;
        offMeshEndToStartPolyLink.toNodeRef = startNode.ref;
        offMeshEndToStartPolyLink.bmin = 0; // not used for offmesh links
        offMeshEndToStartPolyLink.bmax = 0; // not used for offmesh links
        offMeshEndToStartPolyLink.side = 0; // not used for offmesh links
        offMeshEndToStartPolyLink.edge = 0; // not used for offmesh links
        offMeshEndNode.links.push(offMeshEndToStartPolyLinkIndex);
    }

    // store off mesh connection state, for quick revalidation of connections when adding and removing tiles
    navMesh.offMeshConnectionAttachments[offMeshConnection.id] = offMeshConnectionState;

    // connected the off mesh connection, return true
    return true;
};

/**
 * Reconnects an off mesh connection. This must be called if any properties of an off mesh connection are changed, for example the start or end positions.
 * @param navMesh the navmesh
 * @param offMeshConnectionId the ID of the off mesh connection to reconnect
 * @returns whether the off mesh connection was successfully reconnected
 */
export const reconnectOffMeshConnection = (navMesh: NavMesh, offMeshConnection: OffMeshConnection): boolean => {
    disconnectOffMeshConnection(navMesh, offMeshConnection);
    return connectOffMeshConnection(navMesh, offMeshConnection);
};

const updateOffMeshConnections = (navMesh: NavMesh) => {
    for (const id in navMesh.offMeshConnections) {
        const offMeshConnection = navMesh.offMeshConnections[id];
        const connected = isOffMeshConnectionConnected(navMesh, offMeshConnection.id);

        if (!connected) {
            reconnectOffMeshConnection(navMesh, offMeshConnection);
        }
    }
};

export const addTile = (navMesh: NavMesh, tileParams: NavMeshTileParams): NavMeshTile => {
    const tilePositionHash = getTilePositionHash(tileParams.tileX, tileParams.tileY, tileParams.tileLayer);

    // remove any existing tile at the same position
    if (navMesh.tilePositionToTileId[tilePositionHash] !== undefined) {
        removeTile(navMesh, tileParams.tileX, tileParams.tileY, tileParams.tileLayer);
    }

    // tile sequence
    let sequence = navMesh.tilePositionToSequenceCounter[tilePositionHash];
    if (sequence === undefined) {
        sequence = 0;
    } else {
        sequence = (sequence + 1) % MAX_SEQUENCE;
    }

    navMesh.tilePositionToSequenceCounter[tilePositionHash] = sequence;

    // get tile id
    const id = requestIndex(navMesh.tileIndexPool);

    // create tile
    const tile: NavMeshTile = {
        ...tileParams,
        id,
        sequence,
        polyNodes: [],
    };

    // store tile in navmesh
    navMesh.tiles[tile.id] = tile;

    // store position lookup
    navMesh.tilePositionToTileId[tilePositionHash] = tile.id;

    // store column lookup
    const tileColumnHash = getTileColumnHash(tileParams.tileX, tileParams.tileY);
    if (!navMesh.tileColumnToTileIds[tileColumnHash]) {
        navMesh.tileColumnToTileIds[tileColumnHash] = [];
    }
    navMesh.tileColumnToTileIds[tileColumnHash].push(tile.id);

    // allocate nodes
    for (let i = 0; i < tile.polys.length; i++) {
        const node = allocateNode(navMesh);

        node.ref = serNodeRef(NodeType.POLY, node.index, tile.sequence);
        node.type = NodeType.POLY;
        node.area = tile.polys[i].area;
        node.flags = tile.polys[i].flags;
        node.tileId = tile.id;
        node.polyIndex = i;
        node.links.length = 0;

        tile.polyNodes.push(node.index);
    }

    // create internal links within the tile
    connectInternalLinks(navMesh, tile);

    // connect with layers in current tile.
    const tilesAtCurrentPosition = getTilesAt(navMesh, tile.tileX, tile.tileY);

    for (const tileAtCurrentPosition of tilesAtCurrentPosition) {
        if (tileAtCurrentPosition.id === tile.id) continue;

        connectExternalLinks(navMesh, tileAtCurrentPosition, tile, -1);
        connectExternalLinks(navMesh, tile, tileAtCurrentPosition, -1);
    }

    // connect with neighbouring tiles
    for (let side = 0; side < 8; side++) {
        const neighbourTiles = getNeighbourTilesAt(navMesh, tile.tileX, tile.tileY, side);

        for (const neighbourTile of neighbourTiles) {
            connectExternalLinks(navMesh, tile, neighbourTile, side);
            connectExternalLinks(navMesh, neighbourTile, tile, oppositeTile(side));
        }
    }

    // update off mesh connections
    updateOffMeshConnections(navMesh);

    return tile;
};

/**
 * Removes the tile at the given location
 * @param navMesh the navmesh to remove the tile from
 * @param x the x coordinate of the tile
 * @param y the y coordinate of the tile
 * @param layer the layer of the tile
 * @returns true if the tile was removed, otherwise false
 */
export const removeTile = (navMesh: NavMesh, x: number, y: number, layer: number): boolean => {
    const tileHash = getTilePositionHash(x, y, layer);
    const tileId = navMesh.tilePositionToTileId[tileHash];
    const tile = navMesh.tiles[tileId];

    if (!tile) {
        return false;
    }

    // disconnect external links with tiles in the same layer
    const tilesAtCurrentPosition = getTilesAt(navMesh, x, y);

    for (const tileAtCurrentPosition of tilesAtCurrentPosition) {
        if (tileAtCurrentPosition.id === tileId) continue;

        disconnectExternalLinks(navMesh, tileAtCurrentPosition, tile);
        disconnectExternalLinks(navMesh, tile, tileAtCurrentPosition);
    }

    // disconnect external links with neighbouring tiles
    for (let side = 0; side < 8; side++) {
        const neighbourTiles = getNeighbourTilesAt(navMesh, x, y, side);

        for (const neighbourTile of neighbourTiles) {
            disconnectExternalLinks(navMesh, neighbourTile, tile);
            disconnectExternalLinks(navMesh, tile, neighbourTile);
        }
    }

    // release internal links
    for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
        const node = getNodeByTileAndPoly(navMesh, tile, polyIndex);

        for (const link of node.links) {
            releaseLink(navMesh, link);
        }
    }

    // release nodes
    for (let i = 0; i < tile.polyNodes.length; i++) {
        releaseNode(navMesh, tile.polyNodes[i]);
    }
    tile.polyNodes.length = 0;

    // remove tile from navmesh
    delete navMesh.tiles[tileId];

    // remove position lookup
    delete navMesh.tilePositionToTileId[tileHash];

    // remove column lookup
    const tileColumnHash = getTileColumnHash(x, y);
    const tileColumn = navMesh.tileColumnToTileIds[tileColumnHash];
    if (tileColumn) {
        const tileIndexInColumn = tileColumn.indexOf(tileId);
        if (tileIndexInColumn !== -1) {
            tileColumn.splice(tileIndexInColumn, 1);
        }
        if (tileColumn.length === 0) {
            delete navMesh.tileColumnToTileIds[tileColumnHash];
        }
    }

    // release tile index to the pool
    releaseIndex(navMesh.tileIndexPool, tileId);

    // update off mesh connections
    updateOffMeshConnections(navMesh);

    return true;
};

/**
 * Adds a new off mesh connection to the NavMesh, and returns it's ID
 * @param navMesh the navmesh to add the off mesh connection to
 * @param offMeshConnection the off mesh connection to add
 * @returns the ID of the added off mesh connection
 */
export const addOffMeshConnection = (navMesh: NavMesh, offMeshConnectionParams: OffMeshConnectionParams): number => {
    const id = requestIndex(navMesh.offMeshConnectionIndexPool);

    const sequence = navMesh.offMeshConnectionSequenceCounter;
    navMesh.offMeshConnectionSequenceCounter = (navMesh.offMeshConnectionSequenceCounter + 1) % MAX_SEQUENCE;

    const offMeshConnection: OffMeshConnection = {
        ...offMeshConnectionParams,
        id,
        sequence,
    };

    navMesh.offMeshConnections[id] = offMeshConnection;

    connectOffMeshConnection(navMesh, offMeshConnection);

    return id;
};

/**
 * Removes an off mesh connection from the NavMesh
 * @param navMesh the navmesh to remove the off mesh connection from
 * @param offMeshConnectionId the ID of the off mesh connection to remove
 */
export const removeOffMeshConnection = (navMesh: NavMesh, offMeshConnectionId: number): void => {
    const offMeshConnection = navMesh.offMeshConnections[offMeshConnectionId];

    if (!offMeshConnection) return;

    releaseIndex(navMesh.offMeshConnectionIndexPool, offMeshConnection.id);

    disconnectOffMeshConnection(navMesh, offMeshConnection);

    delete navMesh.offMeshConnections[offMeshConnection.id];
};

export const isOffMeshConnectionConnected = (navMesh: NavMesh, offMeshConnectionId: number): boolean => {
    const offMeshConnectionState = navMesh.offMeshConnectionAttachments[offMeshConnectionId];

    // no off mesh connection state, not connected
    if (!offMeshConnectionState) return false;

    const { startPolyNode: startPolyRef, endPolyNode: endPolyRef } = offMeshConnectionState;

    const { tileId: startTileId } = getNodeByRef(navMesh, startPolyRef);
    const { tileId: endTileId } = getNodeByRef(navMesh, endPolyRef);

    // is connected if the tile ids are still valid
    return !!navMesh.tiles[startTileId] && !!navMesh.tiles[endTileId];
};

export type QueryFilter = {
    /**
     * Checks if a NavMesh node passes the filter.
     * @param ref The node reference.
     * @param navMesh The navmesh
     * @returns Whether the node reference passes the filter.
     */
    passFilter(nodeRef: NodeRef, navMesh: NavMesh): boolean;

    /**
     * Calculates the cost of moving from one point to another.
     * @param pa The start position on the edge of the previous and current node. [(x, y, z)]
     * @param pb The end position on the edge of the current and next node. [(x, y, z)]
     * @param navMesh The navigation mesh
     * @param prevRef The reference id of the previous node. [opt]
     * @param curRef The reference id of the current node.
     * @param nextRef The reference id of the next node. [opt]
     * @returns The cost of moving from the start to the end position.
     */
    getCost(
        pa: Vec3,
        pb: Vec3,
        navMesh: NavMesh,
        prevRef: NodeRef | undefined,
        curRef: NodeRef,
        nextRef: NodeRef | undefined,
    ): number;
};

export const ANY_QUERY_FILTER = {
    getCost(pa, pb, _navMesh, _prevRef, _curRef, _nextRef) {
        // use the distance between the two points as the cost
        return vec3.distance(pa, pb);
    },
    passFilter(_nodeRef: NodeRef, _navMesh: NavMesh): boolean {
        return true;
    },
} satisfies QueryFilter;

export type DefaultQueryFilter = QueryFilter & {
    includeFlags: number;
    excludeFlags: number;
};

export const DEFAULT_QUERY_FILTER = {
    includeFlags: 0xffffffff,
    excludeFlags: 0,
    getCost(pa, pb, _navMesh, _prevRef, _curRef, _nextRef) {
        // use the distance between the two points as the cost
        return vec3.distance(pa, pb);
    },
    passFilter(nodeRef, navMesh) {
        // check whether the node's flags pass 'includeFlags' and 'excludeFlags' checks
        const { flags } = getNodeByRef(navMesh, nodeRef);

        return (flags & this.includeFlags) !== 0 && (flags & this.excludeFlags) === 0;
    },
} satisfies DefaultQueryFilter;
