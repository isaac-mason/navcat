import type { Vec3 } from 'math';
import { vec3 } from 'math';
import { POLY_NEIS_FLAG_EXT_LINK } from '../generate';
import { createDistancePtSegSqr2dResult, distancePtSegSqr2d, overlapPolyPoly2D } from '../geometry';
import type { NavMesh } from './nav-mesh';
import { getNodeByRef, getNodeByTileAndPoly, isValidNodeRef } from './nav-mesh-api';
import {
    addSearchNode,
    getPortalPoints,
    getSearchNode,
    NODE_FLAG_CLOSED,
    type SearchNode,
    type SearchNodePool,
} from './nav-mesh-search';
import { getNodeRefIndex, getNodeRefType, type NodeRef, NodeType } from './node';
import { getPolyRefTile } from './poly-ref-tile';
import type { QueryFilter } from './nav-mesh-api';

type SegmentInterval = {
    nodeRef: NodeRef | null;
    tmin: number;
    tmax: number;
};

// helper to insert an interval into a sorted array
const insertInterval = (intervals: SegmentInterval[], tmin: number, tmax: number, nodeRef: NodeRef | null): void => {
    // Find insertion point
    let idx = 0;
    while (idx < intervals.length && tmax > intervals[idx].tmin) {
        idx++;
    }

    // Insert at the found position
    intervals.splice(idx, 0, { nodeRef: nodeRef, tmin, tmax });
};

export type FindLocalNeighbourhoodResult = {
    success: boolean;
    /** node references for polygons in the local neighbourhood */
    nodeRefs: NodeRef[];
    /** search nodes */
    searchNodes: SearchNodePool;
};

const _findLocalNeighbourhoodPolyVerticesA: number[] = [];
const _findLocalNeighbourhoodPolyVerticesB: number[] = [];
const _findLocalNeighbourhood_distancePtSegSqr2dResult = createDistancePtSegSqr2dResult();
const _findLocalNeighbourhood_va = vec3.create();
const _findLocalNeighbourhood_vb = vec3.create();

/**
 * Finds all polygons within a radius of a center position, avoiding overlapping polygons.
 *
 * This method is optimized for a small search radius and small number of result polygons.
 * Candidate polygons are found by searching the navigation graph beginning at the start polygon.
 *
 * The value of the center point is used as the start point for cost calculations.
 * It is not projected onto the surface of the mesh, so its y-value will affect the costs.
 *
 * Intersection tests occur in 2D. All polygons and the search circle are projected onto
 * the xz-plane. So the y-value of the center point does not affect intersection tests.
 *
 * @param navMesh The navigation mesh
 * @param startNodeRef The reference ID of the starting polygon
 * @param position The center position of the search circle
 * @param radius The search radius
 * @param filter The query filter to apply
 * @returns The result containing found polygons and their parents
 */
