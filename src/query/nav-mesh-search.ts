import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import {
    closestPtSeg2d,
    createIntersectSegmentPoly2DResult,
    createIntersectSegSeg2DResult,
    distancePtSeg2dSqr,
    type IntersectSegSeg2DResult,
    intersectSegmentPoly2D,
    intersectSegSeg2D,
    pointInPoly,
    randomPointInConvexPoly,
    triArea2D,
} from '../geometry';
import {
    type NavMesh,
    type NavMeshLink,
    type NavMeshPoly,
    type NavMeshTile,
    OffMeshConnectionSide,
} from './nav-mesh';
import {
    createFindNearestPolyResult,
    createGetClosestPointOnPolyResult,
    findNearestPoly,
    getClosestPointOnPoly,
    getClosestPointOnPolyBoundary,
    getNodeAreaAndFlags,
    getTileAndPolyByRef,
} from './nav-mesh-query';
import {
    desNodeRef,
    getNodeRefType,
    type NodeRef,
    NodeType,
    serPolyNodeRef,
} from './node';
import { DEFAULT_QUERY_FILTER, type QueryFilter } from './query-filter';

export const NODE_FLAG_OPEN = 0x01;
export const NODE_FLAG_CLOSED = 0x02;

/** parent of the node is not adjacent. Found using raycast. */
export const NODE_FLAG_PARENT_DETACHED = 0x04;

/** `${poly ref}:{search node state}` */
export type SearchNodeRef = `${NodeRef}:${number}`;

export type SearchNode = {
    /** the position of the node */
    position: Vec3;
    /** the cost from the previous node to this node */
    cost: number;
    /** the cost up to this node */
    total: number;
    /** the index to the parent node */
    parent: SearchNodeRef | null;
    /** node state */
    state: number;
    /** node flags */
    flags: number;
    /** the node ref for this search node */
    nodeRef: NodeRef;
};

export type SearchNodePool = { [nodeRefAndState: SearchNodeRef]: SearchNode };

export type SearchNodeQueue = SearchNode[];

const bubbleUpQueue = (queue: SearchNodeQueue, i: number, node: SearchNode) => {
    // note: (index > 0) means there is a parent
    let parent = Math.floor((i - 1) / 2);

    while (i > 0 && queue[parent].total > node.total) {
        queue[i] = queue[parent];
        i = parent;
        parent = Math.floor((i - 1) / 2);
    }

    queue[i] = node;
};

const trickleDownQueue = (
    queue: SearchNodeQueue,
    i: number,
    node: SearchNode,
) => {
    const count = queue.length;
    let child = 2 * i + 1;

    while (child < count) {
        // if there is a right child and it is smaller than the left child
        if (child + 1 < count && queue[child + 1].total < queue[child].total) {
            child++;
        }

        // if the current node is smaller than the smallest child, we are done
        if (node.total <= queue[child].total) {
            break;
        }

        // move the smallest child up
        queue[i] = queue[child];
        i = child;
        child = i * 2 + 1;
    }

    queue[i] = node;
};

const pushNodeToQueue = (queue: SearchNodeQueue, node: SearchNode): void => {
    queue.push(node);
    bubbleUpQueue(queue, queue.length - 1, node);
};

const popNodeFromQueue = (queue: SearchNodeQueue): SearchNode | undefined => {
    if (queue.length === 0) {
        return undefined;
    }

    const node = queue[0];
    const lastNode = queue.pop();

    if (queue.length > 0 && lastNode !== undefined) {
        queue[0] = lastNode;
        trickleDownQueue(queue, 0, lastNode);
    }

    return node;
};

const reindexNodeInQueue = (queue: SearchNodeQueue, node: SearchNode): void => {
    for (let i = 0; i < queue.length; i++) {
        if (
            queue[i].nodeRef === node.nodeRef &&
            queue[i].state === node.state
        ) {
            queue[i] = node;
            bubbleUpQueue(queue, i, node);
            return;
        }
    }
};

const _getPortalPointsStart = vec3.create();
const _getPortalPointsEnd = vec3.create();

const getPortalPoints = (
    navMesh: NavMesh,
    fromNodeRef: NodeRef,
    toNodeRef: NodeRef,
    outLeft: Vec3,
    outRight: Vec3,
): boolean => {
    // find the link that points to the 'to' polygon.
    let toLink: NavMeshLink | undefined;

    const fromPolyLinks = navMesh.nodes[fromNodeRef];

    for (const linkIndex of fromPolyLinks) {
        const link = navMesh.links[linkIndex];
        if (link?.neighbourRef === toNodeRef) {
            // found the link to the target polygon.
            toLink = link;
            break;
        }
    }

    if (!toLink) {
        // no link found to the target polygon.
        return false;
    }

    const fromNodeType = getNodeRefType(fromNodeRef);
    const toNodeType = getNodeRefType(toNodeRef);

    // assume either:
    // - poly to poly
    // - offmesh to poly
    // - poly to offmesh
    // offmesh to offmesh is not supported

    // handle from offmesh connection to poly
    if (fromNodeType === NodeType.OFFMESH_CONNECTION) {
        const [, offMeshConnectionId, offMeshConnectionSide] =
            desNodeRef(fromNodeRef);
        const offMeshConnection =
            navMesh.offMeshConnections[offMeshConnectionId];
        if (!offMeshConnection) return false;

        const position =
            offMeshConnectionSide === OffMeshConnectionSide.START
                ? offMeshConnection.start
                : offMeshConnection.end;

        vec3.copy(outLeft, position);
        vec3.copy(outRight, position);
        return true;
    }

    // handle from poly to offmesh connection
    if (toNodeType === NodeType.OFFMESH_CONNECTION) {
        const [, offMeshConnectionId, offMeshConnectionSide] =
            desNodeRef(toNodeRef);
        const offMeshConnection =
            navMesh.offMeshConnections[offMeshConnectionId];
        if (!offMeshConnection) return false;

        const position =
            offMeshConnectionSide === OffMeshConnectionSide.START
                ? offMeshConnection.start
                : offMeshConnection.end;

        vec3.copy(outLeft, position);
        vec3.copy(outRight, position);
        return true;
    }

    // handle from poly to poly

    // get the 'from' and 'to' tiles
    const [, fromTileId, fromPolyIndex] = desNodeRef(fromNodeRef);
    const fromTile = navMesh.tiles[fromTileId];
    const fromPoly = fromTile.polys[fromPolyIndex];

    // find portal vertices
    const v0Index = fromPoly.vertices[toLink.edge];
    const v1Index =
        fromPoly.vertices[(toLink.edge + 1) % fromPoly.vertices.length];

    vec3.fromBuffer(outLeft, fromTile.vertices, v0Index * 3);
    vec3.fromBuffer(outRight, fromTile.vertices, v1Index * 3);

    // if the link is at tile boundary, clamp the vertices to the link width.
    if (toLink.side !== 0xff) {
        // unpack portal limits.
        if (toLink.bmin !== 0 || toLink.bmax !== 255) {
            const s = 1.0 / 255.0;
            const tmin = toLink.bmin * s;
            const tmax = toLink.bmax * s;

            vec3.fromBuffer(
                _getPortalPointsStart,
                fromTile.vertices,
                v0Index * 3,
            );
            vec3.fromBuffer(
                _getPortalPointsEnd,
                fromTile.vertices,
                v1Index * 3,
            );
            vec3.lerp(
                outLeft,
                _getPortalPointsStart,
                _getPortalPointsEnd,
                tmin,
            );
            vec3.lerp(
                outRight,
                _getPortalPointsStart,
                _getPortalPointsEnd,
                tmax,
            );
        }
    }

    return true;
};

