import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import {
    createDistancePtSegSqr2dResult,
    createIntersectSegmentPoly2DResult,
    distancePtSegSqr2d,
    intersectSegmentPoly2D,
    pointInPoly,
    randomPointInConvexPoly,
    triArea2D,
} from '../geometry';
import type { NavMesh, NavMeshLink, NavMeshPoly, NavMeshTile, OffMeshConnectionParams } from './nav-mesh';
import type { QueryFilter } from './nav-mesh-api';
import {
    createGetClosestPointOnPolyResult,
    createGetPolyHeightResult,
    DEFAULT_QUERY_FILTER,
    addOffMeshConnection,
    getClosestPointOnPoly,
    getNodeByRef,
    getNodeByTileAndPoly,
    getPolyHeight,
    getTileAndPolyByRef,
    isValidNodeRef,
} from './nav-mesh-api';
import { getNodeRefType, type NodeRef, NodeType } from './node';

export const NODE_FLAG_OPEN = 0x01;
export const NODE_FLAG_CLOSED = 0x02;

/** parent of the node is not adjacent. Found using raycast. */
export const NODE_FLAG_PARENT_DETACHED = 0x04;

export type SearchNode = {
    /** the position of the node */
    position: Vec3;
    /** the cost from the previous node to this node */
    cost: number;
    /** the cost up to this node */
    total: number;
    /** the parent node ref */
    parentNodeRef: NodeRef | null;
    /** the parent node state */
    parentState: number | null;
    /** node state */
    state: number;
    /** node flags */
    flags: number;
    /** the node ref for this search node */
    nodeRef: NodeRef;
};

export type SearchNodePool = { [nodeRef: NodeRef]: SearchNode[] };

export type SearchNodeQueue = SearchNode[];

export const getSearchNode = (pool: SearchNodePool, nodeRef: NodeRef, state: number): SearchNode | undefined => {
    const nodes = pool[nodeRef];
    if (!nodes) return undefined;

    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].state === state) {
            return nodes[i];
        }
    }

    return undefined;
};

export const addSearchNode = (pool: SearchNodePool, node: SearchNode): void => {
    if (!pool[node.nodeRef]) {
        pool[node.nodeRef] = [];
    }
    pool[node.nodeRef].push(node);
};

export const bubbleUpQueue = (queue: SearchNodeQueue, i: number, node: SearchNode) => {
    // note: (index > 0) means there is a parent
    let parent = Math.floor((i - 1) / 2);

    while (i > 0 && queue[parent].total > node.total) {
        queue[i] = queue[parent];
        i = parent;
        parent = Math.floor((i - 1) / 2);
    }

    queue[i] = node;
};

