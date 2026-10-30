import type { Vec3 } from 'math';
import type { IntersectSegmentPoly2DResult } from '../geometry';
import type { NavMesh, NavMeshTile } from './nav-mesh';
import { getNodeRefIndex, getNodeRefType, type NodeRef, NodeType } from './node';

/** The tile of a poly node ref, or undefined when the ref is not a poly of a loaded tile (as getTileAndPolyByRef). */
export const getPolyRefTile = (navMesh: NavMesh, nodeRef: NodeRef): NavMeshTile | undefined => {
    if (getNodeRefType(nodeRef) !== NodeType.POLY) return undefined;

    const node = navMesh.nodes[getNodeRefIndex(nodeRef)];
    const tile = navMesh.tiles[node.tileId];

    if (!tile || node.polyIndex >= tile.polys.length) return undefined;

    return tile;
};

/** pointInPoly against a tile poly, reading its vertices in place. */
export const pointInTilePoly = (point: Vec3, tileVertices: number[], polyVertices: number[]): boolean => {
    let inside = false;
    const x = point[0];
    const z = point[2];
    const l = polyVertices.length;

    if (l === 0) return false;

    // carry the previous vertex, and only read x for edges spanning z
    let vj = polyVertices[l - 1] * 3;
    let zj = tileVertices[vj + 2];

    for (let i = 0, j = l - 1; i < l; j = i++) {
        const vi = polyVertices[i] * 3;
        const zi = tileVertices[vi + 2];

        if (zj < zi) {
            if (z >= zj && z < zi) {
                const xj = tileVertices[vj];
                const xi = tileVertices[vi];
                const where = (zi - zj) * (x - xi) - (xi - xj) * (z - zi);
                if (where === 0) {
                    // point on the line
                    return true;
                }
                if (where > 0) {
                    if (z === zj) {
                        // ray intersects vertex
                        if (z > tileVertices[polyVertices[j === 0 ? l - 1 : j - 1] * 3 + 2]) {
                            inside = !inside;
                        }
                    } else {
                        inside = !inside;
                    }
                }
            }
        } else if (zi < zj) {
            if (z > zi && z <= zj) {
                const xj = tileVertices[vj];
                const xi = tileVertices[vi];
                const where = (zi - zj) * (x - xi) - (xi - xj) * (z - zi);
                if (where === 0) {
                    // point on the line
                    return true;
                }
                if (where < 0) {
                    if (z === zj) {
                        // ray intersects vertex
                        if (z < tileVertices[polyVertices[j === 0 ? l - 1 : j - 1] * 3 + 2]) {
                            inside = !inside;
                        }
                    } else {
                        inside = !inside;
                    }
                }
            }
        } else if (z === zi) {
            const xj = tileVertices[vj];
            const xi = tileVertices[vi];
            if ((x >= xj && x <= xi) || (x >= xi && x <= xj)) {
                // point on horizontal edge
                return true;
            }
        }

        vj = vi;
        zj = zi;
    }

    return inside;
};

/** the parallel-edge epsilon of intersectSegmentPoly2D */
const EPS = 1e-6;

/**
 * intersectSegmentPoly2D for a tile polygon, reading its vertices in place.
 * Same operations in the same order; each vertex is read once, as edge end and then as the next edge's start.
 */
export const intersectSegmentTilePoly2D = (
    result: IntersectSegmentPoly2DResult,
    startPosition: Vec3,
    endPosition: Vec3,
    tileVertices: number[],
    polyVertices: number[],
): IntersectSegmentPoly2DResult => {
    result.intersects = false;
    result.tmin = 0;
    result.tmax = 1;
    result.segMin = -1;
    result.segMax = -1;

    const nv = polyVertices.length;
    const startX = startPosition[0];
    const startZ = startPosition[2];
    const dirX = endPosition[0] - startX;
    const dirZ = endPosition[2] - startZ;

    let j = nv - 1;
    let vjX = tileVertices[polyVertices[j] * 3];
    let vjZ = tileVertices[polyVertices[j] * 3 + 2];

    for (let i = 0; i < nv; j = i, i++) {
        const vi = polyVertices[i] * 3;
        const viX = tileVertices[vi];
        const viZ = tileVertices[vi + 2];
        const edgeX = viX - vjX;
        const edgeZ = viZ - vjZ;

        // xz-plane perp products (uz*vx - ux*vz) of (edge, start - vj) and (dir, edge)
        const n = edgeZ * (startX - vjX) - edgeX * (startZ - vjZ);
        const d = dirZ * edgeX - dirX * edgeZ;

        vjX = viX;
        vjZ = viZ;

        if (Math.abs(d) < EPS) {
            // S is nearly parallel to this edge
            if (n < 0) {
                return result;
            }

            continue;
        }

        const t = n / d;

        if (d < 0) {
            // segment S is entering across this edge
            if (t > result.tmin) {
                result.tmin = t;
                result.segMin = j;
                // S enters after leaving polygon
                if (result.tmin > result.tmax) {
                    return result;
                }
            }
        } else {
            // segment S is leaving across this edge
            if (t < result.tmax) {
                result.tmax = t;
                result.segMax = j;
                // S leaves before entering polygon
                if (result.tmax < result.tmin) {
                    return result;
                }
            }
        }
    }

    result.intersects = true;

    return result;
};