const _edgeMidPointPortalLeft = vec3.create();
const _edgeMidPointPortalRight = vec3.create();

const getEdgeMidPoint = (
    navMesh: NavMesh,
    fromNodeRef: NodeRef,
    toNodeRef: NodeRef,
    outMidPoint: Vec3,
): boolean => {
    if (
        !getPortalPoints(
            navMesh,
            fromNodeRef,
            toNodeRef,
            _edgeMidPointPortalLeft,
            _edgeMidPointPortalRight,
        )
    ) {
        return false;
    }

    outMidPoint[0] =
        (_edgeMidPointPortalLeft[0] + _edgeMidPointPortalRight[0]) * 0.5;
    outMidPoint[1] =
        (_edgeMidPointPortalLeft[1] + _edgeMidPointPortalRight[1]) * 0.5;
    outMidPoint[2] =
        (_edgeMidPointPortalLeft[2] + _edgeMidPointPortalRight[2]) * 0.5;

    return true;
};

const isValidNodeRef = (navMesh: NavMesh, nodeRef: NodeRef): boolean => {
    const nodeType = getNodeRefType(nodeRef);

    if (nodeType === NodeType.GROUND_POLY) {
        const [, tileId, polyIndex] = desNodeRef(nodeRef);

        const tile = navMesh.tiles[tileId];

        if (!tile) {
            return false;
        }

        if (polyIndex < 0 || polyIndex >= tile.polys.length) {
            return false;
        }

        const poly = tile.polys[polyIndex];

        if (!poly) {
            return false;
        }

        return true;
    }

    if (nodeType === NodeType.OFFMESH_CONNECTION) {
        const [, offMeshConnectionId] = desNodeRef(nodeRef);
        const offMeshConnection =
            navMesh.offMeshConnections[offMeshConnectionId];
        // TODO: check if off mesh connection is connected?
        return !!offMeshConnection;
    }

    return false;
};

export enum FindNodePathStatus {
    INVALID_INPUT = 0,
    PARTIAL_PATH = 1,
    COMPLETE_PATH = 2,
}

export type FindNodePathResult = {
    /** whether the search completed successfully, with either a partial or complete path */
    success: boolean;

    /** the result status for the operation */
    status: FindNodePathStatus;

    /** the path, consisting of polygon node and offmesh link node references */
    path: NodeRef[];

    /** intermediate data used for the search, typically only needed for debugging */
    intermediates?: {
        nodes: SearchNodePool;
        openList: SearchNodeQueue;
    };
};

const HEURISTIC_SCALE = 0.999; // Search heuristic scale

/**
 * Find a path between two nodes.
 *
 * If the end node cannot be reached through the navigation graph,
 * the last node in the path will be the nearest the end node.
 *
 * The start and end positions are used to calculate traversal costs.
 * (The y-values impact the result.)
 *
 * @param startRef The reference ID of the starting node.
 * @param endRef The reference ID of the ending node.
 * @param startPos The starting position in world space.
 * @param endPos The ending position in world space.
 * @param filter The query filter.
 * @returns The result of the pathfinding operation.
 */