export const trickleDownQueue = (queue: SearchNodeQueue, i: number, node: SearchNode) => {
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

export const pushNodeToQueue = (queue: SearchNodeQueue, node: SearchNode): void => {
    queue.push(node);
    bubbleUpQueue(queue, queue.length - 1, node);
};

export const popNodeFromQueue = (queue: SearchNodeQueue): SearchNode | undefined => {
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

export const reindexNodeInQueue = (queue: SearchNodeQueue, node: SearchNode): void => {
    for (let i = 0; i < queue.length; i++) {
        if (queue[i].nodeRef === node.nodeRef && queue[i].state === node.state) {
            queue[i] = node;
            bubbleUpQueue(queue, i, node);
            return;
        }
    }
};

const _getPortalPoints_start = vec3.create();
const _getPortalPoints_end = vec3.create();

/**
 * Retrieves the left and right points of the portal edge between two adjacent polygons.
 * Or if one of the polygons is an off-mesh connection, returns the connection endpoint for both left and right.
 */
export const getPortalPoints = (
    navMesh: NavMesh,
    fromNodeRef: NodeRef,
    toNodeRef: NodeRef,
    outLeft: Vec3,
    outRight: Vec3,
): boolean => {
    // find the link that points to the 'to' polygon.
    let toLink: NavMeshLink | undefined;

    const fromNode = getNodeByRef(navMesh, fromNodeRef);

    for (const linkIndex of fromNode.links) {
        const link = navMesh.links[linkIndex];

        if (link.toNodeRef === toNodeRef) {
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

    // handle from poly to poly
    if (fromNodeType === NodeType.POLY && toNodeType === NodeType.POLY) {
        // get the 'from' and 'to' tiles
        const { tileId: fromTileId, polyIndex: fromPolyIndex } = getNodeByRef(navMesh, fromNodeRef);
        const fromTile = navMesh.tiles[fromTileId];
        const fromPoly = fromTile.polys[fromPolyIndex];

        // find portal vertices
        const v0Index = fromPoly.vertices[toLink.edge];
        const v1Index = fromPoly.vertices[(toLink.edge + 1) % fromPoly.vertices.length];
        const v0Offset = v0Index * 3;
        const v1Offset = v1Index * 3;

        // if the link is at tile boundary, clamp the vertices to the link width.
        if (toLink.side !== 0xff && (toLink.bmin !== 0 || toLink.bmax !== 255)) {
            // unpack portal limits and lerp
            const s = 1.0 / 255.0;
            const tmin = toLink.bmin * s;
            const tmax = toLink.bmax * s;

            vec3.fromBuffer(_getPortalPoints_start, fromTile.vertices, v0Offset);
            vec3.fromBuffer(_getPortalPoints_end, fromTile.vertices, v1Offset);
            vec3.lerp(outLeft, _getPortalPoints_start, _getPortalPoints_end, tmin);
            vec3.lerp(outRight, _getPortalPoints_start, _getPortalPoints_end, tmax);
        } else {
            // no clamping needed - direct copy
            vec3.fromBuffer(outLeft, fromTile.vertices, v0Offset);
            vec3.fromBuffer(outRight, fromTile.vertices, v1Offset);
        }

        return true;
    }

    // handle from poly to offmesh connection
    if (fromNodeType === NodeType.POLY && toNodeType === NodeType.OFFMESH) {
        const toNode = getNodeByRef(navMesh, toNodeRef);
        const offMeshConnection = navMesh.offMeshConnections[toNode.offMeshConnectionId];
        if (!offMeshConnection) return false;

        const position = toLink && toLink.edge === 0 ? offMeshConnection.start : offMeshConnection.end;

        vec3.copy(outLeft, position);
        vec3.copy(outRight, position);

        return true;
    }

    // handle from offmesh connection to poly
    if (fromNodeType === NodeType.OFFMESH && toNodeType === NodeType.POLY) {
        const offMeshConnection = navMesh.offMeshConnections[fromNode.offMeshConnectionId];
        if (!offMeshConnection) return false;

        const position = toLink && toLink.edge === 0 ? offMeshConnection.start : offMeshConnection.end;

        vec3.copy(outLeft, position);
        vec3.copy(outRight, position);

        return true;
    }

    return false;
};

const _edgeMidPointPortalLeft = vec3.create();
const _edgeMidPointPortalRight = vec3.create();

export const getEdgeMidPoint = (navMesh: NavMesh, fromNodeRef: NodeRef, toNodeRef: NodeRef, outMidPoint: Vec3): boolean => {
    if (!getPortalPoints(navMesh, fromNodeRef, toNodeRef, _edgeMidPointPortalLeft, _edgeMidPointPortalRight)) {
        return false;
    }

    outMidPoint[0] = (_edgeMidPointPortalLeft[0] + _edgeMidPointPortalRight[0]) * 0.5;
    outMidPoint[1] = (_edgeMidPointPortalLeft[1] + _edgeMidPointPortalRight[1]) * 0.5;
    outMidPoint[2] = (_edgeMidPointPortalLeft[2] + _edgeMidPointPortalRight[2]) * 0.5;

    return true;
};

export enum FindNodePathResultFlags {
    NONE = 0,
    SUCCESS = 1 << 0,
    COMPLETE_PATH = 1 << 1,
    PARTIAL_PATH = 1 << 2,
    INVALID_INPUT = 1 << 3,
}

export type FindNodePathResult = {
    /** whether the search completed successfully, with either a partial or complete path */
    success: boolean;

    /** the result status flags for the operation */
    flags: FindNodePathResultFlags;

    /** the path, consisting of polygon node and offmesh link node references */
    path: NodeRef[];

    /** intermediate search node pool used for the search */
    nodes: SearchNodePool;

    /** intermediate open list used for the search */
    openList: SearchNodeQueue;

    /** ephemeral off-mesh connection IDs added during this search (to be cleaned later) */
    ephemeralOffMeshConnectionIds?: number[];
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
 * @param startNodeRef The reference ID of the starting node.
 * @param endNodeRef The reference ID of the ending node.
 * @param startPosition The starting position in world space.
 * @param endPosition The ending position in world space.
 * @param filter The query filter.
 * @returns The result of the pathfinding operation.
 */
export const findNodePath = (
    navMesh: NavMesh,
    startNodeRef: NodeRef,
    endNodeRef: NodeRef,
    startPosition: Vec3,
    endPosition: Vec3,
    filter: QueryFilter,
): FindNodePathResult => {
    const nodes: SearchNodePool = {};
    const openList: SearchNodeQueue = [];
    const ephemeralOffMeshIds: number[] = [];
    const lazyKeySet = new Set<string>();

    // validate input
    if (
        !isValidNodeRef(navMesh, startNodeRef) ||
        !isValidNodeRef(navMesh, endNodeRef) ||
        !vec3.finite(startPosition) ||
        !vec3.finite(endPosition)
    ) {
        return {
            flags: FindNodePathResultFlags.NONE | FindNodePathResultFlags.INVALID_INPUT,
            success: false,
            path: [],
            nodes,
            openList,
            ephemeralOffMeshConnectionIds: ephemeralOffMeshIds,
        };
    }

    // early exit if start and end are the same
    if (startNodeRef === endNodeRef) {
        return {
            flags: FindNodePathResultFlags.SUCCESS | FindNodePathResultFlags.COMPLETE_PATH,
            success: true,
            path: [startNodeRef],
            nodes,
            openList,
            ephemeralOffMeshConnectionIds: ephemeralOffMeshIds,
        };
    }

    // prepare search
    const getCost = filter.getCost;

    const startNode: SearchNode = {
        cost: 0,
        total: vec3.distance(startPosition, endPosition) * HEURISTIC_SCALE,
        parentNodeRef: null,
        parentState: null,
        nodeRef: startNodeRef,
        state: 0,
        flags: NODE_FLAG_OPEN,
        position: [startPosition[0], startPosition[1], startPosition[2]],
    };

    addSearchNode(nodes, startNode);
    pushNodeToQueue(openList, startNode);

    let lastBestNode: SearchNode = startNode;
    let lastBestNodeCost = startNode.total;

    while (openList.length > 0) {
        // remove node from the open list and put it in the closed list
        const bestSearchNode = popNodeFromQueue(openList)!;
        bestSearchNode.flags &= ~NODE_FLAG_OPEN;
        bestSearchNode.flags |= NODE_FLAG_CLOSED;

        // if we have reached the goal, stop searching
        const bestNodeRef = bestSearchNode.nodeRef;
        if (bestNodeRef === endNodeRef) {
            lastBestNode = bestSearchNode;
            break;
        }

        // get best node
        const bestNode = getNodeByRef(navMesh, bestNodeRef);

        // get parent node ref
        const parentNodeRef = bestSearchNode.parentNodeRef ?? undefined;

        // materialize lazy off-mesh connections near this expansion point
        if (navMesh.lazyOffMeshProviders?.length) {
            const pos = bestSearchNode.position;
            const q = (x: number) => Math.round(x * 1000) / 1000;
            const keyOf = (c: OffMeshConnectionParams) =>
                `${q(c.start[0])},${q(c.start[1])},${q(c.start[2])}|${q(c.end[0])},${q(c.end[1])},${q(c.end[2])}|${c.direction}|${q(
                    c.radius,
                )}|${c.area}|${c.flags}`;

            for (let i = 0; i < navMesh.lazyOffMeshProviders.length; i++) {
                const provider = navMesh.lazyOffMeshProviders[i]!;
                const cons = provider({ navMesh, fromNodeRef: bestNodeRef, pos, start: startPosition, end: endPosition });
                if (!cons || cons.length === 0) continue;
                for (let j = 0; j < cons.length; j++) {
                    const c = cons[j]!;
                    const k = keyOf(c);
                    if (lazyKeySet.has(k)) continue;
                    const id = addOffMeshConnection(navMesh, c);
                    lazyKeySet.add(k);
                    ephemeralOffMeshIds.push(id);
                }
            }
        }

        // expand the search with node links
        for (const linkIndex of bestNode.links) {
            const link = navMesh.links[linkIndex];
            const neighbourNodeRef = link.toNodeRef;

            // do not expand back to where we came from
            if (neighbourNodeRef === parentNodeRef) {
                continue;
            }

            // check whether neighbour passes the filter
            if (filter.passFilter(neighbourNodeRef, navMesh) === false) {
                continue;
            }

            // deal explicitly with crossing tile boundaries by partitioning the search node refs by crossing side
            let state = 0;
            if (link.side !== 0xff) {
                state = link.side >> 1;
            }

            // get the neighbour node
            let neighbourSearchNode = getSearchNode(nodes, neighbourNodeRef, state);
            if (!neighbourSearchNode) {
                neighbourSearchNode = {
                    cost: 0,
                    total: 0,
                    parentNodeRef: null,
                    parentState: null,
                    nodeRef: neighbourNodeRef,
                    state,
                    flags: 0,
                    position: [0, 0, 0],
                };

                addSearchNode(nodes, neighbourSearchNode);

                getEdgeMidPoint(navMesh, bestNodeRef, neighbourNodeRef, neighbourSearchNode.position);
            }

            // calculate cost and heuristic
            let cost = 0;
            let heuristic = 0;

            // normal cost calculation
            const curCost = getCost(
                bestSearchNode.position,
                neighbourSearchNode.position,
                navMesh,
                parentNodeRef,
                bestNodeRef,
                neighbourNodeRef,
            );
            cost = bestSearchNode.cost + curCost;

            // special case for last node - add cost to reach end position
            if (neighbourNodeRef === endNodeRef) {
                const endCost = getCost(neighbourSearchNode.position, endPosition, navMesh, bestNodeRef, neighbourNodeRef, undefined);
                cost = cost + endCost;
                heuristic = 0;
            } else {
                heuristic = vec3.distance(neighbourSearchNode.position, endPosition) * HEURISTIC_SCALE;
            }

            const total = cost + heuristic;

            // if the node is already in the open list, and the new result is worse, skip
            if (neighbourSearchNode.flags & NODE_FLAG_OPEN && total >= neighbourSearchNode.total) {
                continue;
            }

            // if the node is already visited and in the closed list, and the new result is worse, skip
            if (neighbourSearchNode.flags & NODE_FLAG_CLOSED && total >= neighbourSearchNode.total) {
                continue;
            }

            // add or update the node
            neighbourSearchNode.parentNodeRef = bestSearchNode.nodeRef;
            neighbourSearchNode.parentState = bestSearchNode.state;
            neighbourSearchNode.nodeRef = neighbourNodeRef;
            neighbourSearchNode.flags = neighbourSearchNode.flags & ~NODE_FLAG_CLOSED;
            neighbourSearchNode.cost = cost;
            neighbourSearchNode.total = total;

            if (neighbourSearchNode.flags & NODE_FLAG_OPEN) {
                // already in open list, update node location
                reindexNodeInQueue(openList, neighbourSearchNode);
            } else {
                // put the node in the open list
                neighbourSearchNode.flags |= NODE_FLAG_OPEN;
                pushNodeToQueue(openList, neighbourSearchNode);
            }

            // update nearest node to target so far
            if (heuristic < lastBestNodeCost) {
                lastBestNode = neighbourSearchNode;
                lastBestNodeCost = heuristic;
            }
        }
    }

    // assemble the path to the node
    const path: NodeRef[] = [];
    let currentNode: SearchNode | null = lastBestNode;

    while (currentNode) {
        path.push(currentNode.nodeRef);

        if (currentNode.parentNodeRef !== null && currentNode.parentState !== null) {
            currentNode = getSearchNode(nodes, currentNode.parentNodeRef, currentNode.parentState) ?? null;
        } else {
            currentNode = null;
        }
    }

    path.reverse();

    // if the end node was not reached, return with the partial result status
    if (lastBestNode.nodeRef !== endNodeRef) {
        return {
            flags: FindNodePathResultFlags.PARTIAL_PATH,
            success: true,
            path,
            nodes,
            openList,
            ephemeralOffMeshConnectionIds: ephemeralOffMeshIds,
        };
    }

    // the path is complete, return with the complete path status
    return {
        flags: FindNodePathResultFlags.SUCCESS | FindNodePathResultFlags.COMPLETE_PATH,
        success: true,
        path,
        nodes,
        openList,
        ephemeralOffMeshConnectionIds: ephemeralOffMeshIds,
    };
};

export enum SlicedFindNodePathStatusFlags {
    NOT_INITIALIZED = 0,
    IN_PROGRESS = 1,
    SUCCESS = 2,
    PARTIAL_RESULT = 4,
    FAILURE = 8,
    INVALID_PARAM = 16,
}

export enum SlicedFindNodePathInitFlags {
    /** Enable any-angle pathfinding with raycast optimization */
    ANY_ANGLE = 1,
}

export type SlicedNodePathQuery = {
    status: SlicedFindNodePathStatusFlags;

    // search parameters
    startNodeRef: NodeRef;
    endNodeRef: NodeRef;
    startPosition: Vec3;
    endPosition: Vec3;
    filter: QueryFilter;

    // search state
    nodes: SearchNodePool;
    openList: SearchNodeQueue;
    lastBestNode: SearchNode | null;
    lastBestNodeCost: number;

    // raycast optimization state
    raycastLimitSqr: number | null;
};

/**
 * Creates a new sliced path query object with default values.
 * @returns A new sliced path query ready for initialization
 */
export const createSlicedNodePathQuery = (): SlicedNodePathQuery => ({
    status: SlicedFindNodePathStatusFlags.NOT_INITIALIZED,
    startNodeRef: 0,
    endNodeRef: 0,
    startPosition: [0, 0, 0],
    endPosition: [0, 0, 0],
    filter: DEFAULT_QUERY_FILTER,
    nodes: {},
    openList: [],
    lastBestNode: null,
    lastBestNodeCost: Infinity,
    raycastLimitSqr: null,
});

/**
 * Initializes a sliced path query.
 * @param navMesh The navigation mesh
 * @param query The sliced path query to initialize
 * @param startNodeRef The reference ID of the starting node
 * @param endNodeRef The reference ID of the ending node
 * @param startPosition The starting position in world space
 * @param endPosition The ending position in world space
 * @param filter The query filter
 * @param flags Optional flags for the query (@see SlicedFindNodePathInitFlags)
 * @returns The status of the initialization
 */
export const initSlicedFindNodePath = (
    navMesh: NavMesh,
    query: SlicedNodePathQuery,
    startNodeRef: NodeRef,
    endNodeRef: NodeRef,
    startPosition: Vec3,
    endPosition: Vec3,
    filter: QueryFilter,
    flags: number = 0,
): SlicedFindNodePathStatusFlags => {
    // set search parameters
    query.startNodeRef = startNodeRef;
    query.endNodeRef = endNodeRef;
    vec3.copy(query.startPosition, startPosition);
    vec3.copy(query.endPosition, endPosition);
    query.filter = filter;

    // reset search state
    query.status = SlicedFindNodePathStatusFlags.FAILURE;
    query.nodes = {};
    query.openList = [];
    query.lastBestNode = null;
    query.lastBestNodeCost = Infinity;

    // validate input
    if (
        !isValidNodeRef(navMesh, startNodeRef) ||
        !isValidNodeRef(navMesh, endNodeRef) ||
        !vec3.finite(startPosition) ||
        !vec3.finite(endPosition)
    ) {
        query.status = SlicedFindNodePathStatusFlags.FAILURE | SlicedFindNodePathStatusFlags.INVALID_PARAM;
        return query.status;
    }

    // Handle raycast optimization
    if (flags & SlicedFindNodePathInitFlags.ANY_ANGLE) {
        // Set raycast limit for any-angle pathfinding
        query.raycastLimitSqr = 25.0; // Reasonable default value
        // TODO: limiting to several times the character radius yields nice results. It is not sensitive
        // so it is enough to compute it from the first tile.
        // const dtMeshTile* tile = m_nav->getTileByRef(startRef);
        // float agentRadius = tile->header->walkableRadius;
        // m_query.raycastLimitSqr = dtSqr(agentRadius * DT_RAY_CAST_LIMIT_PROPORTIONS);
    } else {
        // Clear raycast optimization
        query.raycastLimitSqr = null;
    }

    // start node
    const startNode: SearchNode = {
        cost: 0,
        total: vec3.distance(startPosition, endPosition) * HEURISTIC_SCALE,
        parentNodeRef: null,
        parentState: null,
        nodeRef: startNodeRef,
        state: 0,
        flags: NODE_FLAG_OPEN,
        position: [startPosition[0], startPosition[1], startPosition[2]],
    };

    addSearchNode(query.nodes, startNode);
    query.lastBestNode = startNode;
    query.lastBestNodeCost = startNode.total;

    // early exit if the start poly is the end poly
    if (startNodeRef === endNodeRef) {
        query.status = SlicedFindNodePathStatusFlags.SUCCESS;
        return query.status;
    }

    pushNodeToQueue(query.openList, startNode);
    query.status = SlicedFindNodePathStatusFlags.IN_PROGRESS;

    return query.status;
};

/**
 * Updates an in-progress sliced path query.
 *
 * @param navMesh The navigation mesh
 * @param query The sliced path query to update
 * @param maxIterations The maximum number of iterations to perform
 * @returns iterations performed
 */
export const updateSlicedFindNodePath = (navMesh: NavMesh, query: SlicedNodePathQuery, maxIterations: number): number => {
    let itersDone = 0;

    // check if query is in valid state
    if (!(query.status & SlicedFindNodePathStatusFlags.IN_PROGRESS)) {
        return itersDone;
    }

    // validate refs are still valid
    if (!isValidNodeRef(navMesh, query.startNodeRef) || !isValidNodeRef(navMesh, query.endNodeRef)) {
        query.status = SlicedFindNodePathStatusFlags.FAILURE;
        return itersDone;
    }

    const getCost = query.filter.getCost;

    while (itersDone < maxIterations && query.openList.length > 0) {
        itersDone++;

        // remove best node from open list and close it
        const bestSearchNode = popNodeFromQueue(query.openList)!;
        bestSearchNode.flags &= ~NODE_FLAG_OPEN;
        bestSearchNode.flags |= NODE_FLAG_CLOSED;

        // check if we've reached the goal
        if (bestSearchNode.nodeRef === query.endNodeRef) {
            query.lastBestNode = bestSearchNode;
            query.status = SlicedFindNodePathStatusFlags.SUCCESS;
            return itersDone;
        }

        // get best node
        const bestNodeRef = bestSearchNode.nodeRef;
        const bestNode = getNodeByRef(navMesh, bestNodeRef);

        // get parent for backtracking prevention
        const parentNodeRef = bestSearchNode.parentNodeRef ?? undefined;

        // expand to neighbors
        for (const linkIndex of bestNode.links) {
            const link = navMesh.links[linkIndex];
            const neighbourNodeRef = link.toNodeRef;

            // skip parent nodes
            if (neighbourNodeRef === parentNodeRef) {
                continue;
            }

            // apply filter
            if (!query.filter.passFilter(neighbourNodeRef, navMesh)) {
                continue;
            }

            // handle tile boundary crossing
            let state = 0;
            if (link.side !== 0xff) {
                state = link.side >> 1;
            }

            // get or create neighbor node
            let neighbourSearchNode = getSearchNode(query.nodes, neighbourNodeRef, state);

            if (!neighbourSearchNode) {
                neighbourSearchNode = {
                    cost: 0,
                    total: 0,
                    parentNodeRef: null,
                    parentState: null,
                    nodeRef: neighbourNodeRef,
                    state,
                    flags: 0,
                    position: [0, 0, 0],
                };

                addSearchNode(query.nodes, neighbourSearchNode);

                getEdgeMidPoint(navMesh, bestNodeRef, neighbourNodeRef, neighbourSearchNode.position);
            }

            // calculate costs
            let cost = 0;
            let heuristic = 0;

            // check for raycast shortcut (if enabled)
            let foundShortcut = false;
            if (query.raycastLimitSqr && bestSearchNode.parentNodeRef !== null && bestSearchNode.parentState !== null) {
                // get grandparent node for potential raycast shortcut
                const grandparentNode = getSearchNode(query.nodes, bestSearchNode.parentNodeRef, bestSearchNode.parentState);

                if (grandparentNode) {
                    const rayLength = vec3.distance(grandparentNode.position, neighbourSearchNode.position);

                    if (rayLength < Math.sqrt(query.raycastLimitSqr)) {
                        // attempt raycast from grandparent to current neighbor
                        const rayResult = raycastWithCosts(
                            navMesh,
                            grandparentNode.nodeRef,
                            grandparentNode.position,
                            neighbourSearchNode.position,
                            query.filter,
                            grandparentNode.parentNodeRef ?? 0, // pass the great-grandparent for accurate cost calculations
                        );

                        // if the raycast didn't hit anything, we can take the shortcut
                        if (rayResult.t >= 1.0) {
                            foundShortcut = true;
                            cost = grandparentNode.cost + rayResult.pathCost;
                        }
                    }
                }
            }

            // normal cost calculation (if no shortcut found)
            if (!foundShortcut) {
                const curCost = getCost(
                    bestSearchNode.position,
                    neighbourSearchNode.position,
                    navMesh,
                    parentNodeRef,
                    bestNodeRef,
                    neighbourNodeRef,
                );
                cost = bestSearchNode.cost + curCost;
            }

            // special case for last node - add cost to reach end position
            if (neighbourNodeRef === query.endNodeRef) {
                const endCost = getCost(
                    neighbourSearchNode.position,
                    query.endPosition,
                    navMesh,
                    bestNodeRef,
                    neighbourNodeRef,
                    undefined,
                );
                cost = cost + endCost;
                heuristic = 0;
            } else {
                heuristic = vec3.distance(neighbourSearchNode.position, query.endPosition) * HEURISTIC_SCALE;
            }

            const total = cost + heuristic;

            // skip if worse than existing
            if (
                (neighbourSearchNode.flags & NODE_FLAG_OPEN && total >= neighbourSearchNode.total) ||
                (neighbourSearchNode.flags & NODE_FLAG_CLOSED && total >= neighbourSearchNode.total)
            ) {
                continue;
            }

            // update node
            if (foundShortcut) {
                neighbourSearchNode.parentNodeRef = bestSearchNode.parentNodeRef;
                neighbourSearchNode.parentState = bestSearchNode.parentState;
            } else {
                neighbourSearchNode.parentNodeRef = bestSearchNode.nodeRef;
                neighbourSearchNode.parentState = bestSearchNode.state;
            }
            neighbourSearchNode.cost = cost;
            neighbourSearchNode.total = total;
            neighbourSearchNode.flags &= ~NODE_FLAG_CLOSED;

            // mark as detached parent if raycast shortcut was used
            if (foundShortcut) {
                neighbourSearchNode.flags |= NODE_FLAG_PARENT_DETACHED;
            } else {
                neighbourSearchNode.flags &= ~NODE_FLAG_PARENT_DETACHED;
            }

            if (neighbourSearchNode.flags & NODE_FLAG_OPEN) {
                reindexNodeInQueue(query.openList, neighbourSearchNode);
            } else {
                neighbourSearchNode.flags |= NODE_FLAG_OPEN;
                pushNodeToQueue(query.openList, neighbourSearchNode);
            }

            // update best node tracking
            if (heuristic < query.lastBestNodeCost) {
                query.lastBestNodeCost = heuristic;
                query.lastBestNode = neighbourSearchNode;
            }
        }
    }

    // check if the search is exhausted
    if (query.openList.length === 0) {
        query.status = SlicedFindNodePathStatusFlags.SUCCESS | SlicedFindNodePathStatusFlags.PARTIAL_RESULT;
    }

    return itersDone;
};

/**
 * Finalizes and returns the results of a sliced path query.
 *
 * @param navMesh The navigation mesh
 * @param query The sliced path query to finalize
 * @returns Object containing the status, path, and path count
 */
export const finalizeSlicedFindNodePath = (
    navMesh: NavMesh,
    query: SlicedNodePathQuery,
): { status: SlicedFindNodePathStatusFlags; path: NodeRef[]; pathCount: number } => {
    const result = {
        status: SlicedFindNodePathStatusFlags.FAILURE,
        path: [] as NodeRef[],
        pathCount: 0,
    };

    if (!query.lastBestNode) {
        query.status = SlicedFindNodePathStatusFlags.FAILURE;
        return { ...result, status: query.status };
    }

    // handle same start/end case
    if (query.startNodeRef === query.endNodeRef) {
        result.path.push(query.startNodeRef);
        result.pathCount = 1;
        result.status = SlicedFindNodePathStatusFlags.SUCCESS;
        // reset query
        query.status = SlicedFindNodePathStatusFlags.NOT_INITIALIZED;
        return result;
    }

    // check for partial result
    if (query.lastBestNode.nodeRef !== query.endNodeRef) {
        query.status |= SlicedFindNodePathStatusFlags.PARTIAL_RESULT;
    }

    // reverse the path by traversing parent chain and flipping detached parent flags
    type PathNode = { node: SearchNode; wasDetached: boolean };
    const reversedPath: PathNode[] = [];
    let currentNode: SearchNode | null = query.lastBestNode;

    while (currentNode) {
        const wasDetached = (currentNode.flags & NODE_FLAG_PARENT_DETACHED) !== 0;
        reversedPath.push({ node: currentNode, wasDetached });

        if (currentNode.parentNodeRef !== null && currentNode.parentState !== null) {
            currentNode = getSearchNode(query.nodes, currentNode.parentNodeRef, currentNode.parentState) ?? null;
        } else {
            currentNode = null;
        }
    }

    // reverse to get forward order
    reversedPath.reverse();

    // build final path, filling in raycast shortcuts if any-angle pathfinding was enabled
    const finalPath: NodeRef[] = [];

    if (query.raycastLimitSqr !== null) {
        // any-angle pathfinding was enabled, need to fill in raycast shortcuts
        for (let i = 0; i < reversedPath.length; i++) {
            const current = reversedPath[i];
            const next = i + 1 < reversedPath.length ? reversedPath[i + 1] : null;

            // if this node has a detached parent, we need to raycast to fill the gap
            if (next && current.wasDetached) {
                // raycast from current position to next position to get intermediate polygons
                const rayResult = raycast(
                    navMesh,
                    current.node.nodeRef,
                    current.node.position,
                    next.node.position,
                    query.filter,
                );

                // add all polygons from the raycast
                for (const polyRef of rayResult.path) {
                    finalPath.push(polyRef);
                }

                // the raycast ends on a poly boundary and might include the next poly
                // remove duplicate if the last poly in raycast matches the next node
                if (finalPath.length > 0 && finalPath[finalPath.length - 1] === next.node.nodeRef) {
                    finalPath.pop();
                }
            } else {
                // normal adjacent connection, just add the node
                finalPath.push(current.node.nodeRef);
            }
        }
    } else {
        // no any-angle pathfinding, just extract the node refs
        for (let i = 0; i < reversedPath.length; i++) {
            finalPath.push(reversedPath[i].node.nodeRef);
        }
    }

    result.path = finalPath;
    result.pathCount = result.path.length;
    result.status = SlicedFindNodePathStatusFlags.SUCCESS | (query.status & SlicedFindNodePathStatusFlags.PARTIAL_RESULT);

    // reset query
    query.status = SlicedFindNodePathStatusFlags.NOT_INITIALIZED;

    return result;
};

/**
 * Finalizes and returns the results of an incomplete sliced path query,
 * returning the path to the furthest polygon on the existing path that was visited during the search.
 *
 * @param navMesh The navigation mesh
 * @param query The sliced path query to finalize
 * @param existingPath An array of polygon references for the existing path
 * @returns Object containing the status, path, and path count
 */
export const finalizeSlicedFindNodePathPartial = (
    navMesh: NavMesh,
    query: SlicedNodePathQuery,
    existingPath: NodeRef[],
): { status: SlicedFindNodePathStatusFlags; path: NodeRef[]; pathCount: number } => {
    const result = {
        status: SlicedFindNodePathStatusFlags.FAILURE,
        path: [] as NodeRef[],
        pathCount: 0,
    };

    // find furthest visited node from existing path
    let furthestNode: SearchNode | null = null;

    for (let i = existingPath.length - 1; i >= 0; i--) {
        const targetNodeRef = existingPath[i];

        // search through all nodes to find one with matching nodeRef (regardless of state)
        const nodes = query.nodes[targetNodeRef];
        if (nodes) {
            for (let j = 0; j < nodes.length; j++) {
                const node = nodes[j];
                if (node.nodeRef === targetNodeRef) {
                    furthestNode = node;
                    break;
                }
            }
        }

        if (furthestNode) {
            break;
        }
    }

    if (!furthestNode) {
        furthestNode = query.lastBestNode;
        query.status |= SlicedFindNodePathStatusFlags.PARTIAL_RESULT;
    }

    if (!furthestNode) {
        query.status = SlicedFindNodePathStatusFlags.FAILURE;
        return { ...result, status: query.status };
    }

    // handle same start/end case
    if (query.startNodeRef === query.endNodeRef) {
        result.path.push(query.startNodeRef);
        result.pathCount = 1;
        result.status = SlicedFindNodePathStatusFlags.SUCCESS;
        // reset query
        query.status = SlicedFindNodePathStatusFlags.NOT_INITIALIZED;
        return result;
    }

    // mark as partial result since we're working with an incomplete search
    query.status |= SlicedFindNodePathStatusFlags.PARTIAL_RESULT;

    // reverse the path by traversing parent chain and flipping detached parent flags
    type PathNode = { node: SearchNode; wasDetached: boolean };
    const reversedPath: PathNode[] = [];
    let currentNode: SearchNode | null = furthestNode;

    while (currentNode) {
        const wasDetached = (currentNode.flags & NODE_FLAG_PARENT_DETACHED) !== 0;
        reversedPath.push({ node: currentNode, wasDetached });

        if (currentNode.parentNodeRef !== null && currentNode.parentState !== null) {
            currentNode = getSearchNode(query.nodes, currentNode.parentNodeRef, currentNode.parentState) ?? null;
        } else {
            currentNode = null;
        }
    }

    // reverse to get forward order
    reversedPath.reverse();

    // build final path, filling in raycast shortcuts if any-angle pathfinding was enabled
    const finalPath: NodeRef[] = [];

    if (query.raycastLimitSqr !== null) {
        // any-angle pathfinding was enabled, need to fill in raycast shortcuts
        for (let i = 0; i < reversedPath.length; i++) {
            const current = reversedPath[i];
            const next = i + 1 < reversedPath.length ? reversedPath[i + 1] : null;

            // if this node has a detached parent, we need to raycast to fill the gap
            if (next && current.wasDetached) {
                // raycast from current position to next position to get intermediate polygons
                const rayResult = raycast(
                    navMesh,
                    current.node.nodeRef,
                    current.node.position,
                    next.node.position,
                    query.filter,
                );

                // add all polygons from the raycast
                for (const polyRef of rayResult.path) {
                    finalPath.push(polyRef);
                }

                // the raycast ends on a poly boundary and might include the next poly
                // remove duplicate if the last poly in raycast matches the next node
                if (finalPath.length > 0 && finalPath[finalPath.length - 1] === next.node.nodeRef) {
                    finalPath.pop();
                }
            } else {
                // normal adjacent connection, just add the node
                finalPath.push(current.node.nodeRef);
            }
        }
    } else {
        // no any-angle pathfinding, just extract the node refs
        for (let i = 0; i < reversedPath.length; i++) {
            finalPath.push(reversedPath[i].node.nodeRef);
        }
    }

    result.path = finalPath;
    result.pathCount = result.path.length;
    result.status = SlicedFindNodePathStatusFlags.SUCCESS | SlicedFindNodePathStatusFlags.PARTIAL_RESULT;

    // reset query
    query.status = SlicedFindNodePathStatusFlags.NOT_INITIALIZED;

    return result;
};

const _moveAlongSurface_vertices: number[] = [];
const _moveAlongSurface_polyHeightResult = createGetPolyHeightResult();
const _moveAlongSurface_wallEdgeVj = vec3.create();
const _moveAlongSurface_wallEdgeVi = vec3.create();
const _moveAlongSurface_linkVj = vec3.create();
const _moveAlongSurface_linkVi = vec3.create();
const _moveAlongSurface_distancePtSegSqr2dResult = createDistancePtSegSqr2dResult();

export type MoveAlongSurfaceResult = {
    success: boolean;
    position: Vec3;
    nodeRef: NodeRef;
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
 * The resulting position is projected onto the surface of the navigation mesh with @see getPolyHeight.
 *
 * @param navMesh The navigation mesh
 * @param startNodeRef The reference ID of the starting polygon
 * @param startPosition The starting position [(x, y, z)]
 * @param endPosition The ending position [(x, y, z)]
 * @param filter The query filter.
 * @returns Result containing status, final position, and visited polygons
 */
export const moveAlongSurface = (
    navMesh: NavMesh,
    startNodeRef: NodeRef,
    startPosition: Vec3,
    endPosition: Vec3,
    filter: QueryFilter,
): MoveAlongSurfaceResult => {
    const result: MoveAlongSurfaceResult = {
        success: false,
        position: vec3.clone(startPosition),
        nodeRef: startNodeRef,
        visited: [],
    };

    if (!isValidNodeRef(navMesh, startNodeRef) || !vec3.finite(startPosition) || !vec3.finite(endPosition)) {
        return result;
    }

    result.success = true;

    const nodes: SearchNodePool = {};

    const startNode: SearchNode = {
        cost: 0,
        total: 0,
        parentNodeRef: null,
        parentState: null,
        nodeRef: startNodeRef,
        state: 0,
        flags: NODE_FLAG_CLOSED,
        position: [startPosition[0], startPosition[1], startPosition[2]],
    };

    addSearchNode(nodes, startNode);

    const bestPos = vec3.clone(startPosition);
    let bestDist = Infinity;
    let bestNode: SearchNode | null = startNode;

    // search constraints
    const searchPos = vec3.create();
    vec3.lerp(searchPos, startPosition, endPosition, 0.5);
    const searchRadSqr = (vec3.distance(startPosition, endPosition) / 2.0 + 0.001) ** 2;

    // breadth-first search queue (no priority needed for this algorithm)
    const queue: SearchNodeQueue = [startNode];

    while (queue.length > 0) {
        const curNode = queue.shift()!;

        // get poly and tile
        const curRef = curNode.nodeRef;
        const tileAndPoly = getTileAndPolyByRef(curRef, navMesh);

        if (!tileAndPoly.success) continue;

        const { tile, poly } = tileAndPoly;

        // collect vertices
        const nv = poly.vertices.length;
        const vertices = _moveAlongSurface_vertices;
        for (let i = 0; i < nv; ++i) {
            const start = poly.vertices[i] * 3;
            vertices[i * 3] = tile.vertices[start];
            vertices[i * 3 + 1] = tile.vertices[start + 1];
            vertices[i * 3 + 2] = tile.vertices[start + 2];
        }

        // if target is inside the poly, stop search
        if (pointInPoly(endPosition, vertices, nv)) {
            bestNode = curNode;
            vec3.copy(bestPos, endPosition);
            break;
        }

        // find wall edges and find nearest point inside the walls
        for (let i = 0, j = nv - 1; i < nv; j = i++) {
            // find links to neighbours
            const neis: NodeRef[] = [];
            const node = getNodeByRef(navMesh, curRef);

            for (const linkIndex of node.links) {
                const link = navMesh.links[linkIndex];
                if (!link) continue;

                const neighbourRef = link.toNodeRef;

                // check if this link corresponds to edge j
                if (link.edge === j) {
                    // check filter
                    if (!filter.passFilter(neighbourRef, navMesh)) {
                        continue;
                    }

                    neis.push(neighbourRef);
                }
            }

            if (neis.length === 0) {
                // wall edge, calc distance
                const vj = vec3.fromBuffer(_moveAlongSurface_wallEdgeVj, vertices, j * 3);
                const vi = vec3.fromBuffer(_moveAlongSurface_wallEdgeVi, vertices, i * 3);

                const { distSqr, t: tSeg } = distancePtSegSqr2d(_moveAlongSurface_distancePtSegSqr2dResult, endPosition, vj, vi);

                if (distSqr < bestDist) {
                    // update nearest distance
                    vec3.lerp(bestPos, vj, vi, tSeg);
                    bestDist = distSqr;
                    bestNode = curNode;
                }
            } else {
                for (const neighbourRef of neis) {
                    let neighbourNode = getSearchNode(nodes, neighbourRef, 0);

                    if (!neighbourNode) {
                        neighbourNode = {
                            cost: 0,
                            total: 0,
                            parentNodeRef: null,
                            parentState: null,
                            nodeRef: neighbourRef,
                            state: 0,
                            flags: 0,
                            position: [endPosition[0], endPosition[1], endPosition[2]],
                        };
                        addSearchNode(nodes, neighbourNode);
                    }

                    // skip if already visited
                    if (neighbourNode.flags & NODE_FLAG_CLOSED) continue;

                    // skip the link if it is too far from search constraint
                    const vj = vec3.fromBuffer(_moveAlongSurface_linkVj, vertices, j * 3);
                    const vi = vec3.fromBuffer(_moveAlongSurface_linkVi, vertices, i * 3);

                    const distSqr = distancePtSegSqr2d(_moveAlongSurface_distancePtSegSqr2dResult, searchPos, vj, vi).distSqr;

                    if (distSqr > searchRadSqr) continue;

                    // mark as visited and add to queue
                    neighbourNode.parentNodeRef = curNode.nodeRef;
                    neighbourNode.parentState = curNode.state;
                    neighbourNode.flags |= NODE_FLAG_CLOSED;
                    queue.push(neighbourNode);
                }
            }
        }
    }

    if (bestNode) {
        let currentNode: SearchNode | null = bestNode;
        while (currentNode) {
            result.visited.push(currentNode.nodeRef);

            if (currentNode.parentNodeRef !== null) {
                currentNode = getSearchNode(nodes, currentNode.parentNodeRef, 0) ?? null;
            } else {
                currentNode = null;
            }
        }

        result.visited.reverse();

        vec3.copy(result.position, bestPos);
        result.nodeRef = bestNode.nodeRef;

        // fixup height with getPolyHeight
        const tileAndPoly = getTileAndPolyByRef(result.nodeRef, navMesh);

        if (tileAndPoly.success) {
            const polyHeightResult = getPolyHeight(
                _moveAlongSurface_polyHeightResult,
                tileAndPoly.tile,
                tileAndPoly.poly,
                tileAndPoly.polyIndex,
                result.position,
            );

            if (polyHeightResult.success) {
                result.position[1] = polyHeightResult.height;
            }
        }
    }

    return result;
};

const _raycast_vertices: number[] = [];
const _raycast_dir = vec3.create();
const _raycast_curPos = vec3.create();
const _raycast_lastPos = vec3.create();
const _raycast_e1Vec = vec3.create();
const _raycast_e0Vec = vec3.create();
const _raycast_eDir = vec3.create();
const _raycast_diff = vec3.create();
const _raycast_hitNormal_va = vec3.create();
const _raycast_hitNormal_vb = vec3.create();

export type RaycastResult = {
    /** The hit parameter along the segment. A value of Number.MAX_VALUE indicates no wall hit. */
    t: number;
    /** Normal vector of the hit wall. */
    hitNormal: Vec3;
    /** Index of the edge hit. */
    hitEdgeIndex: number;
    /** Visited polygon references. */
    path: NodeRef[];
    /** Accumulated path cost from start to hit position. Only calculated when calculateCosts is true. */
    pathCost: number;
};

/**
 * Internal base implementation of raycast that handles both cost calculation modes.
 * 
 * Casts a 'walkability' ray along the surface of the navigation mesh from
 * the start position toward the end position.
 *
 * This method is meant to be used for quick, short distance checks.
 * The raycast ignores the y-value of the end position (2D check).
 *
 * @param navMesh The navigation mesh to use for the raycast.
 * @param startNodeRef The NodeRef for the start polygon
 * @param startPosition The starting position in world space.
 * @param endPosition The ending position in world space.
 * @param filter The query filter to apply.
 * @param calculateCosts Whether to calculate and accumulate path costs across polygons.
 * @param prevRef The reference to the polygon we came from (for accurate cost calculations).
 */
const raycastBase = (
    navMesh: NavMesh,
    startNodeRef: NodeRef,
    startPosition: Vec3,
    endPosition: Vec3,
    filter: QueryFilter,
    calculateCosts: boolean,
    prevRef: NodeRef,
): RaycastResult => {
    const result: RaycastResult = {
        t: 0,
        hitNormal: vec3.create(),
        hitEdgeIndex: -1,
        path: [],
        pathCost: 0,
    };

    // validate input
    if (!isValidNodeRef(navMesh, startNodeRef) || !vec3.finite(startPosition) || !vec3.finite(endPosition) || !filter) {
        return result;
    }

    let curRef: NodeRef | null = startNodeRef;
    let prevRefTracking: NodeRef = prevRef;

    const intersectSegmentPoly2DResult = createIntersectSegmentPoly2DResult();

    if (calculateCosts) {
        vec3.sub(_raycast_dir, endPosition, startPosition);
        vec3.copy(_raycast_curPos, startPosition);
    }

    while (curRef) {
        // get current tile and poly
        const tileAndPolyResult = getTileAndPolyByRef(curRef, navMesh);
        if (!tileAndPolyResult.success) break;
        const { tile, poly } = tileAndPolyResult;

        // collect current poly vertices
        const nv = poly.vertices.length;
        const vertices = _raycast_vertices;
        for (let i = 0; i < nv; i++) {
            const start = poly.vertices[i] * 3;
            vertices[i * 3] = tile.vertices[start];
            vertices[i * 3 + 1] = tile.vertices[start + 1];
            vertices[i * 3 + 2] = tile.vertices[start + 2];
        }

        // cast ray against current polygon
        intersectSegmentPoly2D(intersectSegmentPoly2DResult, startPosition, endPosition, nv, vertices);
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
        let nextRef: NodeRef | undefined;

        const curNode = getNodeByRef(navMesh, curRef);

        for (const linkIndex of curNode.links) {
            const link = navMesh.links[linkIndex];

            // find link which contains this edge
            if (link.edge !== intersectSegmentPoly2DResult.segMax) continue;

            // skip off-mesh connections
            if (getNodeRefType(link.toNodeRef) === NodeType.OFFMESH) continue;

            // get pointer to the next polygon
            const nextTileAndPolyResult = getTileAndPolyByRef(link.toNodeRef, navMesh);
            if (!nextTileAndPolyResult.success) continue;

            // skip links based on filter
            if (!filter.passFilter(link.toNodeRef, navMesh)) continue;

            // if the link is internal, just return the ref
            if (link.side === 0xff) {
                nextRef = link.toNodeRef;
                break;
            }

            // if the link is at tile boundary, check if the link spans the whole edge
            if (link.bmin === 0 && link.bmax === 255) {
                nextRef = link.toNodeRef;
                break;
            }

            // check for partial edge links
            const v0 = poly.vertices[link.edge];
            const v1 = poly.vertices[(link.edge + 1) % poly.vertices.length];
            const left = [tile.vertices[v0 * 3], tile.vertices[v0 * 3 + 1], tile.vertices[v0 * 3 + 2]] as Vec3;
            const right = [tile.vertices[v1 * 3], tile.vertices[v1 * 3 + 1], tile.vertices[v1 * 3 + 2]] as Vec3;

            // check that the intersection lies inside the link portal
            if (link.side === 0 || link.side === 4) {
                // calculate link size
                const s = 1.0 / 255.0;
                let lmin = left[2] + (right[2] - left[2]) * (link.bmin * s);
                let lmax = left[2] + (right[2] - left[2]) * (link.bmax * s);
                if (lmin > lmax) [lmin, lmax] = [lmax, lmin];

                // find Z intersection
                const z = startPosition[2] + (endPosition[2] - startPosition[2]) * intersectSegmentPoly2DResult.tmax;
                if (z >= lmin && z <= lmax) {
                    nextRef = link.toNodeRef;
                    break;
                }
            } else if (link.side === 2 || link.side === 6) {
                // calculate link size
                const s = 1.0 / 255.0;
                let lmin = left[0] + (right[0] - left[0]) * (link.bmin * s);
                let lmax = left[0] + (right[0] - left[0]) * (link.bmax * s);
                if (lmin > lmax) [lmin, lmax] = [lmax, lmin];

                // find X intersection
                const x = startPosition[0] + (endPosition[0] - startPosition[0]) * intersectSegmentPoly2DResult.tmax;
                if (x >= lmin && x <= lmax) {
                    nextRef = link.toNodeRef;
                    break;
                }
            }
        }

        if (nextRef === undefined) {
            // no neighbor, we hit a wall

            // calculate hit normal
            if (intersectSegmentPoly2DResult.segMax >= 0) {
                const a = intersectSegmentPoly2DResult.segMax;
                const b =
                    intersectSegmentPoly2DResult.segMax + 1 < poly.vertices.length ? intersectSegmentPoly2DResult.segMax + 1 : 0;
                vec3.fromBuffer(_raycast_hitNormal_va, vertices, a * 3);
                vec3.fromBuffer(_raycast_hitNormal_vb, vertices, b * 3);
                const dx = _raycast_hitNormal_vb[0] - _raycast_hitNormal_va[0];
                const dz = _raycast_hitNormal_vb[2] - _raycast_hitNormal_va[2];
                result.hitNormal[0] = dz;
                result.hitNormal[1] = 0;
                result.hitNormal[2] = -dx;
                vec3.normalize(result.hitNormal, result.hitNormal);
            }

            return result;
        }

        // calculate cost along the path
        if (calculateCosts) {
            // update curPos to the hit point on this polygon's edge
            vec3.copy(_raycast_lastPos, _raycast_curPos);
            vec3.scaleAndAdd(_raycast_curPos, startPosition, _raycast_dir, result.t);

            // calculate height at the hit point by lerping vertices of the hit edge
            const e0 = poly.vertices[intersectSegmentPoly2DResult.segMax];
            const e1 = poly.vertices[(intersectSegmentPoly2DResult.segMax + 1) % poly.vertices.length];

            const e1Offset = e1 * 3;
            const e0Offset = e0 * 3;

            vec3.fromBuffer(_raycast_e1Vec, tile.vertices, e1Offset);
            vec3.fromBuffer(_raycast_e0Vec, tile.vertices, e0Offset);

            vec3.sub(_raycast_eDir, _raycast_e1Vec, _raycast_e0Vec);

            vec3.sub(_raycast_diff, _raycast_curPos, _raycast_e0Vec);

            // use squared comparison to determine which component to use
            const s =
                _raycast_eDir[0] * _raycast_eDir[0] > _raycast_eDir[2] * _raycast_eDir[2]
                    ? _raycast_diff[0] / _raycast_eDir[0]
                    : _raycast_diff[2] / _raycast_eDir[2];

            _raycast_curPos[1] = _raycast_e0Vec[1] + _raycast_eDir[1] * s;

            // accumulate cost
            result.pathCost += filter.getCost(_raycast_lastPos, _raycast_curPos, navMesh, prevRefTracking, curRef, nextRef);
        }

        // no hit, advance to neighbor polygon
        prevRefTracking = curRef;
        curRef = nextRef;
    }

    return result;
};

/**
 * Casts a 'walkability' ray along the surface of the navigation mesh from
 * the start position toward the end position.
 *
 * This method is meant to be used for quick, short distance checks.
 * The raycast ignores the y-value of the end position (2D check).
 *
 * @param navMesh The navigation mesh to use for the raycast.
 * @param startNodeRef The NodeRef for the start polygon
 * @param startPosition The starting position in world space.
 * @param endPosition The ending position in world space.
 * @param filter The query filter to apply.
 * @returns The raycast result with hit information and visited polygons (without cost calculation).
 */
export const raycast = (
    navMesh: NavMesh,
    startNodeRef: NodeRef,
    startPosition: Vec3,
    endPosition: Vec3,
    filter: QueryFilter,
): RaycastResult => {
    return raycastBase(navMesh, startNodeRef, startPosition, endPosition, filter, false, 0);
};

/**
 * Casts a 'walkability' ray along the surface of the navigation mesh from
 * the start position toward the end position, calculating accumulated path costs.
 *
 * This method is meant to be used for quick, short distance checks.
 * The raycast ignores the y-value of the end position (2D check).
 *
 * @param navMesh The navigation mesh to use for the raycast.
 * @param startNodeRef The NodeRef for the start polygon
 * @param startPosition The starting position in world space.
 * @param endPosition The ending position in world space.
 * @param filter The query filter to apply.
 * @param prevRef The reference to the polygon we came from (for accurate cost calculations).
 * @returns The raycast result with hit information, visited polygons, and accumulated path costs.
 */
export const raycastWithCosts = (
    navMesh: NavMesh,
    startNodeRef: NodeRef,
    startPosition: Vec3,
    endPosition: Vec3,
    filter: QueryFilter,
    prevRef: NodeRef,
): RaycastResult => {
    return raycastBase(navMesh, startNodeRef, startPosition, endPosition, filter, true, prevRef);
};

const _findRandomPointVertices: number[] = [];

export type FindRandomPointResult = {
    success: boolean;
    nodeRef: NodeRef;
    position: Vec3;
};

/**
 * Finds a random point on the navigation mesh.
 *
 * @param navMesh The navigation mesh
 * @param filter Query filter to apply to polygons
 * @param rand Function that returns random values between [0,1]
 * @returns The result object with success flag, random point, and polygon reference
 */
export const findRandomPoint = (navMesh: NavMesh, filter: QueryFilter, rand: () => number): FindRandomPointResult => {
    const result: FindRandomPointResult = {
        success: false,
        nodeRef: 0,
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

        const node = getNodeByTileAndPoly(navMesh, selectedTile, i);

        // must pass filter
        if (!filter.passFilter(node.ref, navMesh)) {
            continue;
        }

        // calculate area of the polygon using triangulation
        let polyArea = 0;
        const va = vec3.create();
        const vb = vec3.create();
        const vc = vec3.create();
        for (let j = 2; j < poly.vertices.length; j++) {
            vec3.fromBuffer(va, selectedTile.vertices, poly.vertices[0] * 3);
            vec3.fromBuffer(vb, selectedTile.vertices, poly.vertices[j - 1] * 3);
            vec3.fromBuffer(vc, selectedTile.vertices, poly.vertices[j] * 3);
            polyArea += triArea2D(va, vb, vc);
        }

        // choose random polygon weighted by area, using reservoir sampling
        areaSum += polyArea;
        const u = rand();
        if (u * areaSum <= polyArea) {
            selectedPoly = poly;
            selectedPolyRef = node.ref;
        }
    }

    if (!selectedPoly || !selectedPolyRef) {
        return result;
    }

    // randomly pick point on polygon
    const nv = selectedPoly.vertices.length;
    const vertices = _findRandomPointVertices;
    for (let j = 0; j < nv; j++) {
        const start = selectedPoly.vertices[j] * 3;
        vertices[j * 3] = selectedTile.vertices[start];
        vertices[j * 3 + 1] = selectedTile.vertices[start + 1];
        vertices[j * 3 + 2] = selectedTile.vertices[start + 2];
    }

    const s = rand();
    const t = rand();
    const areas = new Array(nv);
    const pt: Vec3 = [0, 0, 0];

    randomPointInConvexPoly(pt, nv, vertices, areas, s, t);

    // project point onto polygon surface to ensure it's exactly on the mesh
    const closestPointResult = createGetClosestPointOnPolyResult();
    getClosestPointOnPoly(closestPointResult, navMesh, selectedPolyRef, pt);

    if (closestPointResult.success) {
        vec3.copy(result.position, closestPointResult.position);
    } else {
        vec3.copy(result.position, pt);
    }

    result.nodeRef = selectedPolyRef;
    result.success = true;

    return result;
};

const _findRandomPointAroundCircleVertices: number[] = [];
const _findRandomPointAroundCircle_distancePtSegSqr2dResult = createDistancePtSegSqr2dResult();

export type FindRandomPointAroundCircleResult = {
    success: boolean;
    nodeRef: NodeRef;
    position: Vec3;
};

/**
 * Finds a random point within a circle around a center position on the navigation mesh.
 *
 * Uses Dijkstra-like search to explore reachable polygons within the circle,
 * then selects a random polygon weighted by area, and finally generates
 * a random point within that polygon.
 *
 * @param navMesh The navigation mesh
 * @param startNodeRef Reference to the polygon to start the search from
 * @param position Center position of the search circle
 * @param maxRadius Maximum radius of the search circle
 * @param filter Query filter to apply to polygons
 * @param rand Function that returns random values [0,1]
 * @returns The result object with success flag, random point, and polygon reference
 */
export const findRandomPointAroundCircle = (
    navMesh: NavMesh,
    startNodeRef: NodeRef,
    position: Vec3,
    maxRadius: number,
    filter: QueryFilter,
    rand: () => number,
): FindRandomPointAroundCircleResult => {
    const result: FindRandomPointAroundCircleResult = {
        success: false,
        nodeRef: 0,
        position: [0, 0, 0],
    };

    // validate input
    if (!isValidNodeRef(navMesh, startNodeRef) || !vec3.finite(position) || maxRadius < 0 || !Number.isFinite(maxRadius)) {
        return result;
    }

    const startTileAndPoly = getTileAndPolyByRef(startNodeRef, navMesh);
    if (!startTileAndPoly.success) {
        return result;
    }

    // check if start polygon passes filter
    if (!filter.passFilter(startNodeRef, navMesh)) {
        return result;
    }

    // prepare search
    const nodes: SearchNodePool = {};
    const openList: SearchNodeQueue = [];

    const startNode: SearchNode = {
        cost: 0,
        total: 0,
        parentNodeRef: null,
        parentState: null,
        nodeRef: startNodeRef,
        state: 0,
        flags: NODE_FLAG_OPEN,
        position: [position[0], position[1], position[2]],
    };

    addSearchNode(nodes, startNode);
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
            vec3.fromBuffer(v1, bestTile.vertices, bestPoly.vertices[j - 1] * 3);
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
        const parentRef = bestNode.parentNodeRef;

        // iterate through all links from the current polygon
        const node = getNodeByRef(navMesh, bestRef);

        for (const linkIndex of node.links) {
            const link = navMesh.links[linkIndex];
            if (!link) continue;

            const neighbourRef = link.toNodeRef;

            // skip invalid neighbours and do not follow back to parent
            if (!neighbourRef || neighbourRef === parentRef) {
                continue;
            }

            // expand to neighbour
            const neighbourTileAndPoly = getTileAndPolyByRef(neighbourRef, navMesh);
            if (!neighbourTileAndPoly.success) continue;

            // do not advance if the polygon is excluded by the filter
            if (!filter.passFilter(neighbourRef, navMesh)) {
                continue;
            }

            // find edge and calc distance to the edge
            if (!getPortalPoints(navMesh, bestRef, neighbourRef, va, vb)) {
                continue;
            }

            // if the circle is not touching the next polygon, skip it
            const { distSqr } = distancePtSegSqr2d(_findRandomPointAroundCircle_distancePtSegSqr2dResult, position, va, vb);
            if (distSqr > radiusSqr) {
                continue;
            }

            // get or create neighbour node
            let neighbourNode = getSearchNode(nodes, neighbourRef, 0);

            if (!neighbourNode) {
                neighbourNode = {
                    cost: 0,
                    total: 0,
                    parentNodeRef: null,
                    parentState: null,
                    nodeRef: neighbourRef,
                    state: 0,
                    flags: 0,
                    position: [0, 0, 0],
                };
                addSearchNode(nodes, neighbourNode);
            }

            if (neighbourNode.flags & NODE_FLAG_CLOSED) {
                continue;
            }

            // set position if this is the first time we visit this node
            if (neighbourNode.flags === 0) {
                vec3.lerp(neighbourNode.position, va, vb, 0.5);
            }

            const total = bestNode.total + vec3.distance(bestNode.position, neighbourNode.position);

            // the node is already in open list and the new result is worse, skip
            if (neighbourNode.flags & NODE_FLAG_OPEN && total >= neighbourNode.total) {
                continue;
            }

            neighbourNode.parentNodeRef = bestRef;
            neighbourNode.parentState = 0;
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
    const nv = randomPoly.vertices.length;
    const vertices = _findRandomPointAroundCircleVertices;
    for (let j = 0; j < nv; j++) {
        const start = randomPoly.vertices[j] * 3;
        vertices[j * 3] = randomTile.vertices[start];
        vertices[j * 3 + 1] = randomTile.vertices[start + 1];
        vertices[j * 3 + 2] = randomTile.vertices[start + 2];
    }

    const s = rand();
    const t = rand();
    const areas = new Array(nv);
    const pt: Vec3 = [0, 0, 0];

    randomPointInConvexPoly(pt, nv, vertices, areas, s, t);

    // project point onto polygon surface to ensure it's exactly on the mesh
    const closestPointResult = createGetClosestPointOnPolyResult();
    getClosestPointOnPoly(closestPointResult, navMesh, randomPolyRef, pt);

    if (closestPointResult.success) {
        vec3.copy(result.position, closestPointResult.position);
    } else {
        vec3.copy(result.position, pt);
    }

    result.nodeRef = randomPolyRef;
    result.success = true;

    return result;
};
