import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import { POLY_NEIS_FLAG_EXT_LINK } from '../generate';
import { distancePtSegSqr2d, overlapPolyPoly2D } from '../geometry';
import type { NavMesh } from './nav-mesh';
import { getTileAndPolyByRef } from './nav-mesh-api';
import {
    getPortalPoints,
    isValidNodeRef,
    NODE_FLAG_CLOSED,
    type SearchNode,
    type SearchNodePool,
    type SearchNodeRef,
} from './nav-mesh-search';
import { getNodeRefType, type NodeRef, NodeType, serPolyNodeRef } from './node';
import type { QueryFilter } from './query-filter';

type SegmentInterval = {
    ref: NodeRef | null;
    tmin: number;
    tmax: number;
};

// helper to insert an interval into a sorted array
const insertInterval = (intervals: SegmentInterval[], tmin: number, tmax: number, ref: NodeRef | null): void => {
    // Find insertion point
    let idx = 0;
    while (idx < intervals.length && tmax > intervals[idx].tmin) {
        idx++;
    }

    // Insert at the found position
    intervals.splice(idx, 0, { ref, tmin, tmax });
};

export type FindLocalNeighbourhoodResult = {
    success: boolean;
    /** polygon references in the local neighbourhood */
    resultRefs: NodeRef[];
    /** search nodes */
    searchNodes: SearchNodePool;
};

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
 * @param startRef The reference ID of the starting polygon
 * @param centerPos The center position of the search circle
 * @param radius The search radius
 * @param filter The query filter to apply
 * @returns The result containing found polygons and their parents
 */