export const findNodePath = (
    navMesh: NavMesh,
    startRef: NodeRef,
    endRef: NodeRef,
    startPos: Vec3,
    endPos: Vec3,
    filter: QueryFilter,
): FindNodePathResult => {
    // validate input
    if (
        !isValidNodeRef(navMesh, startRef) ||
        !isValidNodeRef(navMesh, endRef) ||
        !vec3.finite(startPos) ||
        !vec3.finite(endPos)
    ) {
        return {
            status: FindNodePathStatus.INVALID_INPUT,
            success: false,
            path: [],
        };
    }

    // early exit if start and end are the same
    if (startRef === endRef) {
        return {
            status: FindNodePathStatus.COMPLETE_PATH,
            success: true,
            path: [startRef],
        };
    }

    // prepare search
    const getCost = filter.getCost ?? DEFAULT_QUERY_FILTER.getCost;

    const nodes: SearchNodePool = {};
    const openList: SearchNodeQueue = [];

    const startNode: SearchNode = {
        cost: 0,
        total: vec3.distance(startPos, endPos) * HEURISTIC_SCALE,
        parent: null,
        nodeRef: startRef,
        state: 0,
        flags: NODE_FLAG_OPEN,
        position: structuredClone(startPos),
    };
    nodes[`${startRef}:0`] = startNode;
    pushNodeToQueue(openList, startNode);

    let lastBestNode: SearchNode = startNode;
    let lastBestNodeCost = startNode.total;

    while (openList.length > 0) {
        // remove node from the open list and put it in the closed list
        const currentNode = popNodeFromQueue(openList)!;
        currentNode.flags &= ~NODE_FLAG_OPEN;
        currentNode.flags |= NODE_FLAG_CLOSED;

        // if we have reached the goal, stop searching
        const currentNodeRef = currentNode.nodeRef;
        if (currentNodeRef === endRef) {
            lastBestNode = currentNode;
            break;
        }

        // get current node
        const currentNodeLinks = navMesh.nodes[currentNodeRef];

        // get parent node ref
        let parentNodeRef: NodeRef | undefined;
        if (currentNode.parent) {
            const [nodeRef, _state] = currentNode.parent.split(':');
            parentNodeRef = nodeRef as NodeRef;
        }

        // expand the search with node links
        for (const linkIndex of currentNodeLinks) {
            const link = navMesh.links[linkIndex];
            const neighbourNodeRef = link.neighbourRef;

            // skip invalid ids and do not expand back to where we came from
            if (!neighbourNodeRef || neighbourNodeRef === parentNodeRef) {
                continue;
            }

            // check whether neighbour passes the filter
            if (
                filter.passFilter &&
                filter.passFilter(neighbourNodeRef, navMesh, filter) === false
            ) {
                continue;
            }

            // deal explicitly with crossing tile boundaries by partitioning the search node refs by crossing side
            let crossSide = 0;
            if (link.side !== 0xff) {
                crossSide = link.side >> 1;
            }

            // get the neighbour node
            const neighbourSearchNodeRef: SearchNodeRef = `${neighbourNodeRef}:${crossSide}`;
            let neighbourNode = nodes[neighbourSearchNodeRef];
            if (!neighbourNode) {
                neighbourNode = {
                    cost: 0,
                    total: 0,
                    parent: null,
                    nodeRef: neighbourNodeRef,
                    state: crossSide,
                    flags: 0,
                    position: structuredClone(endPos),
                };
                nodes[neighbourSearchNodeRef] = neighbourNode;
            }

            // if this node is being visited for the first time, calculate the node position
            if (neighbourNode.flags === 0) {
                getEdgeMidPoint(
                    navMesh,
                    currentNodeRef,
                    neighbourNodeRef,
                    neighbourNode.position,
                );
            }

            // calculate cost and heuristic
            let cost = 0;
            let heuristic = 0;

            // special case for last node
            if (neighbourNodeRef === endRef) {
                const curCost = getCost(
                    currentNode.position,
                    neighbourNode.position,
                    navMesh,
                    neighbourNodeRef,
                    currentNodeRef,
                    undefined,
                );

                const endCost = getCost(
                    neighbourNode.position,
                    endPos,
                    navMesh,
                    neighbourNodeRef,
                    currentNodeRef,
                    undefined,
                );

                cost = currentNode.cost + curCost + endCost;
                heuristic = 0;
            } else {
                const curCost = getCost(
                    currentNode.position,
                    neighbourNode.position,
                    navMesh,
                    parentNodeRef,
                    currentNodeRef,
                    neighbourNodeRef,
                );
                cost = currentNode.cost + curCost;
                heuristic =
                    vec3.distance(neighbourNode.position, endPos) *
                    HEURISTIC_SCALE;
            }

            const total = cost + heuristic;

            // if the node is already in the open list, and the new result is worse, skip
            if (
                neighbourNode.flags & NODE_FLAG_OPEN &&
                total >= neighbourNode.total
            ) {
                continue;
            }

            // if the node is already visited and in the closed list, and the new result is worse, skip
            if (
                neighbourNode.flags & NODE_FLAG_CLOSED &&
                total >= neighbourNode.total
            ) {
                continue;
            }

            // add or update the node
            neighbourNode.parent = `${currentNode.nodeRef}:${currentNode.state}`;
            neighbourNode.nodeRef = neighbourNodeRef;
            neighbourNode.flags = neighbourNode.flags & ~NODE_FLAG_CLOSED;
            neighbourNode.cost = cost;
            neighbourNode.total = total;

            if (neighbourNode.flags & NODE_FLAG_OPEN) {
                // already in open list, update node location
                reindexNodeInQueue(openList, neighbourNode);
            } else {
                // put the node in the open list
                neighbourNode.flags |= NODE_FLAG_OPEN;
                pushNodeToQueue(openList, neighbourNode);
            }

            // update nearest node to target so far
            if (heuristic < lastBestNodeCost) {
                lastBestNode = neighbourNode;
                lastBestNodeCost = heuristic;
            }
        }
    }

    // assemble the path to the node
    const path: NodeRef[] = [];
    let currentNode: SearchNode | null = lastBestNode;

    while (currentNode) {
        path.push(currentNode.nodeRef);

        if (currentNode.parent) {
            currentNode = nodes[currentNode.parent];
        } else {
            currentNode = null;
        }
    }

    path.reverse();

    // if the end node was not reached, return with the partial result status
    if (lastBestNode.nodeRef !== endRef) {
        return {
            status: FindNodePathStatus.PARTIAL_PATH,
            success: true,
            path,
            intermediates: {
                nodes,
                openList,
            },
        };
    }

    // the path is complete, return with the complete path status
    return {
        status: FindNodePathStatus.COMPLETE_PATH,
        success: true,
        path,
        intermediates: {
            nodes,
            openList,
        },
    };
};

export const FIND_STRAIGHT_PATH_AREA_CROSSINGS = 1;
export const FIND_STRAIGHT_PATH_ALL_CROSSINGS = 2;

export type StraightPathPoint = {
    position: Vec3;
    type: NodeType;
    nodeRef: NodeRef | null;
};

const appendVertex = (
    pt: Vec3,
    ref: NodeRef | null,
    outPoints: StraightPathPoint[],
    nodeType: NodeType,
): void => {
    // dedupe last
    if (
        outPoints.length > 0 &&
        vec3.equals(outPoints[outPoints.length - 1].position, pt)
    ) {
        return;
    }
    outPoints.push({
        position: [pt[0], pt[1], pt[2]],
        type: nodeType,
        nodeRef: ref,
    });
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
): void => {
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

        if (
            !getPortalPoints(
                navMesh,
                from,
                to,
                _appendPortalsLeft,
                _appendPortalsRight,
            )
        )
            break;

        intersectSegSeg2D(
            _intersectSegSeg2DResult,
            startPos,
            endPos,
            _appendPortalsLeft,
            _appendPortalsRight,
        );

        if (_intersectSegSeg2DResult.hit) {
            vec3.lerp(
                _appendPortalsPoint,
                _appendPortalsLeft,
                _appendPortalsRight,
                _intersectSegSeg2DResult.t,
            );
            const toType = getNodeRefType(to);
            appendVertex(_appendPortalsPoint, to, outPoints, toType);
        }
    }
};

