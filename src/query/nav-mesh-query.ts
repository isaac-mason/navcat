import type { Box3, Triangle3, Vec3 } from 'maaths';
import { box3, vec2, vec3 } from 'maaths';
import {
    closestHeightPointTriangle,
    closestPtSeg2d,
    distancePtSeg2d,
    distancePtSeg2dSqr,
    pointInPoly,
} from '../geometry';
import {
    getTilesAt,
    type NavMesh,
    type NavMeshPoly,
    type NavMeshTile,
    worldToTilePosition,
} from './nav-mesh';
import {
    desNodeRef,
    getNodeRefType,
    type NodeRef,
    NodeType,
    serPolyNodeRef,
} from './node';
import type { QueryFilter } from './query-filter';

export type GetNodeAreaAndFlagsResult = {
    success: boolean;
    area: number;
    flags: number;
};

export const getNodeAreaAndFlags = (
    nodeRef: NodeRef,
    navMesh: NavMesh,
): GetNodeAreaAndFlagsResult => {
    const result: GetNodeAreaAndFlagsResult = {
        success: false,
        flags: 0,
        area: 0,
    };

    const nodeType = getNodeRefType(nodeRef);

    if (nodeType === NodeType.GROUND_POLY) {
        const [, tileId, polyIndex] = desNodeRef(nodeRef);
        const poly = navMesh.tiles[tileId].polys[polyIndex];
        result.flags = poly.flags;
        result.area = poly.area;
        result.success = true;
    } else if (nodeType === NodeType.OFFMESH_CONNECTION) {
        const [, offMeshConnectionId] = desNodeRef(nodeRef);
        const offMeshConnection =
            navMesh.offMeshConnections[offMeshConnectionId];
        result.flags = offMeshConnection.flags;
        result.area = offMeshConnection.area;
        result.success = true;
    }

    return result;
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
export const getTileAndPolyByRef = (
    ref: NodeRef,
    navMesh: NavMesh,
): GetTileAndPolyByRefResult => {
    const result = {
        success: false,
        tile: null,
        poly: null,
        polyIndex: -1,
    } as GetTileAndPolyByRefResult;

    const [nodeType, tileId, nodeIndex] = desNodeRef(ref);

    if (nodeType !== NodeType.GROUND_POLY) return result;

    const tile = navMesh.tiles[tileId];

    if (!tile) {
        return result;
    }

    if (nodeIndex >= tile.polys.length) {
        return result;
    }

    result.poly = tile.polys[nodeIndex];
    result.tile = tile;
    result.polyIndex = nodeIndex;
    result.success = true;

    return result;
};

export type GetPolyHeightResult = {
    success: boolean;
    height: number;
}

export const createGetPolyHeightResult = (): GetPolyHeightResult => ({
    success: false,
    height: 0,
});

const _getPolyHeightA = vec3.create();
const _getPolyHeightB = vec3.create();
const _getPolyHeightC = vec3.create();
const _getPolyHeightTriangle: Triangle3 = [_getPolyHeightA, _getPolyHeightB, _getPolyHeightC];

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
    // TODO: can we avoid allocations here?
    const nv = poly.vertices.length;
    const verts = new Array<number>(nv * 3);
    for (let i = 0; i < nv; ++i) {
        const vertIndex = poly.vertices[i] * 3;
        verts[i * 3 + 0] = tile.vertices[vertIndex + 0];
        verts[i * 3 + 1] = tile.vertices[vertIndex + 1];
        verts[i * 3 + 2] = tile.vertices[vertIndex + 2];
    }
    
    // check if point is inside polygon (matches C++ dtPointInPolygon(pos, verts, nv))
    if (!pointInPoly(nv, verts, pos)) {
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
    closestPointOnDetailEdges(tile, poly, detailMesh, pos, closest, false);
    result.success = true;
    result.height = closest[1];

    return result;
};

// boundary edge flags
const DETAIL_EDGE_BOUNDARY = 0x01;

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

/**
 * Finds the closest point on detail mesh edges to a given point
 * @param tile The tile containing the detail mesh
 * @param poly The polygon
 * @param detailMesh The detail mesh
 * @param pos The position to find closest point for
 * @param closest Output parameter for the closest point
 * @param onlyBoundary If true, only consider boundary edges
 * @returns The squared distance to the closest point
 *  closest point
 */
const closestPointOnDetailEdges = (
    tile: NavMeshTile,
    poly: NavMeshPoly,
    detailMesh: {
        verticesBase: number;
        verticesCount: number;
        trianglesBase: number;
        trianglesCount: number;
    },
    pos: Vec3,
    closest: Vec3,
    onlyBoundary = false,
): number => {
    let dmin = Number.MAX_VALUE;
    let tmin = 0;
    let pmin: Vec3 | null = null;
    let pmax: Vec3 | null = null;

    for (let i = 0; i < detailMesh.trianglesCount; ++i) {
        const t = (detailMesh.trianglesBase + i) * 4;
        const detailTriangles = tile.detailTriangles;

        // check if triangle has boundary edges (if onlyBoundary is true)
        if (onlyBoundary) {
            const triFlags = detailTriangles[t + 3];
            const ANY_BOUNDARY_EDGE =
                (DETAIL_EDGE_BOUNDARY << 0) |
                (DETAIL_EDGE_BOUNDARY << 2) |
                (DETAIL_EDGE_BOUNDARY << 4);
            if ((triFlags & ANY_BOUNDARY_EDGE) === 0) {
                continue;
            }
        }

        // get triangle vertices
        const v: Vec3[] = [vec3.create(), vec3.create(), vec3.create()];
        for (let j = 0; j < 3; ++j) {
            const vertexIndex = detailTriangles[t + j];
            if (vertexIndex < poly.vertices.length) {
                // use main polygon vertices - vertexIndex is an index into poly.vertices
                vec3.fromBuffer(v[j], tile.vertices, poly.vertices[vertexIndex] * 3);
            } else {
                // use detail vertices - (vertexIndex - poly.vertices.length) gives offset from verticesBase
                const detailIndex = detailMesh.verticesBase + (vertexIndex - poly.vertices.length);
                vec3.fromBuffer(v[j], tile.detailVertices, detailIndex * 3);
            }
        }

        // check each edge of the triangle
        for (let k = 0, j = 2; k < 3; j = k++) {
            const triFlags = detailTriangles[t + 3];
            const edgeFlags = getDetailTriEdgeFlags(triFlags, j);

            // skip internal edges if we want only boundaries, or skip duplicate internal edges
            if ((edgeFlags & DETAIL_EDGE_BOUNDARY) === 0 &&
                (onlyBoundary || detailTriangles[t + j] < detailTriangles[t + k])) {
                    // only looking at boundary edges and this is internal, or
					// this is an inner edge that we will see again or have already seen.
                    continue;
            }

            const result = distancePtSeg2d(pos, v[j], v[k]);

            if (result.dist < dmin) {
                dmin = result.dist;
                tmin = result.t;
                pmin = v[j];
                pmax = v[k];
            }
        }
    }

    // interpolate the final closest point
    if (pmin && pmax) {
        vec3.lerp(closest, pmin, pmax, tmin);
    } else {
        vec3.copy(closest, pos);
    }

    return dmin;
};

export type GetClosestPointOnPolyResult = {
    success: boolean;
    isOverPoly: boolean;
    closestPoint: Vec3;
};

export const createGetClosestPointOnPolyResult =
    (): GetClosestPointOnPolyResult => {
        return {
            success: false,
            isOverPoly: false,
            closestPoint: [0, 0, 0],
        };
    };

const _detailClosestPoint = vec3.create();

const _getClosestPointOnPolyLineStart = vec3.create();
const _getClosestPointOnPolyLineEnd = vec3.create();
const _getClosestPointOnPolyHeightResult = createGetPolyHeightResult()

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

    const { tile, poly, polyIndex } = tileAndPoly;

    const lineStart = _getClosestPointOnPolyLineStart;
    const lineEnd = _getClosestPointOnPolyLineEnd;

    // get polygon vertices
    const nv = poly.vertices.length;
    const verts = new Array(nv * 3);

    for (let i = 0; i < nv; ++i) {
        const vertIndex = poly.vertices[i] * 3;
        verts[i * 3] = tile.vertices[vertIndex];
        verts[i * 3 + 1] = tile.vertices[vertIndex + 1];
        verts[i * 3 + 2] = tile.vertices[vertIndex + 2];
    }

    // check if point is over polygon
    if (pointInPoly(nv, verts, point)) {
        result.isOverPoly = true;

        // find height at the position
        const getPolyHeightResult = getPolyHeight(_getClosestPointOnPolyHeightResult, tile, poly, polyIndex, point);

        if (getPolyHeightResult.success) {
            result.closestPoint[0] = point[0];
            result.closestPoint[1] = getPolyHeightResult.height;
            result.closestPoint[2] = point[2];
        } else {
            // fallback to polygon center height
            let avgY = 0;
            for (let i = 0; i < nv; ++i) {
                avgY += verts[i * 3 + 1];
            }
            result.closestPoint[0] = point[0];
            result.closestPoint[1] = avgY / nv;
            result.closestPoint[2] = point[2];
        }

        result.success = true;
        return result;
    }

    // point is outside polygon, find closest point on polygon boundary
    let dmin = Number.MAX_VALUE;
    let imin = -1;

    for (let i = 0; i < nv; ++i) {
        const j = (i + 1) % nv;
        lineStart[0] = verts[i * 3];
        lineStart[1] = verts[i * 3 + 1];
        lineStart[2] = verts[i * 3 + 2];

        lineEnd[0] = verts[j * 3];
        lineEnd[1] = verts[j * 3 + 1];
        lineEnd[2] = verts[j * 3 + 2];

        const d = distancePtSeg2dSqr(point, lineStart, lineEnd);
        if (d < dmin) {
            dmin = d;
            imin = i;
        }
    }

    if (imin >= 0) {
        const j = (imin + 1) % nv;

        lineStart[0] = verts[imin * 3];
        lineStart[1] = verts[imin * 3 + 1];
        lineStart[2] = verts[imin * 3 + 2];

        lineEnd[0] = verts[j * 3];
        lineEnd[1] = verts[j * 3 + 1];
        lineEnd[2] = verts[j * 3 + 2];

        closestPtSeg2d(result.closestPoint, point, lineStart, lineEnd);

        // try to get more accurate height from detail mesh if available
        const detailMesh = tile.detailMeshes?.[polyIndex];

        if (detailMesh) {
            const detailDist = closestPointOnDetailEdges(
                tile,
                poly,
                detailMesh,
                point,
                _detailClosestPoint,
            );

            // use detail mesh result if it's closer
            const currentDist = vec3.squaredDistance(
                result.closestPoint,
                point,
            );

            if (detailDist < currentDist) {
                vec3.copy(result.closestPoint, _detailClosestPoint);
            }
        }

        result.success = true;
    }

    return result;
};

