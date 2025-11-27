import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import {
    createDistancePtSegSqr2dResult,
    createIntersectSegSeg2DResult,
    distancePtSegSqr2d,
    type IntersectSegSeg2DResult,
    intersectSegSeg2D,
    triArea2D,
} from '../geometry';
import type { NavMesh } from './nav-mesh';
import { getClosestPointOnPolyBoundary, getNodeByRef } from './nav-mesh-api';
import { getPortalPoints } from './nav-mesh-search';
import { getNodeRefType, type NodeRef, NodeType } from './node';

export enum FindStraightPathOptions {
    ALL_CROSSINGS = 1,
    AREA_CROSSINGS = 2,
}

export enum StraightPathPointFlags {
    START = 0,
    END = 1,
    OFFMESH = 2,
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
    position: Vec3,
    nodeRef: NodeRef | null,
    flags: number,
    outPoints: StraightPathPoint[],
    nodeType: NodeType,
    maxPoints: number | null = null,
): AppendVertexStatus => {
    if (outPoints.length > 0 && vec3.equals(outPoints[outPoints.length - 1].position, position)) {
        const prevType = outPoints[outPoints.length - 1].type;

        // only update if both points are regular polygon nodes
        // off-mesh connections should always be distinct waypoints
        if (prevType === NodeType.POLY && nodeType === NodeType.POLY) {
            // the vertices are equal, update
            outPoints[outPoints.length - 1].nodeRef = nodeRef;
            outPoints[outPoints.length - 1].type = nodeType;

            return AppendVertexStatus.IN_PROGRESS;
        }

        // for off-mesh connections or mixed types, fall through to append a new point
    }

    // append new vertex
    outPoints.push({
        position: [position[0], position[1], position[2]],
        type: nodeType,
        nodeRef: nodeRef,
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

const appendPortals = (
    navMesh: NavMesh,
    startIdx: number,
    endIdx: number,
    endPosition: Vec3,
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
            const a = getNodeByRef(navMesh, from);
            const b = getNodeByRef(navMesh, to);

            if (a.area === b.area) continue;
        }

        // calculate portal
        const left = _appendPortalsLeft;
        const right = _appendPortalsRight;
        if (!getPortalPoints(navMesh, from, to, left, right)) {
            break;
        }

        // append intersection
        const intersectResult = intersectSegSeg2D(_intersectSegSeg2DResult, startPos, endPosition, left, right);

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
    if (!getClosestPointOnPolyBoundary(closestStartPos, navMesh, pathNodeRefs[0], start))
        return makeFindStraightPathResult(FindStraightPathResultFlags.NONE | FindStraightPathResultFlags.INVALID_INPUT, path);

    const closestEndPos = vec3.create();
    if (!getClosestPointOnPolyBoundary(closestEndPos, navMesh, pathNodeRefs[pathNodeRefs.length - 1], end))
        return makeFindStraightPathResult(FindStraightPathResultFlags.NONE | FindStraightPathResultFlags.INVALID_INPUT, path);

    // add start point
    const startAppendStatus = appendVertex(
        closestStartPos,
        pathNodeRefs[0],
        StraightPathPointFlags.START,
        path,
        getNodeRefType(pathNodeRefs[0]),
        maxPoints,
    );

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
        let leftNodeType: NodeType = NodeType.POLY;
        let rightNodeType: NodeType = NodeType.POLY;

        for (let i = 0; i < pathSize; ++i) {
            let toType: NodeType = NodeType.POLY;

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
                    if (!getClosestPointOnPolyBoundary(endClamp, navMesh, pathNodeRefs[i], end))
                        return makeFindStraightPathResult(
                            FindStraightPathResultFlags.NONE | FindStraightPathResultFlags.INVALID_INPUT,
                            path,
                        );

                    // append portals along the current straight path segment.
                    if (straightPathOptions & (FindStraightPathOptions.AREA_CROSSINGS | FindStraightPathOptions.ALL_CROSSINGS)) {
                        // ignore status return value as we're just about to return
                        appendPortals(navMesh, apexIndex, i, endClamp, pathNodeRefs, path, straightPathOptions, maxPoints);
                    }

                    const nodeType = getNodeRefType(pathNodeRefs[i]);

                    // ignore status return value as we're just about to return
                    appendVertex(endClamp, pathNodeRefs[i], 0, path, nodeType, maxPoints);

                    return makeFindStraightPathResult(
                        FindStraightPathResultFlags.SUCCESS | FindStraightPathResultFlags.PARTIAL_PATH,
                        path,
                    );
                }

                if (i === 0 && toType === NodeType.POLY) {
                    // if starting really close to the portal, advance
                    const result = distancePtSegSqr2d(_findStraightPath_distancePtSegSqr2dResult, portalApex, left, right);
                    if (result.distSqr < 1e-6) continue;
                }

                // handle off-mesh connections explicitly
                // off-mesh connections should not be subject to string-pulling optimization
                if (toType === NodeType.OFFMESH) {
                    // get the off-mesh connection data
                    const node = getNodeByRef(navMesh, toRef);
                    const offMeshConnection = navMesh.offMeshConnections[node.offMeshConnectionId];
                    const offMeshConnectionAttachment = navMesh.offMeshConnectionAttachments[node.offMeshConnectionId];

                    // find the link from the previous poly to the off-mesh node to determine direction
                    const prevPolyRef = pathNodeRefs[i];
                    const prevNode = getNodeByRef(navMesh, prevPolyRef);
                    let linkEdge = 0; // default to START

                    for (const linkIndex of prevNode.links) {
                        const link = navMesh.links[linkIndex];
                        if (link.toNodeRef === toRef) {
                            linkEdge = link.edge;
                            break;
                        }
                    }

                    // use the link edge to determine direction
                    // edge 0 = entering from START side, edge 1 = entering from END side
                    const enteringFromStart = linkEdge === 0;

                    // determine start and end based on which side of the connection we're entering from
                    const offMeshStart = enteringFromStart ? offMeshConnection.start : offMeshConnection.end;
                    const offMeshEnd = enteringFromStart ? offMeshConnection.end : offMeshConnection.start;

                    // get the target polygon we'll land on after the off-mesh connection
                    const toPolyRef = enteringFromStart
                        ? offMeshConnectionAttachment.endPolyNode
                        : offMeshConnectionAttachment.startPolyNode;

                    // append any pending portals along the current straight path segment
                    // this ensures we add intermediate waypoints between the current apex and the off-mesh connection start
                    const appendPortalsStatus = appendPortals(
                        navMesh,
                        apexIndex,
                        i,
                        offMeshStart,
                        pathNodeRefs,
                        path,
                        straightPathOptions,
                        maxPoints,
                    );
                    if (appendPortalsStatus !== AppendVertexStatus.IN_PROGRESS) {
                        const maxPointsReached = (appendPortalsStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;
                        let flags = FindStraightPathResultFlags.SUCCESS | FindStraightPathResultFlags.PARTIAL_PATH;
                        if (maxPointsReached) flags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;
                        return makeFindStraightPathResult(flags, path);
                    }

                    // append the off-mesh connection start point (with OFFMESH flag)
                    const appendStartStatus = appendVertex(
                        offMeshStart,
                        toRef,
                        StraightPathPointFlags.OFFMESH,
                        path,
                        NodeType.OFFMESH,
                        maxPoints,
                    );

                    if (appendStartStatus !== AppendVertexStatus.IN_PROGRESS) {
                        const maxPointsReached = (appendStartStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;
                        let resultFlags = FindStraightPathResultFlags.SUCCESS;
                        if (maxPointsReached) resultFlags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;
                        return makeFindStraightPathResult(resultFlags, path);
                    }

                    // append the off-mesh connection end point (landing point on target polygon)
                    const appendEndStatus = appendVertex(offMeshEnd, toPolyRef, 0, path, NodeType.POLY, maxPoints);

                    if (appendEndStatus !== AppendVertexStatus.IN_PROGRESS) {
                        const maxPointsReached = (appendEndStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;
                        let resultFlags = FindStraightPathResultFlags.SUCCESS;
                        if (maxPointsReached) resultFlags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;
                        return makeFindStraightPathResult(resultFlags, path);
                    }

                    // reset the funnel, we should start from the ground poly at the end of the off-mesh connection
                    vec3.copy(portalApex, offMeshEnd);
                    vec3.copy(portalLeft, offMeshEnd);
                    vec3.copy(portalRight, offMeshEnd);
                    // set apex to the landing polygon (i+1) rather than the off-mesh node (i)
                    // this prevents infinite loops: if the funnel restarts via `i = apexIndex`,
                    // we want to restart from the landing polygon, not re-enter the off-mesh handler
                    apexIndex = i + 1;
                    leftIndex = i + 1;
                    rightIndex = i + 1;
                    leftNodeRef = toPolyRef;
                    rightNodeRef = toPolyRef;
                    leftNodeType = NodeType.POLY;
                    rightNodeType = NodeType.POLY;

                    // skip normal funnel processing for this off-mesh connection
                    continue;
                }
            } else {
                // end of path
                vec3.copy(left, closestEndPos);
                vec3.copy(right, closestEndPos);
                toType = NodeType.POLY;
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
                    if (leftNodeRef === null) {
                        pointFlags = StraightPathPointFlags.END;
                    }
                    // note: leftNodeType can never be OFFMESH here because off-mesh connections are handled explicitly above

                    // append or update vertex
                    const appendStatus = appendVertex(
                        portalApex,
                        leftNodeRef,
                        pointFlags,
                        path,
                        leftNodeRef !== null ? leftNodeType : NodeType.POLY,
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
            if (triArea2D(portalApex, portalLeft, left) >= 0.0) {
                if (vec3.equals(portalApex, portalLeft) || triArea2D(portalApex, portalRight, left) < 0.0) {
                    vec3.copy(portalLeft, left);
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
                    if (rightNodeRef === null) {
                        pointFlags = StraightPathPointFlags.END;
                    }
                    // note: rightNodeType can never be OFFMESH here because off-mesh connections are handled explicitly above

                    // add/update vertex
                    const appendStatus = appendVertex(
                        portalApex,
                        rightNodeRef,
                        pointFlags,
                        path,
                        rightNodeRef !== null ? rightNodeType : NodeType.POLY,
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
    const endAppendStatus = appendVertex(closestEndPos, endRef, StraightPathPointFlags.END, path, NodeType.POLY, maxPoints);
    const maxPointsReached = (endAppendStatus & AppendVertexStatus.MAX_POINTS_REACHED) !== 0;

    let resultFlags = FindStraightPathResultFlags.SUCCESS;
    if (maxPointsReached) resultFlags |= FindStraightPathResultFlags.MAX_POINTS_REACHED;

    return makeFindStraightPathResult(resultFlags, path);
};