export type FindStraightPathResult = {
    success: boolean;
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
 * @param straightPathOptions
 * @returns The straight path
 */
export const findStraightPath = (
    navMesh: NavMesh,
    start: Vec3,
    end: Vec3,
    pathNodeRefs: NodeRef[],
    straightPathOptions = 0,
): FindStraightPathResult => {
    const path: StraightPathPoint[] = [];
    if (!vec3.finite(start) || !vec3.finite(end) || pathNodeRefs.length === 0) {
        return { success: false, path };
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
        return { success: false, path };

    const closestEndPos = vec3.create();
    if (
        !getClosestPointOnPolyBoundary(
            navMesh,
            pathNodeRefs[pathNodeRefs.length - 1],
            end,
            closestEndPos,
        )
    )
        return { success: false, path };

    // add start point
    appendVertex(
        closestStartPos,
        pathNodeRefs[0],
        path,
        getNodeRefType(pathNodeRefs[0]),
    );

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

        let leftPolyRef: NodeRef | null = pathNodeRefs[0];
        let rightPolyRef: NodeRef | null = pathNodeRefs[0];
        let leftPolyType: NodeType = NodeType.GROUND_POLY;
        let rightPolyType: NodeType = NodeType.GROUND_POLY;

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
                        return { success: false, path };

                    // append portals along the current straight path segment.
                    if (
                        straightPathOptions &
                        (FIND_STRAIGHT_PATH_AREA_CROSSINGS |
                            FIND_STRAIGHT_PATH_ALL_CROSSINGS)
                    ) {
                        appendPortals(
                            navMesh,
                            apexIndex,
                            i,
                            endClamp,
                            pathNodeRefs,
                            path,
                            straightPathOptions,
                        );
                    }

                    appendVertex(
                        endClamp,
                        pathNodeRefs[i],
                        path,
                        getNodeRefType(pathNodeRefs[i]),
                    );

                    return { success: true, path };
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
                    rightPolyRef =
                        i + 1 < pathSize ? pathNodeRefs[i + 1] : null;
                    rightPolyType = toType;
                    rightIndex = i;
                } else {
                    // append portals along current straight segment
                    if (
                        straightPathOptions &
                        (FIND_STRAIGHT_PATH_AREA_CROSSINGS |
                            FIND_STRAIGHT_PATH_ALL_CROSSINGS)
                    ) {
                        appendPortals(
                            navMesh,
                            apexIndex,
                            leftIndex,
                            portalLeft,
                            pathNodeRefs,
                            path,
                            straightPathOptions,
                        );
                    }

                    vec3.copy(portalApex, portalLeft);
                    apexIndex = leftIndex;

                    // add/update vertex
                    appendVertex(
                        portalApex,
                        leftPolyRef,
                        path,
                        leftPolyRef ? leftPolyType : NodeType.GROUND_POLY,
                    );

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
                    leftPolyRef = i + 1 < pathSize ? pathNodeRefs[i + 1] : null;
                    leftPolyType = toType;
                    leftIndex = i;
                } else {
                    // append portals along current straight segment
                    if (
                        straightPathOptions &
                        (FIND_STRAIGHT_PATH_AREA_CROSSINGS |
                            FIND_STRAIGHT_PATH_ALL_CROSSINGS)
                    ) {
                        appendPortals(
                            navMesh,
                            apexIndex,
                            rightIndex,
                            portalRight,
                            pathNodeRefs,
                            path,
                            straightPathOptions,
                        );
                    }

                    vec3.copy(portalApex, portalRight);
                    apexIndex = rightIndex;

                    // add/update vertex
                    appendVertex(
                        portalApex,
                        rightPolyRef,
                        path,
                        rightPolyRef ? rightPolyType : NodeType.GROUND_POLY,
                    );

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
            appendPortals(
                navMesh,
                apexIndex,
                pathSize - 1,
                closestEndPos,
                pathNodeRefs,
                path,
                straightPathOptions,
            );
        }
    }

    // append end point
    // attach the last poly ref if available for the end point for easier identification
    const endRef =
        pathNodeRefs.length > 0 ? pathNodeRefs[pathNodeRefs.length - 1] : null;
    appendVertex(closestEndPos, endRef, path, NodeType.GROUND_POLY);

    return { success: true, path };
};

export type FindPathResult = {
    /** whether the search completed successfully, with either a partial or complete path */
    success: boolean;

    /** the path, consisting of polygon node and offmesh link node references */
    path: StraightPathPoint[];

    /** the start poly node ref */
    startNodeRef: NodeRef | null;

    /** the start closest point */
    startPoint: Vec3;

    /** the end poly node ref */
    endNodeRef: NodeRef | null;

    /** the end closest point */
    endPoint: Vec3;

    /** the node path result */
    nodePath: FindNodePathResult | null;
};

const _findPathStartNearestPolyResult = createFindNearestPolyResult();
const _findPathEndNearestPolyResult = createFindNearestPolyResult();

/**
 * Find a path between two positions on a NavMesh.
 *
 * If the end node cannot be reached through the navigation graph,
 * the last node in the path will be the nearest the end node.
 *
 * Internally:
 * - finds the closest poly for the start and end positions with @see findNearestPoly
 * - finds a nav mesh node path with @see findNodePath
 * - finds a straight path with @see findStraightPath
 *
 * If you want more fine tuned behaviour you can call these methods directly.
 * For example, for agent movement you might want to find a node path once but regularly re-call @see findStraightPath
 *
 * @param navMesh The navigation mesh.
 * @param start The starting position in world space.
 * @param end The ending position in world space.
 * @param queryFilter The query filter.
 * @returns The result of the pathfinding operation.
 */
export const findPath = (
    navMesh: NavMesh,
    start: Vec3,
    end: Vec3,
    halfExtents: Vec3,
    queryFilter: QueryFilter,
): FindPathResult => {
    const result: FindPathResult = {
        success: false,
        path: [],
        startNodeRef: null,
        startPoint: [0, 0, 0],
        endNodeRef: null,
        endPoint: [0, 0, 0],
        nodePath: null,
    };

    /* find start nearest poly */
    const startNearestPolyResult = findNearestPoly(
        _findPathStartNearestPolyResult,
        navMesh,
        start,
        halfExtents,
        queryFilter,
    );
    if (!startNearestPolyResult.success) return result;

    vec3.copy(result.startPoint, startNearestPolyResult.nearestPoint);
    result.startNodeRef = startNearestPolyResult.nearestPolyRef;

    /* find end nearest poly */
    const endNearestPolyResult = findNearestPoly(
        _findPathEndNearestPolyResult,
        navMesh,
        end,
        halfExtents,
        queryFilter,
    );
    if (!endNearestPolyResult.success) return result;

    vec3.copy(result.endPoint, endNearestPolyResult.nearestPoint);
    result.endNodeRef = endNearestPolyResult.nearestPolyRef;

    /* find node path */
    const nodePath = findNodePath(
        navMesh,
        result.startNodeRef,
        result.endNodeRef,
        result.startPoint,
        result.endPoint,
        queryFilter,
    );

    result.nodePath = nodePath;

    if (!nodePath) return result;

    /* find straight path */
    const straightPath = findStraightPath(
        navMesh,
        result.startPoint,
        result.endPoint,
        nodePath.path,
    );

    if (!straightPath) return result;

    /* success */
    result.success = true;
    result.path = straightPath.path;

    return result;
};