const _closestPointOnPolyBoundaryLineStart = vec3.create();
const _closestPointOnPolyBoundaryLineEnd = vec3.create();

export const getClosestPointOnPolyBoundary = (
    navMesh: NavMesh,
    polyRef: NodeRef,
    point: Vec3,
    outClosestPoint: Vec3,
): boolean => {
    const tileAndPoly = getTileAndPolyByRef(polyRef, navMesh);

    if (!tileAndPoly.success || !vec3.finite(point) || !outClosestPoint) {
        return false;
    }

    const { tile, poly } = tileAndPoly;

    const lineStart = _closestPointOnPolyBoundaryLineStart;
    const lineEnd = _closestPointOnPolyBoundaryLineEnd;

    // collect vertices
    const nv = poly.vertices.length;
    const verts = new Array<number>(nv * 3);
    for (let i = 0; i < nv; ++i) {
        const vIndex = poly.vertices[i] * 3;
        verts[i * 3 + 0] = tile.vertices[vIndex + 0];
        verts[i * 3 + 1] = tile.vertices[vIndex + 1];
        verts[i * 3 + 2] = tile.vertices[vIndex + 2];
    }

    // if inside polygon, return the point as-is
    if (pointInPoly(nv, verts, point)) {
        vec3.copy(outClosestPoint, point);
        return true;
    }

    // otherwise clamp to nearest edge
    let dmin = Number.MAX_VALUE;
    let imin = 0;
    for (let i = 0; i < nv; ++i) {
        const j = (i + 1) % nv;
        const vaIndex = i * 3;
        const vbIndex = j * 3;
        lineStart[0] = verts[vaIndex + 0];
        lineStart[1] = verts[vaIndex + 1];
        lineStart[2] = verts[vaIndex + 2];
        lineEnd[0] = verts[vbIndex + 0];
        lineEnd[1] = verts[vbIndex + 1];
        lineEnd[2] = verts[vbIndex + 2];
        const d = distancePtSeg2dSqr(point, lineStart, lineEnd);
        if (d < dmin) {
            dmin = d;
            imin = i;
        }
    }

    const j = (imin + 1) % nv;
    const vaIndex = imin * 3;
    const vbIndex = j * 3;
    const va0 = verts[vaIndex + 0];
    const va1 = verts[vaIndex + 1];
    const va2 = verts[vaIndex + 2];
    const vb0 = verts[vbIndex + 0];
    const vb1 = verts[vbIndex + 1];
    const vb2 = verts[vbIndex + 2];

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
    nearestPolyRef: NodeRef;
    nearestPoint: Vec3;
};

