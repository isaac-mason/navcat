import type { Vec3 } from 'math';
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