export type MoveAlongSurfaceResult = {
    success: boolean;
    resultPosition: Vec3;
    resultRef: NodeRef;
    visited: NodeRef[];
};

/**
 * Moves from start position towards end position along the navigation mesh surface.
 *
 * This method is optimized for small delta movement and a small number of
 * polygons. If used for too great a distance, the result set will form an
 * incomplete path.
 *
 * The resultPosition will equal the endPosition if the end is reached.
 * Otherwise the closest reachable position will be returned.
 *
 * The resultPosition is not projected onto the surface of the navigation
 * mesh. Use getPolyHeight if this is needed.
 *
 * This method treats the end position in the same manner as
 * the raycast method. (As a 2D point.)
 *
 * @param result The result object to populate
 * @param navMesh The navigation mesh
 * @param startRef The reference ID of the starting polygon
 * @param startPosition The starting position [(x, y, z)]
 * @param endPosition The ending position [(x, y, z)]
 * @param filter The query filter.
 * @returns Result containing status, final position, and visited polygons
 */
export const moveAlongSurface = (
    navMesh: NavMesh,
    startRef: NodeRef,
    startPosition: Vec3,
    endPosition: Vec3,
    filter: QueryFilter,
): MoveAlongSurfaceResult => {
    const result: MoveAlongSurfaceResult = {
        success: false,
        resultPosition: vec3.clone(startPosition),
        resultRef: startRef,
        visited: [],
    };

    if (
        !isValidNodeRef(navMesh, startRef) ||
        !vec3.finite(startPosition) ||
        !vec3.finite(endPosition) ||
        !filter
    ) {
        return result;
    }

    result.success = true;

    const nodes: SearchNodePool = {};
    const visited: NodeRef[] = [];

    const startNode: SearchNode = {
        cost: 0,
        total: 0,
        parent: null,
        nodeRef: startRef,
        state: 0,
        flags: NODE_FLAG_CLOSED,
        position: structuredClone(startPosition),
    };
    nodes[`${startRef}:0`] = startNode;

    const bestPos = vec3.clone(startPosition);
    let bestDist = Number.MAX_VALUE;
    let bestNode: SearchNode | null = startNode;

    // search constraints
    const searchPos = vec3.create();
    vec3.lerp(searchPos, startPosition, endPosition, 0.5);
    const searchRadSqr =
        (vec3.distance(startPosition, endPosition) / 2.0 + 0.001) ** 2;

    // breadth-first search queue (no priority needed for this algorithm)
    const queue: SearchNodeQueue = [startNode];

    while (queue.length > 0) {
        // pop front (breadth-first)
        const curNode = queue.shift()!;

        // get poly and tile
        const curRef = curNode.nodeRef;
        const tileAndPoly = getTileAndPolyByRef(curRef, navMesh);

        if (!tileAndPoly.success) continue;

        const { tile, poly } = tileAndPoly;

        // collect vertices
        // TODO: temporary allocate max vertices per polygon and reuse
        const nverts = poly.vertices.length;
        const verts: number[] = [];
        for (let i = 0; i < nverts; ++i) {
            const vertIndex = poly.vertices[i] * 3;
            verts.push(tile.vertices[vertIndex]);
            verts.push(tile.vertices[vertIndex + 1]);
            verts.push(tile.vertices[vertIndex + 2]);
        }

        // if target is inside the poly, stop search
        if (pointInPoly(nverts, verts, endPosition)) {
            bestNode = curNode;
            vec3.copy(bestPos, endPosition);
            break;
        }

        // find wall edges and find nearest point inside the walls
        for (let i = 0, j = nverts - 1; i < nverts; j = i++) {
            // find links to neighbours
            const neis: NodeRef[] = [];

            // expand search with neighbours
            const linkIndices = navMesh.nodes[curRef] || [];

            for (const linkIndex of linkIndices) {
                const link = navMesh.links[linkIndex];
                if (!link) continue;

                const neighbourRef = link.neighbourRef;
                if (!neighbourRef) continue;

                // check if this link corresponds to edge j
                if (link.edge === j) {
                    // check filter
                    if (
                        filter.passFilter &&
                        !filter.passFilter(neighbourRef, navMesh, filter)
                    ) {
                        continue;
                    }

                    neis.push(neighbourRef);
                }
            }

            if (neis.length === 0) {
                // wall edge, calc distance
                const vj = [
                    verts[j * 3],
                    verts[j * 3 + 1],
                    verts[j * 3 + 2],
                ] as Vec3;
                const vi = [
                    verts[i * 3],
                    verts[i * 3 + 1],
                    verts[i * 3 + 2],
                ] as Vec3;
                const distSqr = distancePtSeg2dSqr(endPosition, vj, vi);
                if (distSqr < bestDist) {
                    // update nearest distance
                    closestPtSeg2d(bestPos, endPosition, vj, vi);
                    bestDist = distSqr;
                    bestNode = curNode;
                }
            } else {
                for (const neighbourRef of neis) {
                    // handle tile boundary crossings like findNodePath
                    let crossSide = 0;
                    const linkIndex = linkIndices.find(
                        (idx) =>
                            navMesh.links[idx]?.neighbourRef === neighbourRef,
                    );
                    if (linkIndex !== undefined) {
                        const link = navMesh.links[linkIndex];
                        if (link.side !== 0xff) {
                            crossSide = link.side >> 1;
                        }
                    }

                    const neighbourSearchNodeRef: SearchNodeRef = `${neighbourRef}:${crossSide}`;
                    let neighbourNode = nodes[neighbourSearchNodeRef];

                    if (!neighbourNode) {
                        neighbourNode = {
                            cost: 0,
                            total: 0,
                            parent: null,
                            nodeRef: neighbourRef,
                            state: crossSide,
                            flags: 0,
                            position: structuredClone(endPosition),
                        };
                        nodes[neighbourSearchNodeRef] = neighbourNode;
                    }

                    // skip if already visited
                    if (neighbourNode.flags & NODE_FLAG_CLOSED) continue;

                    // skip the link if it is too far from search constraint
                    const vj = [
                        verts[j * 3],
                        verts[j * 3 + 1],
                        verts[j * 3 + 2],
                    ] as Vec3;
                    const vi = [
                        verts[i * 3],
                        verts[i * 3 + 1],
                        verts[i * 3 + 2],
                    ] as Vec3;
                    const distSqr = distancePtSeg2dSqr(searchPos, vj, vi);
                    if (distSqr > searchRadSqr) continue;

                    // calculate node position if first visit
                    if (neighbourNode.flags === 0) {
                        getEdgeMidPoint(
                            navMesh,
                            curRef,
                            neighbourRef,
                            neighbourNode.position,
                        );
                    }

                    // mark as visited and add to queue
                    neighbourNode.parent = `${curNode.nodeRef}:${curNode.state}`;
                    neighbourNode.flags = NODE_FLAG_CLOSED;
                    queue.push(neighbourNode);
                }
            }
        }
    }

    if (bestNode) {
        let currentNode: SearchNode | null = bestNode;
        while (currentNode) {
            visited.push(currentNode.nodeRef);

            if (currentNode.parent) {
                currentNode = nodes[currentNode.parent];
            } else {
                currentNode = null;
            }
        }

        visited.reverse();
    }

    vec3.copy(result.resultPosition, bestPos);
    result.visited = visited;
    result.resultRef = result.visited[result.visited.length - 1];

    return result;
};

