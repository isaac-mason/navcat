import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import { POLY_NEIS_FLAG_EXT_LINK } from '../generate';
import { createDistancePtSegSqr2dResult, distancePtSegSqr2d, overlapPolyPoly2D } from '../geometry';
import type { NavMesh } from './nav-mesh';
import { getNodeByRef, getNodeByTileAndPoly, getTileAndPolyByRef, isValidNodeRef } from './nav-mesh-api';
import {
    addSearchNode,
    getPortalPoints,
    getSearchNode,
    NODE_FLAG_CLOSED,
    type SearchNode,
    type SearchNodePool,
} from './nav-mesh-search';
import { getNodeRefType, type NodeRef, NodeType } from './node';
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
    /** polygon references in the local neighbourhood */
    resultRefs: NodeRef[];
    /** search nodes */
    searchNodes: SearchNodePool;
};

const _findLocalNeighbourhoodPolyVerticesA: number[] = [];
const _findLocalNeighbourhoodPolyVerticesB: number[] = [];
const _findLocalNeighbourhood_distancePtSegSqr2dResult = createDistancePtSegSqr2dResult();

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
        resultRefs: [],
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
    result.resultRefs.push(startNodeRef);

    // temporary arrays for polygon vertices
    const polyVerticesA = _findLocalNeighbourhoodPolyVerticesA;
    const polyVerticesB = _findLocalNeighbourhoodPolyVerticesB;

    while (stack.length > 0) {
        // pop front (breadth-first search)
        const curNode = stack.shift()!;
        const curRef = curNode.nodeRef;

        // get current poly and tile
        const curTileAndPoly = getTileAndPolyByRef(curRef, navMesh);
        if (!curTileAndPoly.success) continue;

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
            const neighbourTileAndPoly = getTileAndPolyByRef(neighbourRef, navMesh);
            if (!neighbourTileAndPoly.success) continue;
            const { tile: neighbourTile, poly: neighbourPoly } = neighbourTileAndPoly;

            // skip off-mesh connections
            if (getNodeRefType(neighbourRef) === NodeType.OFFMESH) continue;

            // apply filter
            if (!filter.passFilter(neighbourRef, navMesh)) continue;

            // find edge and calc distance to the edge
            const va = vec3.create();
            const vb = vec3.create();
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
            for (let j = 0; j < result.resultRefs.length; ++j) {
                const pastRef = result.resultRefs[j];

                // connected polys do not overlap
                let connected = false;
                const curNode = getNodeByRef(navMesh, curRef);
                for (const pastLinkIndex of curNode.links) {
                    if (navMesh.links[pastLinkIndex]?.toNodeRef === pastRef) {
                        connected = true;
                        break;
                    }
                }
                if (connected) continue;

                // potentially overlapping - get vertices and test overlap
                const pastTileAndPoly = getTileAndPolyByRef(pastRef, navMesh);
                if (!pastTileAndPoly.success) continue;
                const { tile: pastTile, poly: pastPoly } = pastTileAndPoly;

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
            result.resultRefs.push(neighbourRef);

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
 * @param polyRef The reference ID of the polygon
 * @param filter The query filter to apply
 * @param includePortals Whether to include portal segments in the result
 */
export const getPolyWallSegments = (navMesh: NavMesh, polyRef: NodeRef, filter: QueryFilter, includePortals: boolean): PolyWallSegmentsResult => {
    const result: PolyWallSegmentsResult = {
        success: false,
        segmentVerts: [],
        segmentRefs: [],
    };

    // validate input
    const tileAndPoly = getTileAndPolyByRef(polyRef, navMesh);
    if (!tileAndPoly.success || !filter) {
        return result;
    }

    const { tile, poly } = tileAndPoly;
    const segmentVerts: number[] = result.segmentVerts;
    const segmentRefs: (NodeRef | null)[] = result.segmentRefs;

    // process each edge of the polygon
    for (let i = 0, j = poly.vertices.length - 1; i < poly.vertices.length; j = i++) {
        const intervals: SegmentInterval[] = [];

        // check if this edge has external links (tile boundary)
        if (poly.neis[j] & POLY_NEIS_FLAG_EXT_LINK) {
            // tile border - find all links for this edge
            const node = getNodeByRef(navMesh, polyRef);

            for (const linkIndex of node.links) {
                const link = navMesh.links[linkIndex];
                if (!link || link.edge !== j) continue;

                if (link.toNodeRef) {
                    const neighbourTileAndPoly = getTileAndPolyByRef(link.toNodeRef, navMesh);
                    if (neighbourTileAndPoly.success) {
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
                const neighbourTileAndPoly = getTileAndPolyByRef(neiRef, navMesh);
                if (neighbourTileAndPoly.success) {
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
            const vj = vec3.fromBuffer(vec3.create(), tile.vertices, poly.vertices[j] * 3);
            const vi = vec3.fromBuffer(vec3.create(), tile.vertices, poly.vertices[i] * 3);

            segmentVerts.push(vj[0], vj[1], vj[2], vi[0], vi[1], vi[2]);
            segmentRefs.push(neiRef);
            continue;
        }

        // add sentinels for interval processing
        insertInterval(intervals, -1, 0, null);
        insertInterval(intervals, 255, 256, null);

        // store segments based on intervals
        const vj = vec3.fromBuffer(vec3.create(), tile.vertices, poly.vertices[j] * 3);
        const vi = vec3.fromBuffer(vec3.create(), tile.vertices, poly.vertices[i] * 3);

        for (let k = 1; k < intervals.length; ++k) {
            // portal segment
            if (includePortals && intervals[k].nodeRef) {
                const tmin = intervals[k].tmin / 255.0;
                const tmax = intervals[k].tmax / 255.0;

                const segStart = vec3.create();
                const segEnd = vec3.create();
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

                const segStart = vec3.create();
                const segEnd = vec3.create();
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
