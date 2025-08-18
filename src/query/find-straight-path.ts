import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import {
    createIntersectSegSeg2DResult,
    distancePtSeg2dSqr,
    type IntersectSegSeg2DResult,
    intersectSegSeg2D,
    triArea2D,
} from '../geometry';
import type { NavMesh } from './nav-mesh';
import {
    getClosestPointOnPolyBoundary,
    getNodeAreaAndFlags,
} from './nav-mesh-api';
import { getPortalPoints } from './nav-mesh-search';
import { getNodeRefType, type NodeRef, NodeType } from './node';

export const FIND_STRAIGHT_PATH_AREA_CROSSINGS = 1;
export const FIND_STRAIGHT_PATH_ALL_CROSSINGS = 2;

export type StraightPathPoint = {
    position: Vec3;
    type: NodeType;
    nodeRef: NodeRef | null;
};

enum AppendVertexStatus {
    SUCCESS = 0x1,
    MAX_POINTS_REACHED = 0x2,
    IN_PROGRESS = 0x4,
}

const appendVertex = (
    point: Vec3,
    ref: NodeRef | null,
    outPoints: StraightPathPoint[],
    nodeType: NodeType,
    isEnd: boolean,
    maxPoints: number | null = null,
): AppendVertexStatus => {
    if (
        outPoints.length > 0 &&
        vec3.equals(outPoints[outPoints.length - 1].position, point)
    ) {
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
    });

    // if there is no space to append more vertices, return
    if (maxPoints !== null && outPoints.length >= maxPoints) {
        return (
            AppendVertexStatus.SUCCESS & AppendVertexStatus.MAX_POINTS_REACHED
        );
    }

    // if reached end of path, return
    if (isEnd) {
        return AppendVertexStatus.SUCCESS;
    }

    // else, continue appending points
    return AppendVertexStatus.IN_PROGRESS;
};

const _intersectSegSeg2DResult: IntersectSegSeg2DResult =
    createIntersectSegSeg2DResult();

const _appendPortalsPoint = vec3.create();
const _appendPortalsLeft = vec3.create();
const _appendPortalsRight = vec3.create();

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
        if (options & FIND_STRAIGHT_PATH_AREA_CROSSINGS) {
            const a = getNodeAreaAndFlags(from, navMesh);
            const b = getNodeAreaAndFlags(to, navMesh);

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
        const intersectResult = intersectSegSeg2D(
            _intersectSegSeg2DResult,
            startPos,
            endPos,
            left,
            right,
        );

        if (!intersectResult.hit) continue;

        const point = vec3.lerp(
            _appendPortalsPoint,
            left,
            right,
            intersectResult.t,
        );

        const toType = getNodeRefType(to);

        const stat = appendVertex(
            point,
            to,
            outPoints,
            toType,
            false,
            maxPoints,
        );

        if (stat !== AppendVertexStatus.IN_PROGRESS) {
            return stat;
        }
    }

    return AppendVertexStatus.IN_PROGRESS;
};

export enum FindStraightPathStatus {
    INVALID_INPUT = 0,
    PARTIAL_PATH = 1,
    COMPLETE_PATH = 2,
}

export type FindStraightPathResult = {
    success: boolean;
    status: FindStraightPathStatus;
    path: StraightPathPoint[];
};