export type RaycastResult = {
    /** The hit parameter along the segment. A value of Number.MAX_VALUE indicates no wall hit. */
    t: number;
    /** Normal vector of the hit wall. */
    hitNormal: Vec3;
    /** Index of the edge hit. */
    hitEdgeIndex: number;
    /** Visited polygon references. */
    path: NodeRef[];
};

/**
 * Casts a 'walkability' ray along the surface of the navigation mesh from
 * the start position toward the end position.
 *
 * This method is meant to be used for quick, short distance checks.
 * The raycast ignores the y-value of the end position (2D check).
 *
 * @param navMesh The navigation mesh to use for the raycast.
 * @param startRef The NodeRef for the start polygon
 * @param startPosition The starting position in world space.
 * @param endPosition The ending position in world space.
 * @param filter The query filter to apply.
 */
export const raycast = (
    navMesh: NavMesh,
    startRef: NodeRef,
    startPosition: Vec3,
    endPosition: Vec3,
    filter: QueryFilter,
): RaycastResult => {
    const result: RaycastResult = {
        t: 0,
        hitNormal: vec3.create(),
        hitEdgeIndex: -1,
        path: [],
    };

    // validate input
    if (
        !isValidNodeRef(navMesh, startRef) ||
        !vec3.finite(startPosition) ||
        !vec3.finite(endPosition) ||
        !filter
    ) {
        return result;
    }

    let curRef: NodeRef | null = startRef;

    const intersectSegmentPoly2DResult = createIntersectSegmentPoly2DResult();

    while (curRef) {
        // get current tile and poly
        const tileAndPolyResult = getTileAndPolyByRef(curRef, navMesh);
        if (!tileAndPolyResult.success) break;
        const { tile, poly } = tileAndPolyResult;

        // collect current poly vertices
        const polyVerts: number[] = [];
        for (let i = 0; i < poly.vertices.length; i++) {
            const vertIndex = poly.vertices[i] * 3;
            polyVerts.push(tile.vertices[vertIndex]);
            polyVerts.push(tile.vertices[vertIndex + 1]);
            polyVerts.push(tile.vertices[vertIndex + 2]);
        }

        // cast ray against current polygon
        intersectSegmentPoly2D(
            intersectSegmentPoly2DResult,
            startPosition,
            endPosition,
            polyVerts,
        );
        if (!intersectSegmentPoly2DResult.intersects) {
            // could not hit the polygon, keep the old t and report hit
            return result;
        }

        result.hitEdgeIndex = intersectSegmentPoly2DResult.segMax;

        // keep track of furthest t so far
        if (intersectSegmentPoly2DResult.tmax > result.t) {
            result.t = intersectSegmentPoly2DResult.tmax;
        }

        // add polygon to visited
        result.path.push(curRef);

        // ray end is completely inside the polygon
        if (intersectSegmentPoly2DResult.segMax === -1) {
            result.t = Number.MAX_VALUE;

            return result;
        }

        // follow neighbors
        let nextRef: NodeRef | null = null;

        const polyLinks: number[] = navMesh.nodes[curRef];

        for (const linkIndex of polyLinks) {
            const link = navMesh.links[linkIndex];

            // find link which contains this edge
            if (link.edge !== intersectSegmentPoly2DResult.segMax) continue;

            // skip off-mesh connections
            if (
                getNodeRefType(link.neighbourRef) ===
                NodeType.OFFMESH_CONNECTION
            )
                continue;

            // get pointer to the next polygon
            const nextTileAndPolyResult = getTileAndPolyByRef(
                link.neighbourRef,
                navMesh,
            );
            if (!nextTileAndPolyResult.success) continue;

            // skip links based on filter
            if (
                filter.passFilter &&
                !filter.passFilter(link.neighbourRef, navMesh, filter)
            )
                continue;

            // if the link is internal, just return the ref
            if (link.side === 0xff) {
                nextRef = link.neighbourRef;
                break;
            }

            // if the link is at tile boundary, check if the link spans the whole edge
            if (link.bmin === 0 && link.bmax === 255) {
                nextRef = link.neighbourRef;
                break;
            }

            // check for partial edge links
            const v0 = poly.vertices[link.edge];
            const v1 = poly.vertices[(link.edge + 1) % poly.vertices.length];
            const left = [
                tile.vertices[v0 * 3],
                tile.vertices[v0 * 3 + 1],
                tile.vertices[v0 * 3 + 2],
            ] as Vec3;
            const right = [
                tile.vertices[v1 * 3],
                tile.vertices[v1 * 3 + 1],
                tile.vertices[v1 * 3 + 2],
            ] as Vec3;

            // check that the intersection lies inside the link portal
            if (link.side === 0 || link.side === 4) {
                // calculate link size
                const s = 1.0 / 255.0;
                let lmin = left[2] + (right[2] - left[2]) * (link.bmin * s);
                let lmax = left[2] + (right[2] - left[2]) * (link.bmax * s);
                if (lmin > lmax) [lmin, lmax] = [lmax, lmin];

                // find Z intersection
                const z =
                    startPosition[2] +
                    (endPosition[2] - startPosition[2]) *
                        intersectSegmentPoly2DResult.tmax;
                if (z >= lmin && z <= lmax) {
                    nextRef = link.neighbourRef;
                    break;
                }
            } else if (link.side === 2 || link.side === 6) {
                // calculate link size
                const s = 1.0 / 255.0;
                let lmin = left[0] + (right[0] - left[0]) * (link.bmin * s);
                let lmax = left[0] + (right[0] - left[0]) * (link.bmax * s);
                if (lmin > lmax) [lmin, lmax] = [lmax, lmin];

                // find X intersection
                const x =
                    startPosition[0] +
                    (endPosition[0] - startPosition[0]) *
                        intersectSegmentPoly2DResult.tmax;
                if (x >= lmin && x <= lmax) {
                    nextRef = link.neighbourRef;
                    break;
                }
            }
        }

        if (!nextRef) {
            // no neighbor, we hit a wall

            // calculate hit normal
            if (intersectSegmentPoly2DResult.segMax >= 0) {
                const a = intersectSegmentPoly2DResult.segMax;
                const b =
                    intersectSegmentPoly2DResult.segMax + 1 <
                    poly.vertices.length
                        ? intersectSegmentPoly2DResult.segMax + 1
                        : 0;
                const va = vec3.fromBuffer(vec3.create(), polyVerts, a * 3);
                const vb = vec3.fromBuffer(vec3.create(), polyVerts, b * 3);
                const dx = vb[0] - va[0];
                const dz = vb[2] - va[2];
                result.hitNormal[0] = dz;
                result.hitNormal[1] = 0;
                result.hitNormal[2] = -dx;
                vec3.normalize(result.hitNormal, result.hitNormal);
            }

            return result;
        }

        // no hit, advance to neighbor polygon
        curRef = nextRef;
    }

    return result;
};