export const createFindNearestPolyResult = (): FindNearestPolyResult => {
    return {
        success: false,
        nearestPolyRef: '' as NodeRef,
        nearestPoint: [0, 0, 0],
    };
};

const _findNearestPolyClosestPointResult = createGetClosestPointOnPolyResult();
const _findNearestPolyDiff = vec3.create();

export const findNearestPoly = (
    result: FindNearestPolyResult,
    navMesh: NavMesh,
    center: Vec3,
    halfExtents: Vec3,
    queryFilter: QueryFilter,
): FindNearestPolyResult => {
    result.success = false;
    result.nearestPolyRef = '' as NodeRef;
    vec3.copy(result.nearestPoint, center);

    // query polygons in the area
    const polys = queryPolygons(navMesh, center, halfExtents, queryFilter);

    let nearestDistSqr = Number.MAX_VALUE;

    // find the closest polygon
    for (const polyRef of polys) {
        const closestPoint = getClosestPointOnPoly(
            _findNearestPolyClosestPointResult,
            navMesh,
            polyRef,
            center,
        );

        if (closestPoint.success) {
            const tileAndPoly = getTileAndPolyByRef(polyRef, navMesh);

            if (!tileAndPoly.success) {
                continue;
            }

            const { tile } = tileAndPoly;

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
                result.nearestPolyRef = polyRef;
                vec3.copy(result.nearestPoint, closestPoint.closestPoint);
                result.success = true;
            }
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
            const node = tile.bvTree.nodes[nodeIndex];

            const nodeBounds = node.bounds;
            const overlap =
                _queryPolygonsInTileBmin[0] <= nodeBounds[1][0] &&
                _queryPolygonsInTileBmax[0] >= nodeBounds[0][0] &&
                _queryPolygonsInTileBmin[1] <= nodeBounds[1][1] &&
                _queryPolygonsInTileBmax[1] >= nodeBounds[0][1] &&
                _queryPolygonsInTileBmin[2] <= nodeBounds[1][2] &&
                _queryPolygonsInTileBmax[2] >= nodeBounds[0][2];

            const isLeafNode = node.i >= 0;

            if (isLeafNode && overlap) {
                const polyId = node.i;
                const poly = tile.polys[polyId];
                const ref: NodeRef = serPolyNodeRef(tile.id, polyId);

                if (
                    (poly.flags & filter.includeFlags) !== 0 &&
                    (poly.flags & filter.excludeFlags) === 0
                ) {
                    if (
                        !filter.passFilter ||
                        filter.passFilter(ref, navMesh, filter)
                    ) {
                        out.push(ref);
                    }
                }
            }

            if (overlap || isLeafNode) {
                nodeIndex++;
            } else {
                const escapeIndex = -node.i;
                nodeIndex += escapeIndex;
            }
        }
    } else {
        const qmin = bounds[0];
        const qmax = bounds[1];

        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const poly = tile.polys[polyIndex];
            const polyRef = serPolyNodeRef(tile.id, polyIndex);

            // must pass filter
            if (
                (poly.flags & filter.includeFlags) === 0 ||
                (poly.flags & filter.excludeFlags) !== 0
            ) {
                continue;
            }

            if (
                filter.passFilter &&
                !filter.passFilter(polyRef, navMesh, filter)
            ) {
                continue;
            }

            // calc polygon bounds
            const firstVertexIndex = poly.vertices[0];
            vec3.fromBuffer(
                _queryPolygonsInTileVertex,
                tile.vertices,
                firstVertexIndex * 3,
            );
            vec3.copy(_queryPolygonsInTileBmax, _queryPolygonsInTileVertex);
            vec3.copy(_queryPolygonsInTileBmin, _queryPolygonsInTileVertex);

            for (let j = 1; j < poly.vertices.length; j++) {
                const vertexIndex = poly.vertices[j];
                vec3.fromBuffer(
                    _queryPolygonsInTileVertex,
                    tile.vertices,
                    vertexIndex * 3,
                );
                vec3.min(
                    _queryPolygonsInTileBmax,
                    _queryPolygonsInTileBmax,
                    _queryPolygonsInTileVertex,
                );
                vec3.max(
                    _queryPolygonsInTileBmin,
                    _queryPolygonsInTileBmin,
                    _queryPolygonsInTileVertex,
                );
            }

            // check overlap with query bounds
            if (
                qmin[0] <= _queryPolygonsInTileBmin[0] &&
                qmax[0] >= _queryPolygonsInTileBmax[0] &&
                qmin[1] <= _queryPolygonsInTileBmin[1] &&
                qmax[1] >= _queryPolygonsInTileBmax[1] &&
                qmin[2] <= _queryPolygonsInTileBmin[2] &&
                qmax[2] >= _queryPolygonsInTileBmax[2]
            ) {
                out.push(polyRef);
            }
        }
    }
};

const _queryPolygonsBounds = box3.create();
const _queryPolygonsMinTile = vec2.create();
const _queryPolygonsMaxTile = vec2.create();

export const queryPolygons = (
    navMesh: NavMesh,
    center: Vec3,
    halfExtents: Vec3,
    filter: QueryFilter,
): NodeRef[] => {
    const result: NodeRef[] = [];

    // set the bounds for the query
    const bounds = _queryPolygonsBounds;
    vec3.sub(bounds[0], center, halfExtents);
    vec3.add(bounds[1], center, halfExtents);

    // find min and max tile positions
    const minTile = worldToTilePosition(
        _queryPolygonsMinTile,
        navMesh,
        bounds[0],
    );
    const maxTile = worldToTilePosition(
        _queryPolygonsMaxTile,
        navMesh,
        bounds[1],
    );

    // iterate through the tiles in the query bounds
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