const _findStraightPathLeftPortalPoint = vec3.create();
const _findStraightPathRightPortalPoint = vec3.create();

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
 * @param straightPathOptions
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
        return {
            success: false,
            path,
            status: FindStraightPathStatus.INVALID_INPUT,
        };
    }

    // clamp start & end to poly boundaries
    const closestStartPos = vec3.create();
    if (
        !getClosestPointOnPolyBoundary(
            navMesh,
            pathNodeRefs[0],
            start,
            closestStartPos,
        )
    )
        return {
            success: false,
            path,
            status: FindStraightPathStatus.INVALID_INPUT,
        };

    const closestEndPos = vec3.create();
    if (
        !getClosestPointOnPolyBoundary(
            navMesh,
            pathNodeRefs[pathNodeRefs.length - 1],
            end,
            closestEndPos,
        )
    )
        return {
            success: false,
            path,
            status: FindStraightPathStatus.INVALID_INPUT,
        };

    // add start point
    if (
        !appendVertex(
            closestStartPos,
            pathNodeRefs[0],
            path,
            getNodeRefType(pathNodeRefs[0]),
            false,
            maxPoints,
        )
    ) {
        return {
            success: true,
            path,
            status: FindStraightPathStatus.PARTIAL_PATH,
        }; // reached max points early
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
                if (
                    !getPortalPoints(
                        navMesh,
                        pathNodeRefs[i],
                        toRef,
                        left,
                        right,
                    )
                ) {
                    // failed to get portal points, clamp end to current poly and return partial
                    const endClamp = vec3.create();

                    // this should only happen when the first polygon is invalid.
                    if (
                        !getClosestPointOnPolyBoundary(
                            navMesh,
                            pathNodeRefs[i],
                            end,
                            endClamp,
                        )
                    )
                        return {
                            success: false,
                            path,
                            status: FindStraightPathStatus.INVALID_INPUT,
                        };

                    // append portals along the current straight path segment.
                    if (
                        straightPathOptions &
                        (FIND_STRAIGHT_PATH_AREA_CROSSINGS |
                            FIND_STRAIGHT_PATH_ALL_CROSSINGS)
                    ) {
                        // ignore status return value as we're just about to return
                        appendPortals(
                            navMesh,
                            apexIndex,
                            i,
                            endClamp,
                            pathNodeRefs,
                            path,
                            straightPathOptions,
                            maxPoints,
                        );
                    }

                    const nodeType = getNodeRefType(pathNodeRefs[i]);
                    const isEnd = !leftNodeRef;

                    // ignore status return value as we're just about to return
                    appendVertex(
                        endClamp,
                        pathNodeRefs[i],
                        path,
                        nodeType,
                        isEnd,
                        maxPoints,
                    );

                    // return partial result
                    return {
                        success: true,
                        path,
                        status: FindStraightPathStatus.PARTIAL_PATH,
                    };
                }

                if (i === 0) {
                    // if starting really close to the portal, advance
                    const d2 = distancePtSeg2dSqr(portalApex, left, right);
                    if (d2 < 1e-6) continue;
                }
            } else {
                // end of path
                vec3.copy(left, closestEndPos);
                vec3.copy(right, closestEndPos);
                toType = NodeType.GROUND_POLY;
            }

            // right vertex
            if (triArea2D(portalApex, portalRight, right) <= 0.0) {
                if (
                    vec3.equals(portalApex, portalRight) ||
                    triArea2D(portalApex, portalLeft, right) > 0.0
                ) {
                    vec3.copy(portalRight, right);
                    rightNodeRef =
                        i + 1 < pathSize ? pathNodeRefs[i + 1] : null;
                    rightNodeType = toType;
                    rightIndex = i;
                } else {
                    // append portals along current straight segment
                    if (
                        straightPathOptions &
                        (FIND_STRAIGHT_PATH_AREA_CROSSINGS |
                            FIND_STRAIGHT_PATH_ALL_CROSSINGS)
                    ) {
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
                            return {
                                success: true,
                                path,
                                status: FindStraightPathStatus.PARTIAL_PATH,
                            };
                        }
                    }

                    vec3.copy(portalApex, portalLeft);
                    apexIndex = leftIndex;
                    const isEnd = !leftNodeRef;

                    // append or update vertex
                    const appendStatus = appendVertex(
                        portalApex,
                        leftNodeRef,
                        path,
                        leftNodeRef ? leftNodeType : NodeType.GROUND_POLY,
                        isEnd,
                        maxPoints,
                    );

                    if (appendStatus !== AppendVertexStatus.IN_PROGRESS) {
                        const status =
                            isEnd &&
                            (appendStatus &
                                AppendVertexStatus.MAX_POINTS_REACHED) ===
                                0
                                ? FindStraightPathStatus.COMPLETE_PATH
                                : FindStraightPathStatus.PARTIAL_PATH;
                        return { success: true, path, status };
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
            if (
                triArea2D(
                    portalApex,
                    portalLeft,
                    _findStraightPathLeftPortalPoint,
                ) >= 0.0
            ) {
                if (
                    vec3.equals(portalApex, portalLeft) ||
                    triArea2D(
                        portalApex,
                        portalRight,
                        _findStraightPathLeftPortalPoint,
                    ) < 0.0
                ) {
                    vec3.copy(portalLeft, _findStraightPathLeftPortalPoint);
                    leftNodeRef = i + 1 < pathSize ? pathNodeRefs[i + 1] : null;
                    leftNodeType = toType;
                    leftIndex = i;
                } else {
                    // append portals along current straight segment
                    if (
                        straightPathOptions &
                        (FIND_STRAIGHT_PATH_AREA_CROSSINGS |
                            FIND_STRAIGHT_PATH_ALL_CROSSINGS)
                    ) {
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
                            return {
                                success: true,
                                path,
                                status: FindStraightPathStatus.PARTIAL_PATH,
                            };
                        }
                    }

                    vec3.copy(portalApex, portalRight);
                    apexIndex = rightIndex;
                    const isEnd = !rightNodeRef;

                    // add/update vertex
                    const appendStatus = appendVertex(
                        portalApex,
                        rightNodeRef,
                        path,
                        rightNodeRef ? rightNodeType : NodeType.GROUND_POLY,
                        isEnd,
                        maxPoints,
                    );

                    if (appendStatus !== AppendVertexStatus.IN_PROGRESS) {
                        const status =
                            isEnd &&
                            (appendStatus &
                                AppendVertexStatus.MAX_POINTS_REACHED) ===
                                0
                                ? FindStraightPathStatus.COMPLETE_PATH
                                : FindStraightPathStatus.PARTIAL_PATH;
                        return { success: true, path, status };
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
        if (
            straightPathOptions &
            (FIND_STRAIGHT_PATH_AREA_CROSSINGS |
                FIND_STRAIGHT_PATH_ALL_CROSSINGS)
        ) {
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
                return {
                    success: true,
                    path,
                    status: FindStraightPathStatus.PARTIAL_PATH,
                };
            }
        }
    }

    // append end point
    // attach the last poly ref if available for the end point for easier identification
    const endRef =
        pathNodeRefs.length > 0 ? pathNodeRefs[pathNodeRefs.length - 1] : null;
    const isEnd = true;

    appendVertex(
        closestEndPos,
        endRef,
        path,
        NodeType.GROUND_POLY,
        isEnd,
        maxPoints,
    );

    return {
        success: true,
        path,
        status: FindStraightPathStatus.COMPLETE_PATH,
    };
};
