import type { Vec3 } from 'math';
import { vec3 } from 'math';
import { DETAIL_EDGE_BOUNDARY } from '../generate';
import type { NavMeshPoly, NavMeshTile } from './nav-mesh';

const _getDetailMeshHeight_closest = vec3.create();

const HEIGHT_EPS = 1e-6;

const _detailMeshVertices: number[] = [];

/** Gathers a poly's detail mesh vertices (the poly vertices, then its detail vertices) as contiguous xyz. */
const gatherDetailMeshVertices = (
    tile: NavMeshTile,
    poly: NavMeshPoly,
    verticesBase: number,
    verticesCount: number,
): number[] => {
    const out = _detailMeshVertices;
    const tileVertices = tile.vertices;
    const detailVertices = tile.detailVertices;
    const polyVertices = poly.vertices;
    const nv = polyVertices.length;

    let o = 0;
    for (let i = 0; i < nv; i++) {
        const v = polyVertices[i] * 3;
        out[o++] = tileVertices[v];
        out[o++] = tileVertices[v + 1];
        out[o++] = tileVertices[v + 2];
    }
    const end = (verticesBase + verticesCount) * 3;
    for (let v = verticesBase * 3; v < end; v++) {
        out[o++] = detailVertices[v];
    }

    return out;
};

/**
 * Gets the height at a position inside a polygon using the detail mesh.
 * Assumes the position is already known to be inside the polygon (in XZ).
 * Falls back to closest point on detail edges if triangle checks fail.
 * @param tile The tile containing the polygon
 * @param poly The polygon
 * @param polyIndex The index of the polygon in the tile
 * @param pos The position to get height for
 * @returns The height at the position
 */
export const getDetailMeshHeight = (tile: NavMeshTile, poly: NavMeshPoly, polyIndex: number, pos: Vec3): number => {
    const detailMesh = tile.detailMeshes[polyIndex];

    // use detail mesh if available for more accurate height
    if (detailMesh) {
        const detailTriangles = tile.detailTriangles;
        const verts = gatherDetailMeshVertices(tile, poly, detailMesh.verticesBase, detailMesh.verticesCount);
        const px = pos[0];
        const pz = pos[2];

        for (let j = 0; j < detailMesh.trianglesCount; ++j) {
            const t = (detailMesh.trianglesBase + j) * 4;
            const a = detailTriangles[t] * 3;
            const b = detailTriangles[t + 1] * 3;
            const c = detailTriangles[t + 2] * 3;

            // closestHeightPointTriangle: test in xz, read the heights only for the triangle containing the point
            const ax = verts[a];
            const az = verts[a + 2];
            const v0x = verts[c] - ax;
            const v0z = verts[c + 2] - az;
            const v1x = verts[b] - ax;
            const v1z = verts[b + 2] - az;
            const v2x = px - ax;
            const v2z = pz - az;

            // compute scaled barycentric coordinates
            let denom = v0x * v1z - v0z * v1x;
            if (Math.abs(denom) < HEIGHT_EPS) continue;

            let u = v1z * v2x - v1x * v2z;
            let v = v0x * v2z - v0z * v2x;

            if (denom < 0) {
                denom = -denom;
                u = -u;
                v = -v;
            }

            // if point lies inside the triangle, return interpolated y
            if (u >= 0.0 && v >= 0.0 && u + v <= denom) {
                const ay = verts[a + 1];
                const v0y = verts[c + 1] - ay;
                const v1y = verts[b + 1] - ay;
                return ay + (v0y * u + v1y * v) / denom;
            }
        }
    }

    // if all triangle checks failed above (can happen with degenerate triangles
    // or larger floating point values) the point is on an edge, so just select
    // closest.
    // this should almost never happen so the extra iteration here is ok.
    getClosestPointOnDetailEdges(_getDetailMeshHeight_closest, tile, poly, polyIndex, pos, false);
    return _getDetailMeshHeight_closest[1];
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

/**
 * Gets the closest point on detail mesh edges to a given point
 * @param tile The tile containing the detail mesh
 * @param poly The polygon
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
    const detailTriangles = tile.detailTriangles;
    const verts = gatherDetailMeshVertices(tile, poly, detailMesh.verticesBase, detailMesh.verticesCount);
    const ANY_BOUNDARY_EDGE = (DETAIL_EDGE_BOUNDARY << 0) | (DETAIL_EDGE_BOUNDARY << 2) | (DETAIL_EDGE_BOUNDARY << 4);
    const px = pos[0];
    const pz = pos[2];

    let dmin = Number.MAX_VALUE;
    let tmin = 0;

    // endpoints of the closest edge
    let minAx = 0;
    let minAy = 0;
    let minAz = 0;
    let minBx = 0;
    let minBy = 0;
    let minBz = 0;

    for (let i = 0; i < detailMesh.trianglesCount; i++) {
        const t = (detailMesh.trianglesBase + i) * 4;
        const triFlags = detailTriangles[t + 3];

        // check if triangle has boundary edges (if onlyBoundary is true)
        if (onlyBoundary && (triFlags & ANY_BOUNDARY_EDGE) === 0) {
            continue;
        }

        // check each edge of the triangle
        for (let k = 0, j = 2; k < 3; j = k++) {
            const edgeFlags = getDetailTriEdgeFlags(triFlags, j);
            const ij = detailTriangles[t + j];
            const ik = detailTriangles[t + k];

            // skip internal edges if we want only boundaries, or skip duplicate internal edges
            if ((edgeFlags & DETAIL_EDGE_BOUNDARY) === 0 && (onlyBoundary || ij < ik)) {
                // only looking at boundary edges and this is internal, or
                // this is an inner edge that we will see again or have already seen.
                continue;
            }

            const a = ij * 3;
            const b = ik * 3;
            const ax = verts[a];
            const az = verts[a + 2];
            const bx = verts[b];
            const bz = verts[b + 2];

            // distancePtSegSqr2d(pos, a, b)
            const pqx = bx - ax;
            const pqz = bz - az;
            const dx = px - ax;
            const dz = pz - az;
            const d = pqx * pqx + pqz * pqz;
            let segT = pqx * dx + pqz * dz;
            if (d > 0) segT /= d;
            if (segT < 0) segT = 0;
            else if (segT > 1) segT = 1;
            const distX = ax + segT * pqx - px;
            const distZ = az + segT * pqz - pz;
            const distSqr = distX * distX + distZ * distZ;

            if (distSqr < dmin) {
                dmin = distSqr;
                tmin = segT;
                minAx = ax;
                minAy = verts[a + 1];
                minAz = az;
                minBx = bx;
                minBy = verts[b + 1];
                minBz = bz;
            }
        }
    }

    // interpolate the final closest point
    outClosestPoint[0] = minAx + tmin * (minBx - minAx);
    outClosestPoint[1] = minAy + tmin * (minBy - minAy);
    outClosestPoint[2] = minAz + tmin * (minBz - minAz);

    return dmin;
};
