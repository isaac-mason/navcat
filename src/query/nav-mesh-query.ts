import type { Box3, Vec3 } from 'maaths';
import { box3, vec2, vec3 } from 'maaths';
import {
    closestPtSeg2d,
    distancePtSeg2dSqr,
    getHeightAtPoint,
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

const _getPolyHeightV0 = vec3.create();
const _getPolyHeightV1 = vec3.create();
const _getPolyHeightV2 = vec3.create();

/**
 * Gets the height of a polygon at a given point using detail mesh if available
 * @param tile The tile containing the polygon
 * @param poly The polygon
 * @param polyIndex The index of the polygon in the tile
 * @param pos The position to get height for
 * @param height Output parameter for the height
 * @returns True if height was found
 */
export const getPolyHeight = (
    tile: NavMeshTile,
    poly: NavMeshPoly,
    polyIndex: number,
    pos: Vec3,
): number => {
    // check if we have detail mesh data
    const detailMesh = tile.detailMeshes?.[polyIndex];

    if (detailMesh) {
        // use detail mesh for accurate height calculation
        for (let j = 0; j < detailMesh.trianglesCount; ++j) {
            const t = (detailMesh.trianglesBase + j) * 4;
            const detailTriangles = tile.detailTriangles;

            const v0Index = detailTriangles[t + 0];
            const v1Index = detailTriangles[t + 1];
            const v2Index = detailTriangles[t + 2];

            // get triangle vertices
            const v0 = _getPolyHeightV0;
            const v1 = _getPolyHeightV1;
            const v2 = _getPolyHeightV2;

            if (v0Index < tile.vertices.length / 3) {
                // use main tile vertices
                vec3.fromBuffer(v0, tile.vertices, v0Index * 3);
            } else {
                // use detail vertices
                const detailIndex = (v0Index - tile.vertices.length / 3) * 3;
                vec3.fromBuffer(v0, tile.detailVertices, detailIndex);
            }

            if (v1Index < tile.vertices.length / 3) {
                vec3.fromBuffer(v1, tile.vertices, v1Index * 3);
            } else {
                const detailIndex = (v1Index - tile.vertices.length / 3) * 3;
                vec3.fromBuffer(v1, tile.detailVertices, detailIndex);
            }

            if (v2Index < tile.vertices.length / 3) {
                vec3.fromBuffer(v2, tile.vertices, v2Index * 3);
            } else {
                const detailIndex = (v2Index - tile.vertices.length / 3) * 3;
                vec3.fromBuffer(v2, tile.detailVertices, detailIndex);
            }

            // check if point is inside triangle and calculate height
            const h = getHeightAtPoint(v0, v1, v2, pos);
            if (h !== null) {
                return h;
            }
        }
    }

    // fallback: use polygon vertices for height calculation
    if (poly.vertices.length >= 3) {
        const v0 = _getPolyHeightV0;
        const v1 = _getPolyHeightV1;
        const v2 = _getPolyHeightV2;

        vec3.fromBuffer(v0, tile.vertices, poly.vertices[0] * 3);
        vec3.fromBuffer(v1, tile.vertices, poly.vertices[1] * 3);
        vec3.fromBuffer(v2, tile.vertices, poly.vertices[2] * 3);

        const h = getHeightAtPoint(v0, v1, v2, pos);

        if (h !== null) {
            return h;
        }
    }

    return Number.NaN;
};

const _closestOnDetailEdges: Vec3 = [0, 0, 0];
const _closestPointOnDetailEdgesVi: Vec3 = [0, 0, 0];
const _closestPointOnDetailEdgesVk: Vec3 = [0, 0, 0];

/**
 * Finds the closest point on detail mesh edges to a given point
 * @param tile The tile containing the detail mesh
 * @param detailMesh The detail mesh
 * @param pos The position to find closest point for
 * @param closest Output parameter for the closest point
 * @returns The squared distance to the closest point
 */
const closestPointOnDetailEdges = (
    tile: NavMeshTile,
    detailMesh: {
        verticesBase: number;
        verticesCount: number;
        trianglesBase: number;
        trianglesCount: number;
    },
    pos: Vec3,
    closest: Vec3,
): number => {
    let dmin = Number.MAX_VALUE;

    for (let i = 0; i < detailMesh.trianglesCount; ++i) {
        const t = (detailMesh.trianglesBase + i) * 4;
        const detailTriangles = tile.detailTriangles;

        for (let j = 0; j < 3; ++j) {
            const k = (j + 1) % 3;

            const viIndex = detailTriangles[t + j];
            const vkIndex = detailTriangles[t + k];

            // get vertices
            const vi = _closestPointOnDetailEdgesVi;
            const vk = _closestPointOnDetailEdgesVk;

            if (viIndex < tile.vertices.length / 3) {
                vec3.fromBuffer(vi, tile.vertices, viIndex * 3);
            } else {
                const detailIndex = (viIndex - tile.vertices.length / 3) * 3;

                vec3.fromBuffer(vi, tile.detailVertices, detailIndex);
            }

            if (vkIndex < tile.vertices.length / 3) {
                vec3.fromBuffer(vk, tile.vertices, vkIndex * 3);
            } else {
                const detailIndex = (vkIndex - tile.vertices.length / 3) * 3;
                vec3.fromBuffer(vk, tile.detailVertices, detailIndex);
            }

            closestPtSeg2d(_closestOnDetailEdges, pos, vi, vk);
            const d = distancePtSeg2dSqr(pos, vi, vk);

            if (d < dmin) {
                dmin = d;
                vec3.copy(closest, _closestOnDetailEdges);
            }
        }
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

// TODO: should this be renamed to closestPointOnNode and handle off-mesh connections? TBD
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
        const height = getPolyHeight(tile, poly, polyIndex, point);
        if (!Number.isNaN(height)) {
            result.closestPoint[0] = point[0];
            result.closestPoint[1] = height;
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
            const distSqr = vec3.squaredDistance(
                center,
                closestPoint.closestPoint,
            );

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