export const findLocalNeighbourhood = (
    navMesh: NavMesh,
    startNodeRef: NodeRef,
    position: Vec3,
    radius: number,
    filter: QueryFilter,
): FindLocalNeighbourhoodResult => {
    // search state - use SearchNodePool for this algorithm
    const nodes: SearchNodePool = {};
    const stack: SearchNode[] = [];

    const result: FindLocalNeighbourhoodResult = {
        success: false,
        nodeRefs: [],
        searchNodes: nodes,
    };

    // validate input
    if (!isValidNodeRef(navMesh, startNodeRef) || !vec3.finite(position) || radius < 0 || !Number.isFinite(radius) || !filter) {
        return result;
    }

    // initialize start node
    const startNode: SearchNode = {
        cost: 0,
        total: 0,
        parentNodeRef: null,
        parentState: null,
        nodeRef: startNodeRef,
        state: 0,
        flags: NODE_FLAG_CLOSED,
        position: [position[0], position[1], position[2]],
    };
    addSearchNode(nodes, startNode);
    stack.push(startNode);

    const radiusSqr = radius * radius;

    // add start polygon to results
    result.nodeRefs.push(startNodeRef);

    // temporary arrays for polygon vertices
    const polyVerticesA = _findLocalNeighbourhoodPolyVerticesA;
    const polyVerticesB = _findLocalNeighbourhoodPolyVerticesB;

    let stackHead = 0;
    while (stackHead < stack.length) {
        // pop front (breadth-first search)
        const curNode = stack[stackHead++];
        const curRef = curNode.nodeRef;

        // get current poly and tile
        if (!getPolyRefTile(navMesh, curRef)) continue;

        // iterate through all links
        const node = getNodeByRef(navMesh, curRef);

        for (const linkIndex of node.links) {
            const link = navMesh.links[linkIndex];
            if (!link || !link.toNodeRef) continue;

            const neighbourRef = link.toNodeRef;

            // skip if already visited
            const existingNode = getSearchNode(nodes, neighbourRef, 0);
            if (existingNode && existingNode.flags & NODE_FLAG_CLOSED) continue;

            // get neighbour poly and tile
            const neighbourTile = getPolyRefTile(navMesh, neighbourRef);
            if (!neighbourTile) continue;
            const neighbourPoly = neighbourTile.polys[navMesh.nodes[getNodeRefIndex(neighbourRef)].polyIndex];

            // skip off-mesh connections
            if (getNodeRefType(neighbourRef) === NodeType.OFFMESH) continue;

            // apply filter
            if (!filter.passFilter(neighbourRef, navMesh)) continue;

            // find edge and calc distance to the edge
            const va = _findLocalNeighbourhood_va;
            const vb = _findLocalNeighbourhood_vb;
            if (!getPortalPoints(navMesh, curRef, neighbourRef, va, vb)) continue;

            // if the circle is not touching the next polygon, skip it
            distancePtSegSqr2d(_findLocalNeighbourhood_distancePtSegSqr2dResult, position, va, vb);
            if (_findLocalNeighbourhood_distancePtSegSqr2dResult.distSqr > radiusSqr) continue;

            // mark node visited before overlap test
            const neighbourNode: SearchNode = {
                cost: 0,
                total: 0,
                parentNodeRef: curRef,
                parentState: 0,
                nodeRef: neighbourRef,
                state: 0,
                flags: NODE_FLAG_CLOSED,
                position: [position[0], position[1], position[2]],
            };
            addSearchNode(nodes, neighbourNode);

            // check that the polygon does not collide with existing polygons
            // collect vertices of the neighbour poly
            const npa = neighbourPoly.vertices.length;
            for (let k = 0; k < npa; ++k) {
                const start = neighbourPoly.vertices[k] * 3;
                polyVerticesA[k * 3] = neighbourTile.vertices[start];
                polyVerticesA[k * 3 + 1] = neighbourTile.vertices[start + 1];
                polyVerticesA[k * 3 + 2] = neighbourTile.vertices[start + 2];
            }

            let overlap = false;
            for (let j = 0; j < result.nodeRefs.length; ++j) {
                const pastRef = result.nodeRefs[j];

                // connected polys do not overlap
                let connected = false;
                for (const pastLinkIndex of node.links) {
                    if (navMesh.links[pastLinkIndex]?.toNodeRef === pastRef) {
                        connected = true;
                        break;
                    }
                }
                if (connected) continue;

                // potentially overlapping - get vertices and test overlap
                const pastTile = getPolyRefTile(navMesh, pastRef);
                if (!pastTile) continue;
                const pastPoly = pastTile.polys[navMesh.nodes[getNodeRefIndex(pastRef)].polyIndex];

                const npb = pastPoly.vertices.length;
                for (let k = 0; k < npb; ++k) {
                    const start = pastPoly.vertices[k] * 3;
                    polyVerticesB[k * 3] = pastTile.vertices[start];
                    polyVerticesB[k * 3 + 1] = pastTile.vertices[start + 1];
                    polyVerticesB[k * 3 + 2] = pastTile.vertices[start + 2];
                }

                if (overlapPolyPoly2D(polyVerticesA, npa, polyVerticesB, npb)) {
                    overlap = true;
                    break;
                }
            }

            if (overlap) continue;

            // this poly is fine, store and advance to the poly
            result.nodeRefs.push(neighbourRef);

            // add to stack for further exploration
            stack.push(neighbourNode);
        }
    }

    result.success = true;

    return result;
};

export type PolyWallSegmentsResult = {
    success: boolean;
    /** segment vertices [x1,y1,z1,x2,y2,z2,x1,y1,z1,x2,y2,z2,...] */
    segmentVerts: number[];
    /** polygon references for each segment (null for wall segments) */
    segmentRefs: (NodeRef | null)[];
};

/**
 * Returns the wall segments of a polygon, optionally including portal segments.
 *
 * If segmentRefs is requested, then all polygon segments will be returned.
 * Otherwise only the wall segments are returned.
 *
 * A segment that is normally a portal will be included in the result set as a
 * wall if the filter results in the neighbor polygon becoming impassable.
 *
 * @param navMesh The navigation mesh
 * @param nodeRef The reference ID of the polygon
 * @param filter The query filter to apply
 * @param includePortals Whether to include portal segments in the result
 */