export const findLocalNeighbourhood = (
    navMesh: NavMesh,
    startRef: NodeRef,
    centerPos: Vec3,
    radius: number,
    filter: QueryFilter,
): FindLocalNeighbourhoodResult => {
    // search state - use a simple node pool for this algorithm
    const nodes: Record<NodeRef, SearchNode> = {};
    const stack: SearchNode[] = [];

    const result: FindLocalNeighbourhoodResult = {
        success: false,
        resultRefs: [],
        searchNodes: nodes,
    };

    // validate input
    if (!isValidNodeRef(navMesh, startRef) || !vec3.finite(centerPos) || radius < 0 || !Number.isFinite(radius) || !filter) {
        return result;
    }

    // initialize start node
    const startNode: SearchNode = {
        cost: 0,
        total: 0,
        parent: null,
        nodeRef: startRef,
        state: 0,
        flags: NODE_FLAG_CLOSED,
        position: structuredClone(centerPos),
    };
    nodes[startRef] = startNode;
    stack.push(startNode);

    const radiusSqr = radius * radius;

    // add start polygon to results
    result.resultRefs.push(startRef);

    // Temporary arrays for polygon vertices
    const polyVerticesA: number[] = [];
    const polyVerticesB: number[] = [];

    while (stack.length > 0) {
        // pop front (breadth-first search)
        const curNode = stack.shift()!;
        const curRef = curNode.nodeRef;

        // get current poly and tile
        const curTileAndPoly = getTileAndPolyByRef(curRef, navMesh);
        if (!curTileAndPoly.success) continue;

        // iterate through all links
        const polyLinks = navMesh.nodes[curRef] || [];
        for (const linkIndex of polyLinks) {
            const link = navMesh.links[linkIndex];
            if (!link || !link.neighbourRef) continue;

            const neighbourRef = link.neighbourRef;

            // skip if already visited
            if (nodes[neighbourRef]?.flags & NODE_FLAG_CLOSED) continue;

            // get neighbour poly and tile
            const neighbourTileAndPoly = getTileAndPolyByRef(neighbourRef, navMesh);
            if (!neighbourTileAndPoly.success) continue;
            const { tile: neighbourTile, poly: neighbourPoly } = neighbourTileAndPoly;

            // skip off-mesh connections
            if (getNodeRefType(neighbourRef) === NodeType.OFFMESH_CONNECTION) continue;

            // apply filter
            if (filter.passFilter && !filter.passFilter(neighbourRef, navMesh, filter)) continue;

            // find edge and calc distance to the edge
            const va = vec3.create();
            const vb = vec3.create();
            if (!getPortalPoints(navMesh, curRef, neighbourRef, va, vb)) continue;

            // if the circle is not touching the next polygon, skip it
            const { distSqr } = distancePtSegSqr2d(centerPos, va, vb);
            if (distSqr > radiusSqr) continue;

            // mark node visited before overlap test
            const neighbourNode: SearchNode = {
                cost: 0,
                total: 0,
                parent: `${curRef}:0` as SearchNodeRef,
                nodeRef: neighbourRef,
                state: 0,
                flags: NODE_FLAG_CLOSED,
                position: structuredClone(centerPos),
            };
            nodes[neighbourRef] = neighbourNode;

            // check that the polygon does not collide with existing polygons
            // collect vertices of the neighbour poly
            polyVerticesA.length = 0;
            const npa = neighbourPoly.vertices.length;
            for (let k = 0; k < npa; ++k) {
                const vertIndex = neighbourPoly.vertices[k];
                polyVerticesA.push(
                    neighbourTile.vertices[vertIndex * 3],
                    neighbourTile.vertices[vertIndex * 3 + 1],
                    neighbourTile.vertices[vertIndex * 3 + 2],
                );
            }

            let overlap = false;
            for (let j = 0; j < result.resultRefs.length; ++j) {
                const pastRef = result.resultRefs[j];

                // connected polys do not overlap
                let connected = false;
                for (const pastLinkIndex of navMesh.nodes[curRef] || []) {
                    if (navMesh.links[pastLinkIndex]?.neighbourRef === pastRef) {
                        connected = true;
                        break;
                    }
                }
                if (connected) continue;

                // potentially overlapping - get vertices and test overlap
                const pastTileAndPoly = getTileAndPolyByRef(pastRef, navMesh);
                if (!pastTileAndPoly.success) continue;
                const { tile: pastTile, poly: pastPoly } = pastTileAndPoly;

                polyVerticesB.length = 0;
                const npb = pastPoly.vertices.length;
                for (let k = 0; k < npb; ++k) {
                    const vertIndex = pastPoly.vertices[k];
                    polyVerticesB.push(
                        pastTile.vertices[vertIndex * 3],
                        pastTile.vertices[vertIndex * 3 + 1],
                        pastTile.vertices[vertIndex * 3 + 2],
                    );
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
 * @param storePortals Whether to store portal segments and their refs
 * @returns The result containing wall segments and optionally portal refs
 */
export const getPolyWallSegments = (navMesh: NavMesh, polyRef: NodeRef, filter: QueryFilter): PolyWallSegmentsResult => {
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
            const polyLinks = navMesh.nodes[polyRef] || [];
            for (const linkIndex of polyLinks) {
                const link = navMesh.links[linkIndex];
                if (!link || link.edge !== j) continue;

                if (link.neighbourRef) {
                    const neighbourTileAndPoly = getTileAndPolyByRef(link.neighbourRef, navMesh);
                    if (neighbourTileAndPoly.success) {
                        if (filter.passFilter?.(link.neighbourRef, navMesh, filter)) {
                            insertInterval(intervals, link.bmin, link.bmax, link.neighbourRef);
                        }
                    }
                }
            }
        } else {
            // internal edge
            let neiRef: NodeRef | null = null;
            if (poly.neis[j]) {
                const idx = poly.neis[j] - 1;
                neiRef = serPolyNodeRef(tile.id, idx);

                // check if neighbor passes filter
                const neighbourTileAndPoly = getTileAndPolyByRef(neiRef, navMesh);
                if (neighbourTileAndPoly.success) {
                    if (!filter.passFilter?.(neiRef, navMesh, filter)) {
                        neiRef = null;
                    }
                }
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
            if (intervals[k].ref) {
                const tmin = intervals[k].tmin / 255.0;
                const tmax = intervals[k].tmax / 255.0;

                const segStart = vec3.create();
                const segEnd = vec3.create();
                vec3.lerp(segStart, vj, vi, tmin);
                vec3.lerp(segEnd, vj, vi, tmax);

                segmentVerts.push(segStart[0], segStart[1], segStart[2], segEnd[0], segEnd[1], segEnd[2]);
                segmentRefs.push(intervals[k].ref);
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