export type FindRandomPointResult = {
    success: boolean;
    ref: NodeRef;
    position: Vec3;
};

/**
 * Finds a random point on the navigation mesh.
 *
 * @param navMesh - The navigation mesh
 * @param filter - Query filter to apply to polygons
 * @param rand - Function that returns random values [0,1]
 * @returns The result object with success flag, random point, and polygon reference
 */
export const findRandomPoint = (
    navMesh: NavMesh,
    filter: QueryFilter,
    rand: () => number,
): FindRandomPointResult => {
    const result: FindRandomPointResult = {
        success: false,
        ref: '' as NodeRef,
        position: [0, 0, 0],
    };

    // randomly pick one tile using reservoir sampling
    let selectedTile: NavMeshTile | null = null;
    let tileSum = 0;

    const tiles = Object.values(navMesh.tiles);
    for (const tile of tiles) {
        if (!tile || !tile.polys) continue;

        // choose random tile using reservoir sampling
        const area = 1.0; // could be tile area, but we use uniform weighting
        tileSum += area;
        const u = rand();
        if (u * tileSum <= area) {
            selectedTile = tile;
        }
    }

    if (!selectedTile) {
        return result;
    }

    // randomly pick one polygon weighted by polygon area
    let selectedPoly: NavMeshPoly | null = null;
    let selectedPolyRef: NodeRef | null = null;
    let areaSum = 0;

    for (let i = 0; i < selectedTile.polys.length; i++) {
        const poly = selectedTile.polys[i];

        // construct the polygon reference
        const polyRef = serPolyNodeRef(selectedTile.id, i);

        // must pass filter
        if (filter.passFilter && !filter.passFilter(polyRef, navMesh, filter)) {
            continue;
        }

        // calculate area of the polygon using triangulation
        let polyArea = 0;
        const va = vec3.create();
        const vb = vec3.create();
        const vc = vec3.create();
        for (let j = 2; j < poly.vertices.length; j++) {
            vec3.fromBuffer(va, selectedTile.vertices, poly.vertices[0] * 3);
            vec3.fromBuffer(
                vb,
                selectedTile.vertices,
                poly.vertices[j - 1] * 3,
            );
            vec3.fromBuffer(vc, selectedTile.vertices, poly.vertices[j] * 3);
            polyArea += triArea2D(va, vb, vc);
        }

        // choose random polygon weighted by area, using reservoir sampling
        areaSum += polyArea;
        const u = rand();
        if (u * areaSum <= polyArea) {
            selectedPoly = poly;
            selectedPolyRef = polyRef;
        }
    }

    if (!selectedPoly || !selectedPolyRef) {
        return result;
    }

    // randomly pick point on polygon
    const verts: number[] = [];
    for (let j = 0; j < selectedPoly.vertices.length; j++) {
        const vertexIndex = selectedPoly.vertices[j] * 3;
        verts.push(selectedTile.vertices[vertexIndex]);
        verts.push(selectedTile.vertices[vertexIndex + 1]);
        verts.push(selectedTile.vertices[vertexIndex + 2]);
    }

    const s = rand();
    const t = rand();
    const areas = new Array(selectedPoly.vertices.length);
    const pt: Vec3 = [0, 0, 0];

    randomPointInConvexPoly(pt, verts, areas, s, t);

    // project point onto polygon surface to ensure it's exactly on the mesh
    const closestPointResult = createGetClosestPointOnPolyResult();
    getClosestPointOnPoly(closestPointResult, navMesh, selectedPolyRef, pt);

    if (closestPointResult.success) {
        vec3.copy(result.position, closestPointResult.closestPoint);
    } else {
        vec3.copy(result.position, pt);
    }

    result.ref = selectedPolyRef;
    result.success = true;

    return result;
};

export type FindRandomPointAroundCircleResult = {
    success: boolean;
    randomRef: NodeRef;
    position: Vec3;
};

/**
 * Finds a random point within a circle around a center position on the navigation mesh.
 * This is a port of dtNavMeshQuery::findRandomPointAroundCircle from Detour.
 *
 * Uses Dijkstra-like search to explore reachable polygons within the circle,
 * then selects a random polygon weighted by area, and finally generates
 * a random point within that polygon.
 *
 * @param result - Result object to store the random point and polygon reference
 * @param navMesh - The navigation mesh
 * @param startRef - Reference to the polygon to start the search from
 * @param centerPosition - Center position of the search circle
 * @param maxRadius - Maximum radius of the search circle
 * @param filter - Query filter to apply to polygons
 * @param rand - Function that returns random values [0,1]
 * @returns The result object with success flag, random point, and polygon reference
 */
