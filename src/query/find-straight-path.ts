import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import {
    createIntersectSegSeg2DResult,
    distancePtSegSqr2d,
    type IntersectSegSeg2DResult,
    intersectSegSeg2D,
    triArea2D,
    createDistancePtSegSqr2dResult,
} from '../geometry';
import type { NavMesh } from './nav-mesh';
import { createGetNodeAreaAndFlagsResult, getClosestPointOnPolyBoundary, getNodeAreaAndFlags } from './nav-mesh-api';
import { getPortalPoints } from './nav-mesh-search';
import { getNodeRefType, type NodeRef, NodeType } from './node';

export enum FindStraightPathOptions {
    ALL_CROSSINGS = 1,
    AREA_CROSSINGS = 2,
}

export enum StraightPathPointFlags {
    START = 0,
    END = 1,
    OFFMESH_CONNECTION = 2,
}

export type StraightPathPoint = {
    position: Vec3;
    type: NodeType;
    nodeRef: NodeRef | null;
    /** @see StraightPathPointFlags */
    flags: number;
};

export enum FindStraightPathResultFlags {
    NONE = 0,
    SUCCESS = 1 << 0,
    PARTIAL_PATH = 1 << 2,
    MAX_POINTS_REACHED = 1 << 3,
    INVALID_INPUT = 1 << 4,
}

export type FindStraightPathResult = {
    flags: FindStraightPathResultFlags;
    success: boolean;
    path: StraightPathPoint[];
};

enum AppendVertexStatus {
    SUCCESS = 1 << 0,
    MAX_POINTS_REACHED = 1 << 1,
    IN_PROGRESS = 1 << 2,
}

const appendVertex = (
    point: Vec3,
    ref: NodeRef | null,
    flags: number,
    outPoints: StraightPathPoint[],
    nodeType: NodeType,
    maxPoints: number | null = null,
): AppendVertexStatus => {
    if (outPoints.length > 0 && vec3.equals(outPoints[outPoints.length - 1].position, point)) {
        // the vertices are equal, update
        outPoints[outPoints.length - 1].nodeRef = ref;
        outPoints[outPoints.length - 1].type = nodeType;

        return AppendVertexStatus.IN_PROGRESS;
    }

    // append new vertex
    outPoints.push({
        position: [point[0], point[1], point[2]],
        type: nodeType,
        nodeRef: ref,
        flags,
    });

    // if there is no space to append more vertices, return
    if (maxPoints !== null && outPoints.length >= maxPoints) {
        return AppendVertexStatus.SUCCESS | AppendVertexStatus.MAX_POINTS_REACHED;
    }

    // if reached end of path, return
    if (flags & StraightPathPointFlags.END) {
        return AppendVertexStatus.SUCCESS;
    }

    // else, continue appending points
    return AppendVertexStatus.IN_PROGRESS;
};

const _intersectSegSeg2DResult: IntersectSegSeg2DResult = createIntersectSegSeg2DResult();

const _appendPortalsPoint = vec3.create();
const _appendPortalsLeft = vec3.create();
const _appendPortalsRight = vec3.create();
const _appendPortals_nodeAreaAndFlags_a = createGetNodeAreaAndFlagsResult();
const _appendPortals_nodeAreaAndFlags_b = createGetNodeAreaAndFlagsResult();

const appendPortals = (
    navMesh: NavMesh,
    startIdx: number,
    endIdx: number,
    endPos: Vec3,
    path: NodeRef[],
    outPoints: StraightPathPoint[],
    options: number,
    maxPoints: number | null = null,
): AppendVertexStatus => {
    const startPos = outPoints[outPoints.length - 1].position;

    for (let i = startIdx; i < endIdx; i++) {
        const from = path[i];
        const to = path[i + 1];

        // skip intersection if only area crossings requested and areas equal.
        if (options & FindStraightPathOptions.AREA_CROSSINGS) {
            const a = getNodeAreaAndFlags(_appendPortals_nodeAreaAndFlags_a, navMesh, from);
            const b = getNodeAreaAndFlags(_appendPortals_nodeAreaAndFlags_b, navMesh, to);

            if (a.success && b.success) {
                if (a.area === b.area) continue;
            }
        }

        // calculate portal
        const left = _appendPortalsLeft;
        const right = _appendPortalsRight;
        if (!getPortalPoints(navMesh, from, to, left, right)) {
            break;
        }

        // append intersection
        const intersectResult = intersectSegSeg2D(_intersectSegSeg2DResult, startPos, endPos, left, right);

        if (!intersectResult.hit) continue;

        const point = vec3.lerp(_appendPortalsPoint, left, right, intersectResult.t);

        const toType = getNodeRefType(to);

        const stat = appendVertex(point, to, 0, outPoints, toType, maxPoints);

        if (stat !== AppendVertexStatus.IN_PROGRESS) {
            return stat;
        }
    }

    return AppendVertexStatus.IN_PROGRESS;
};