const _getPolyWallSegments_vj = vec3.create();
const _getPolyWallSegments_vi = vec3.create();
const _getPolyWallSegments_segStart = vec3.create();
const _getPolyWallSegments_segEnd = vec3.create();

export const getPolyWallSegments = (
    navMesh: NavMesh,
    nodeRef: NodeRef,
    filter: QueryFilter,
    includePortals: boolean,
): PolyWallSegmentsResult => {
    const result: PolyWallSegmentsResult = {
        success: false,
        segmentVerts: [],
        segmentRefs: [],
    };

    // validate input
    const tile = getPolyRefTile(navMesh, nodeRef);
    if (!tile || !filter) {
        return result;
    }

    const poly = tile.polys[navMesh.nodes[getNodeRefIndex(nodeRef)].polyIndex];
    const segmentVerts: number[] = result.segmentVerts;
    const segmentRefs: (NodeRef | null)[] = result.segmentRefs;

    // process each edge of the polygon
    for (let i = 0, j = poly.vertices.length - 1; i < poly.vertices.length; j = i++) {
        const intervals: SegmentInterval[] = [];

        // check if this edge has external links (tile boundary)
        if (poly.neis[j] & POLY_NEIS_FLAG_EXT_LINK) {
            // tile border - find all links for this edge
            const node = getNodeByRef(navMesh, nodeRef);

            for (const linkIndex of node.links) {
                const link = navMesh.links[linkIndex];
                if (!link || link.edge !== j) continue;

                if (link.toNodeRef) {
                    if (getPolyRefTile(navMesh, link.toNodeRef)) {
                        if (filter.passFilter(link.toNodeRef, navMesh)) {
                            insertInterval(intervals, link.bmin, link.bmax, link.toNodeRef);
                        }
                    }
                }
            }
        } else {
            // internal edge
            let neiRef: NodeRef | null = null;
            if (poly.neis[j]) {
                const idx = poly.neis[j] - 1;
                neiRef = getNodeByTileAndPoly(navMesh, tile, idx).ref;

                // check if neighbor passes filter
                if (getPolyRefTile(navMesh, neiRef)) {
                    if (!filter.passFilter(neiRef, navMesh)) {
                        neiRef = null;
                    }
                }
            }

            // If the edge leads to another polygon and portals are not stored, skip.
            if (neiRef !== null && !includePortals) {
                continue;
            }

            // add the full edge as a segment
            const vjo = poly.vertices[j] * 3;
            const vio = poly.vertices[i] * 3;
            const tv = tile.vertices;

            segmentVerts.push(tv[vjo], tv[vjo + 1], tv[vjo + 2], tv[vio], tv[vio + 1], tv[vio + 2]);
            segmentRefs.push(neiRef);
            continue;
        }

        // add sentinels for interval processing
        insertInterval(intervals, -1, 0, null);
        insertInterval(intervals, 255, 256, null);

        // store segments based on intervals
        const vj = vec3.fromBuffer(_getPolyWallSegments_vj, tile.vertices, poly.vertices[j] * 3);
        const vi = vec3.fromBuffer(_getPolyWallSegments_vi, tile.vertices, poly.vertices[i] * 3);

        for (let k = 1; k < intervals.length; ++k) {
            // portal segment
            if (includePortals && intervals[k].nodeRef) {
                const tmin = intervals[k].tmin / 255.0;
                const tmax = intervals[k].tmax / 255.0;

                const segStart = _getPolyWallSegments_segStart;
                const segEnd = _getPolyWallSegments_segEnd;
                vec3.lerp(segStart, vj, vi, tmin);
                vec3.lerp(segEnd, vj, vi, tmax);

                segmentVerts.push(segStart[0], segStart[1], segStart[2], segEnd[0], segEnd[1], segEnd[2]);
                segmentRefs.push(intervals[k].nodeRef);
            }

            // wall segment
            const imin = intervals[k - 1].tmax;
            const imax = intervals[k].tmin;
            if (imin !== imax) {
                const tmin = imin / 255.0;
                const tmax = imax / 255.0;

                const segStart = _getPolyWallSegments_segStart;
                const segEnd = _getPolyWallSegments_segEnd;
                vec3.lerp(segStart, vj, vi, tmin);
                vec3.lerp(segEnd, vj, vi, tmax);

                segmentVerts.push(segStart[0], segStart[1], segStart[2], segEnd[0], segEnd[1], segEnd[2]);
                segmentRefs.push(null);
            }
        }
    }

    result.success = true;

    return result;
};