export const findRandomPointAroundCircle = (
    navMesh: NavMesh,
    startRef: NodeRef,
    centerPosition: Vec3,
    maxRadius: number,
    filter: QueryFilter,
    rand: () => number,
): FindRandomPointAroundCircleResult => {
    const result: FindRandomPointAroundCircleResult = {
        success: false,
        randomRef: '' as NodeRef,
        position: [0, 0, 0],
    };

    // validate input
    if (
        !isValidNodeRef(navMesh, startRef) ||
        !vec3.finite(centerPosition) ||
        maxRadius < 0 ||
        !Number.isFinite(maxRadius)
    ) {
        return result;
    }

    const startTileAndPoly = getTileAndPolyByRef(startRef, navMesh);
    if (!startTileAndPoly.success) {
        return result;
    }

    // check if start polygon passes filter
    if (filter.passFilter && !filter.passFilter(startRef, navMesh, filter)) {
        return result;
    }

    // prepare search
    const nodes: SearchNodePool = {};
    const openList: SearchNodeQueue = [];

    const startNode: SearchNode = {
        cost: 0,
        total: 0,
        parent: null,
        nodeRef: startRef,
        state: 0,
        flags: NODE_FLAG_OPEN,
        position: structuredClone(centerPosition),
    };
    nodes[`${startRef}:0`] = startNode;
    pushNodeToQueue(openList, startNode);

    const radiusSqr = maxRadius * maxRadius;
    let areaSum = 0;

    let randomTile: NavMeshTile | null = null;
    let randomPoly: NavMeshPoly | null = null;
    let randomPolyRef: NodeRef | null = null;

    const va = vec3.create();
    const vb = vec3.create();

    while (openList.length > 0) {
        // remove node from the open list and put it in the closed list
        const bestNode = popNodeFromQueue(openList)!;
        bestNode.flags &= ~NODE_FLAG_OPEN;
        bestNode.flags |= NODE_FLAG_CLOSED;

        // get poly and tile
        const bestRef = bestNode.nodeRef;
        const bestTileAndPoly = getTileAndPolyByRef(bestRef, navMesh);
        if (!bestTileAndPoly.success) continue;

        const { tile: bestTile, poly: bestPoly } = bestTileAndPoly;

        // place random locations on ground polygons

        // calculate area of the polygon
        let polyArea = 0;
        const v0 = vec3.create();
        const v1 = vec3.create();
        const v2 = vec3.create();
        for (let j = 2; j < bestPoly.vertices.length; j++) {
            vec3.fromBuffer(v0, bestTile.vertices, bestPoly.vertices[0] * 3);
            vec3.fromBuffer(
                v1,
                bestTile.vertices,
                bestPoly.vertices[j - 1] * 3,
            );
            vec3.fromBuffer(v2, bestTile.vertices, bestPoly.vertices[j] * 3);
            polyArea += triArea2D(v0, v1, v2);
        }

        // choose random polygon weighted by area, using reservoir sampling
        areaSum += polyArea;
        const u = rand();
        if (u * areaSum <= polyArea) {
            randomTile = bestTile;
            randomPoly = bestPoly;
            randomPolyRef = bestRef;
        }

        // get parent reference for preventing backtracking
        let parentRef: NodeRef | null = null;
        if (bestNode.parent) {
            const [nodeRef, _state] = bestNode.parent.split(':');
            parentRef = nodeRef as NodeRef;
        }

        // iterate through all links from the current polygon
        const polyLinks: number[] = navMesh.nodes[bestRef] ?? [];
        for (const linkIndex of polyLinks) {
            const link = navMesh.links[linkIndex];
            if (!link) continue;

            const neighbourRef = link.neighbourRef;

            // skip invalid neighbours and do not follow back to parent
            if (!neighbourRef || neighbourRef === parentRef) {
                continue;
            }

            // expand to neighbour
            const neighbourTileAndPoly = getTileAndPolyByRef(
                neighbourRef,
                navMesh,
            );
            if (!neighbourTileAndPoly.success) continue;

            // do not advance if the polygon is excluded by the filter
            if (
                filter.passFilter &&
                !filter.passFilter(neighbourRef, navMesh, filter)
            ) {
                continue;
            }

            // find edge and calc distance to the edge
            if (!getPortalPoints(navMesh, bestRef, neighbourRef, va, vb)) {
                continue;
            }

            // if the circle is not touching the next polygon, skip it
            const distSqr = distancePtSeg2dSqr(centerPosition, va, vb);
            if (distSqr > radiusSqr) {
                continue;
            }

            // get or create neighbour node
            const neighbourNodeKey: SearchNodeRef = `${neighbourRef}:0`;
            let neighbourNode = nodes[neighbourNodeKey];

            if (!neighbourNode) {
                neighbourNode = {
                    cost: 0,
                    total: 0,
                    parent: null,
                    nodeRef: neighbourRef,
                    state: 0,
                    flags: 0,
                    position: [0, 0, 0],
                };
                nodes[neighbourNodeKey] = neighbourNode;
            }

            if (neighbourNode.flags & NODE_FLAG_CLOSED) {
                continue;
            }

            // set position if this is the first time we visit this node
            if (neighbourNode.flags === 0) {
                vec3.lerp(neighbourNode.position, va, vb, 0.5);
            }

            const total =
                bestNode.total +
                vec3.distance(bestNode.position, neighbourNode.position);

            // the node is already in open list and the new result is worse, skip
            if (
                neighbourNode.flags & NODE_FLAG_OPEN &&
                total >= neighbourNode.total
            ) {
                continue;
            }

            neighbourNode.parent = `${bestRef}:0` as SearchNodeRef;
            neighbourNode.flags = neighbourNode.flags & ~NODE_FLAG_CLOSED;
            neighbourNode.total = total;

            if (neighbourNode.flags & NODE_FLAG_OPEN) {
                reindexNodeInQueue(openList, neighbourNode);
            } else {
                neighbourNode.flags = NODE_FLAG_OPEN;
                pushNodeToQueue(openList, neighbourNode);
            }
        }
    }

    if (!randomPoly || !randomTile || !randomPolyRef) {
        return result;
    }

    // randomly pick point on polygon
    const verts: number[] = [];
    for (let j = 0; j < randomPoly.vertices.length; j++) {
        const vertexIndex = randomPoly.vertices[j] * 3;
        verts.push(randomTile.vertices[vertexIndex]);
        verts.push(randomTile.vertices[vertexIndex + 1]);
        verts.push(randomTile.vertices[vertexIndex + 2]);
    }

    const s = rand();
    const t = rand();
    const areas = new Array(randomPoly.vertices.length);
    const pt: Vec3 = [0, 0, 0];

    randomPointInConvexPoly(pt, verts, areas, s, t);

    // project point onto polygon surface to ensure it's exactly on the mesh
    const closestPointResult = createGetClosestPointOnPolyResult();
    getClosestPointOnPoly(closestPointResult, navMesh, randomPolyRef, pt);

    if (closestPointResult.success) {
        vec3.copy(result.position, closestPointResult.closestPoint);
    } else {
        vec3.copy(result.position, pt);
    }

    result.randomRef = randomPolyRef;
    result.success = true;

    return result;
};