const _findStraightPathLeftPortalPoint = vec3.create();
const _findStraightPathRightPortalPoint = vec3.create();
const _findStraightPath_distancePtSegSqr2dResult = createDistancePtSegSqr2dResult();

const makeFindStraightPathResult = (flags: FindStraightPathResultFlags, path: StraightPathPoint[]): FindStraightPathResult => ({
    flags,
    success: (flags & FindStraightPathResultFlags.SUCCESS) !== 0,
    path,
});

/**
 * This method peforms what is often called 'string pulling'.
 *
 * The start position is clamped to the first polygon node in the path, and the
 * end position is clamped to the last. So the start and end positions should
 * normally be within or very near the first and last polygons respectively.
 *
 * @param navMesh The navigation mesh to use for the search.
 * @param start The start position in world space.
 * @param end The end position in world space.
 * @param pathNodeRefs The list of polygon node references that form the path, generally obtained from `findNodePath`
 * @param maxPoints The maximum number of points to return in the straight path. If null, no limit is applied.
 * @param straightPathOptions @see FindStraightPathOptions
 * @returns The straight path
 */
export const findStraightPath = (
    navMesh: NavMesh,
    start: Vec3,
    end: Vec3,
    pathNodeRefs: NodeRef[],
    maxPoints: number | null = null,
    straightPathOptions = 0,
): FindStraightPathResult => {
    const path: StraightPathPoint[] = [];

    if (!vec3.finite(start) || !vec3.finite(end) || pathNodeRefs.length === 0) {
        return makeFindStraightPathResult(FindStraightPathResultFlags.NONE | FindStraightPathResultFlags.INVALID_INPUT, path);
    }

    // clamp start & end to poly boundaries
    const closestStartPos = vec3.create();
    if (!getClosestPointOnPolyBoundary(navMesh, pathNodeRefs[0], start, closestStartPos))
        return makeFindStraightPathResult(FindStraightPathResultFlags.NONE | FindStraightPathResultFlags.INVALID_INPUT, path);

    const closestEndPos = vec3.create();
    if (!getClosestPointOnPolyBoundary(navMesh, pathNodeRefs[pathNodeRefs.length - 1], end, closestEndPos))
        return makeFindStraightPathResult(FindStraightPathResultFlags.NONE | FindStraightPathResultFlags.INVALID_INPUT, path);

    // add start point
    const startAppendStatus = appendVertex(closestStartPos, pathNodeRefs[0], StraightPathPointFlags.START, path, getNodeRefType(pathNodeRefs[0]), maxPoints);

    if (startAppendStatus !== AppendVertexStatus.IN_PROGRESS) {
        // if we hit max points on the first vertex, it's a degenerate case
        const maxPointsReached = (startAppendStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;
        let flags = FindStraightPathResultFlags.SUCCESS | FindStraightPathResultFlags.PARTIAL_PATH;
        if (maxPointsReached) flags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;
        return makeFindStraightPathResult(flags, path);
    }

    const portalApex = vec3.create();
    const portalLeft = vec3.create();
    const portalRight = vec3.create();

    const pathSize = pathNodeRefs.length;

    if (pathSize > 1) {
        vec3.copy(portalApex, closestStartPos);
        vec3.copy(portalLeft, portalApex);
        vec3.copy(portalRight, portalApex);

        let apexIndex = 0;
        let leftIndex = 0;
        let rightIndex = 0;

        let leftNodeRef: NodeRef | null = pathNodeRefs[0];
        let rightNodeRef: NodeRef | null = pathNodeRefs[0];
        let leftNodeType: NodeType = NodeType.GROUND_POLY;
        let rightNodeType: NodeType = NodeType.GROUND_POLY;

        for (let i = 0; i < pathSize; ++i) {
            let toType: NodeType = NodeType.GROUND_POLY;

            const left = _findStraightPathLeftPortalPoint;
            const right = _findStraightPathRightPortalPoint;

            if (i + 1 < pathSize) {
                const toRef = pathNodeRefs[i + 1];
                toType = getNodeRefType(toRef);

                // next portal
                if (!getPortalPoints(navMesh, pathNodeRefs[i], toRef, left, right)) {
                    // failed to get portal points, clamp end to current poly and return partial
                    const endClamp = vec3.create();

                    // this should only happen when the first polygon is invalid.
                    if (!getClosestPointOnPolyBoundary(navMesh, pathNodeRefs[i], end, endClamp))
                        return makeFindStraightPathResult(FindStraightPathResultFlags.NONE | FindStraightPathResultFlags.INVALID_INPUT, path);

                    // append portals along the current straight path segment.
                    if (straightPathOptions & (FindStraightPathOptions.AREA_CROSSINGS | FindStraightPathOptions.ALL_CROSSINGS)) {
                        // ignore status return value as we're just about to return
                        appendPortals(navMesh, apexIndex, i, endClamp, pathNodeRefs, path, straightPathOptions, maxPoints);
                    }

                    const nodeType = getNodeRefType(pathNodeRefs[i]);

                    // ignore status return value as we're just about to return
                    appendVertex(endClamp, pathNodeRefs[i], 0, path, nodeType, maxPoints);

                    return makeFindStraightPathResult(FindStraightPathResultFlags.SUCCESS | FindStraightPathResultFlags.PARTIAL_PATH, path);
                }

                if (i === 0) {
                    // if starting really close to the portal, advance
                    const result = distancePtSegSqr2d(_findStraightPath_distancePtSegSqr2dResult, portalApex, left, right);
                    if (result.distSqr < 1e-6) continue;
                }
            } else {
                // end of path
                vec3.copy(left, closestEndPos);
                vec3.copy(right, closestEndPos);
                toType = NodeType.GROUND_POLY;
            }

            // right vertex
            if (triArea2D(portalApex, portalRight, right) <= 0.0) {
                if (vec3.equals(portalApex, portalRight) || triArea2D(portalApex, portalLeft, right) > 0.0) {
                    vec3.copy(portalRight, right);
                    rightNodeRef = i + 1 < pathSize ? pathNodeRefs[i + 1] : null;
                    rightNodeType = toType;
                    rightIndex = i;
                } else {
                    // append portals along current straight segment
                    if (straightPathOptions & (FindStraightPathOptions.AREA_CROSSINGS | FindStraightPathOptions.ALL_CROSSINGS)) {
                        const appendStatus = appendPortals(
                            navMesh,
                            apexIndex,
                            leftIndex,
                            portalLeft,
                            pathNodeRefs,
                            path,
                            straightPathOptions,
                            maxPoints,
                        );
                        if (appendStatus !== AppendVertexStatus.IN_PROGRESS) {
                            const maxPointsReached = (appendStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;
                            let flags = FindStraightPathResultFlags.SUCCESS | FindStraightPathResultFlags.PARTIAL_PATH;
                            if (maxPointsReached) flags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;
                            return makeFindStraightPathResult(flags, path);
                        }
                    }

                    vec3.copy(portalApex, portalLeft);
                    apexIndex = leftIndex;

                    let pointFlags = 0;
					if (!leftNodeRef) {
						pointFlags = StraightPathPointFlags.END;
                    } else if (leftNodeType === NodeType.OFFMESH_CONNECTION) {
						pointFlags = StraightPathPointFlags.OFFMESH_CONNECTION;
                    }

                    // append or update vertex
                    const appendStatus = appendVertex(
                        portalApex,
                        leftNodeRef,
                        pointFlags,
                        path,
                        leftNodeRef ? leftNodeType : NodeType.GROUND_POLY,
                        maxPoints,
                    );

                    if (appendStatus !== AppendVertexStatus.IN_PROGRESS) {
                        const maxPointsReached = (appendStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;

                        let resultFlags = 0;
                        resultFlags |= FindStraightPathResultFlags.SUCCESS;
                        if (maxPointsReached) resultFlags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;

                        return makeFindStraightPathResult(resultFlags, path);
                    }

                    vec3.copy(portalLeft, portalApex);
                    vec3.copy(portalRight, portalApex);
                    leftIndex = apexIndex;
                    rightIndex = apexIndex;

                    // restart
                    i = apexIndex;

                    continue;
                }
            }

            // left vertex
            if (triArea2D(portalApex, portalLeft, _findStraightPathLeftPortalPoint) >= 0.0) {
                if (
                    vec3.equals(portalApex, portalLeft) ||
                    triArea2D(portalApex, portalRight, _findStraightPathLeftPortalPoint) < 0.0
                ) {
                    vec3.copy(portalLeft, _findStraightPathLeftPortalPoint);
                    leftNodeRef = i + 1 < pathSize ? pathNodeRefs[i + 1] : null;
                    leftNodeType = toType;
                    leftIndex = i;
                } else {
                    // append portals along current straight segment
                    if (straightPathOptions & (FindStraightPathOptions.AREA_CROSSINGS | FindStraightPathOptions.ALL_CROSSINGS)) {
                        const appendStatus = appendPortals(
                            navMesh,
                            apexIndex,
                            rightIndex,
                            portalRight,
                            pathNodeRefs,
                            path,
                            straightPathOptions,
                            maxPoints,
                        );

                        if (appendStatus !== AppendVertexStatus.IN_PROGRESS) {
                            const maxPointsReached = (appendStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;
                            
                            let flags = FindStraightPathResultFlags.SUCCESS | FindStraightPathResultFlags.PARTIAL_PATH;
                            if (maxPointsReached) flags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;

                            return makeFindStraightPathResult(flags, path);
                        }
                    }

                    vec3.copy(portalApex, portalRight);
                    apexIndex = rightIndex;

                    let pointFlags = 0;
					if (!rightNodeRef) {
						pointFlags = StraightPathPointFlags.END;
                    } else if (rightNodeType === NodeType.OFFMESH_CONNECTION) {
						pointFlags = StraightPathPointFlags.OFFMESH_CONNECTION;
                    }

                    // add/update vertex
                    const appendStatus = appendVertex(
                        portalApex,
                        rightNodeRef,
                        pointFlags,
                        path,
                        rightNodeRef ? rightNodeType : NodeType.GROUND_POLY,
                        maxPoints,
                    );

                    if (appendStatus !== AppendVertexStatus.IN_PROGRESS) {
                        const maxPointsReached = (appendStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;

                        let resultFlags = 0;
                        resultFlags |= FindStraightPathResultFlags.SUCCESS;
                        if (maxPointsReached) resultFlags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;

                        return makeFindStraightPathResult(resultFlags, path);
                    }

                    vec3.copy(portalLeft, portalApex);
                    vec3.copy(portalRight, portalApex);
                    leftIndex = apexIndex;
                    rightIndex = apexIndex;

                    // restart
                    i = apexIndex;

                    continue;
                }
            }
        }

        // append portals along the current straight path segment
        if (straightPathOptions & (FindStraightPathOptions.AREA_CROSSINGS | FindStraightPathOptions.ALL_CROSSINGS)) {
            const appendStatus = appendPortals(
                navMesh,
                apexIndex,
                pathSize - 1,
                closestEndPos,
                pathNodeRefs,
                path,
                straightPathOptions,
                maxPoints,
            );
            if (appendStatus !== AppendVertexStatus.IN_PROGRESS) {
                const maxPointsReached = (appendStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;
                let flags = FindStraightPathResultFlags.SUCCESS | FindStraightPathResultFlags.PARTIAL_PATH;
                if (maxPointsReached) flags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;
                return makeFindStraightPathResult(flags, path);
            }
        }
    }

    // append end point
    // attach the last poly ref if available for the end point for easier identification
    const endRef = pathNodeRefs.length > 0 ? pathNodeRefs[pathNodeRefs.length - 1] : null;
    const endAppendStatus = appendVertex(closestEndPos, endRef, StraightPathPointFlags.END, path, NodeType.GROUND_POLY, maxPoints);
    const maxPointsReached = (endAppendStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;

    let resultFlags = FindStraightPathResultFlags.SUCCESS;
    if (maxPointsReached) resultFlags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;

    return makeFindStraightPathResult(resultFlags, path);
};
