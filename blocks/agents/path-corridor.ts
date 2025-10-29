import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import {
    createSlicedNodePathQuery,
    finalizeSlicedFindNodePathPartial,
    findStraightPath,
    getNodeByRef,
    initSlicedFindNodePath,
    INVALID_NODE_REF,
    isValidNodeRef,
    moveAlongSurface,
    type NavMesh,
    type NodeRef,
    NodeType,
    type QueryFilter,
    raycast,
    SlicedFindNodePathStatusFlags,
    type StraightPathPoint,
    updateSlicedFindNodePath,
} from 'navcat';

export type PathCorridor = {
    position: Vec3;
    target: Vec3;
    path: NodeRef[];
};

export const create = (): PathCorridor => ({
    position: [0, 0, 0],
    target: [0, 0, 0],
    path: [],
});

export const reset = (corridor: PathCorridor, ref: NodeRef, position: Vec3): void => {
    vec3.copy(corridor.position, position);
    vec3.copy(corridor.target, position);
    corridor.path = [ref];
};

export const setPath = (corridor: PathCorridor, target: Vec3, path: NodeRef[]): void => {
    vec3.copy(corridor.target, target);
    corridor.path = path;
};

export const mergeStartMoved = (currentPath: NodeRef[], visited: NodeRef[]): NodeRef[] => {
    if (visited.length === 0) return currentPath;

    let furthestPath = -1;
    let furthestVisited = -1;

    // find furthest common polygon
    for (let i = currentPath.length - 1; i >= 0; i--) {
        for (let j = visited.length - 1; j >= 0; j--) {
            if (currentPath[i] === visited[j]) {
                furthestPath = i;
                furthestVisited = j;
                break;
            }
        }
        if (furthestPath !== -1) break;
    }

    // if no intersection found, just return current path
    if (furthestPath === -1 || furthestVisited === -1) {
        return currentPath;
    }

    // concatenate paths
    const req = visited.length - furthestVisited;
    const orig = Math.min(furthestPath + 1, currentPath.length);
    const size = Math.max(0, currentPath.length - orig);

    const newPath: NodeRef[] = [];

    // store visited polygons (in reverse order)
    for (let i = 0; i < req; i++) {
        newPath[i] = visited[visited.length - 1 - i];
    }

    // add remaining current path
    if (size > 0) {
        for (let i = 0; i < size; i++) {
            newPath[req + i] = currentPath[orig + i];
        }
    }

    return newPath;
};

export const mergeStartShortcut = (currentPath: NodeRef[], visited: NodeRef[]): NodeRef[] => {
    if (visited.length === 0) return currentPath;

    let furthestPath = -1;
    let furthestVisited = -1;

    // find furthest common polygon
    for (let i = currentPath.length - 1; i >= 0; i--) {
        for (let j = visited.length - 1; j >= 0; j--) {
            if (currentPath[i] === visited[j]) {
                furthestPath = i;
                furthestVisited = j;
                break;
            }
        }
        if (furthestPath !== -1) break;
    }

    // if no intersection found, just return current path
    if (furthestPath === -1 || furthestVisited === -1) {
        return currentPath;
    }

    // concatenate paths
    const req = furthestVisited;
    if (req <= 0) {
        return currentPath;
    }

    const orig = furthestPath;
    const size = Math.max(0, currentPath.length - orig);

    const newPath: NodeRef[] = [];

    // store visited polygons (not reversed like mergeStartMoved)
    for (let i = 0; i < req; i++) {
        newPath[i] = visited[i];
    }

    // add remaining current path
    if (size > 0) {
        for (let i = 0; i < size; i++) {
            newPath[req + i] = currentPath[orig + i];
        }
    }

    return newPath;
};

export const movePosition = (corridor: PathCorridor, newPos: Vec3, navMesh: NavMesh, filter: QueryFilter): boolean => {
    if (corridor.path.length === 0) return false;

    const result = moveAlongSurface(navMesh, corridor.path[0], corridor.position, newPos, filter);

    if (result.success) {
        corridor.path = mergeStartMoved(corridor.path, result.visited);

        vec3.copy(corridor.position, result.position);

        return true;
    }

    return false;
};

const MIN_TARGET_DIST = 0.01;

export const findCorners = (
    corridor: PathCorridor,
    navMesh: NavMesh,
    maxCorners: number,
): false | StraightPathPoint[] => {
    if (corridor.path.length === 0) return false;

    const straightPathResult = findStraightPath(navMesh, corridor.position, corridor.target, corridor.path, maxCorners);

    if (!straightPathResult.success || straightPathResult.path.length === 0) {
        return false;
    }

    let corners = straightPathResult.path;

    // prune points in the beginning of the path which are too close
    while (corners.length > 0) {
        const firstCorner = corners[0];
        const distance = vec3.distance(corridor.position, firstCorner.position);

        // if the first corner is far enough, we're done pruning
        if (firstCorner.type === NodeType.OFFMESH || distance > MIN_TARGET_DIST) {
            break;
        }

        // remove the first corner as it's too close
        corners = corners.slice(1);
    }

    // prune points after an offmesh connection
    let firstOffMeshConnectionIndex = -1;

    for (let i = 0; i < corners.length; i++) {
        if (corners[i].type === NodeType.OFFMESH) {
            firstOffMeshConnectionIndex = i;
            break;
        }
    }

    if (firstOffMeshConnectionIndex !== -1) {
        corners = corners.slice(0, firstOffMeshConnectionIndex + 1);
    }

    return corners;
};

export const corridorIsValid = (corridor: PathCorridor, maxLookAhead: number, navMesh: NavMesh, filter: QueryFilter) => {
    const n = Math.min(corridor.path.length, maxLookAhead);
    
    // check nodes are still valid and pass query filter
    for (let i = 0; i < n; i++) {
        const nodeRef = corridor.path[i];
        if (!isValidNodeRef(navMesh, nodeRef) || !filter.passFilter(nodeRef, navMesh)) {
            return false;
        }
    }

    return true;
};

export const fixPathStart = (corridor: PathCorridor, safeRef: NodeRef, safePos: Vec3): boolean => {
    vec3.copy(corridor.position, safePos);

    if (corridor.path.length < 3 && corridor.path.length > 0) {
        const lastPoly = corridor.path[corridor.path.length - 1];
        corridor.path[2] = lastPoly;
        corridor.path[0] = safeRef;
        corridor.path[1] = INVALID_NODE_REF;
        corridor.path.length = 3;
    } else {
        corridor.path[0] = safeRef;
        corridor.path[1] = INVALID_NODE_REF;
    }

    return true;
};

export const moveOverOffMeshConnection = (corridor: PathCorridor, offMeshNodeRef: NodeRef, navMesh: NavMesh) => {
    if (corridor.path.length === 0) return false;

    // advance the path up to and over the off-mesh connection.
    let prevNodeRef: NodeRef | null = null;
    let nodeRef = corridor.path[0];
    let i = 0;
    
    while (i < corridor.path.length && nodeRef !== offMeshNodeRef) {
        prevNodeRef = nodeRef;
        i++;
        if (i < corridor.path.length) {
            nodeRef = corridor.path[i];
        }
    }
    
    if (i === corridor.path.length) {
        // could not find the off mesh connection node
        return false;
    }

    // prune path - remove the elements from 0 up to and including the off-mesh connection
    corridor.path = corridor.path.slice(i + 1);

    if (!prevNodeRef) {
        return false;
    }

    // get the off-mesh connection
    const { offMeshConnectionId } = getNodeByRef(navMesh, offMeshNodeRef);
    const offMeshConnection = navMesh.offMeshConnections[offMeshConnectionId];
    const offMeshConnectionAttachment = navMesh.offMeshConnectionAttachments[offMeshConnectionId];

    if (!offMeshConnection || !offMeshConnectionAttachment) return false;

    // determine which end we're moving to
    const onStart = offMeshConnectionAttachment.startPolyNode === prevNodeRef;
    const endPosition = onStart ? offMeshConnection.end : offMeshConnection.start;
    const endNodeRef = onStart ? offMeshConnectionAttachment.endPolyNode : offMeshConnectionAttachment.startPolyNode;

    vec3.copy(corridor.position, endPosition);

    return {
        startPosition: onStart ? offMeshConnection.start : offMeshConnection.end,
        endPosition,
        endNodeRef,
        prevNodeRef,
        offMeshNodeRef,
    };
};

/**
 * Attempts to optimize the path using a local area search (partial replanning).
 * 
 * Inaccurate locomotion or dynamic obstacle avoidance can force the agent position significantly 
 * outside the original corridor. Over time this can result in the formation of a non-optimal corridor.
 * This function will use a local area path search to try to re-optimize the corridor.
 * 
 * The more inaccurate the agent movement, the more beneficial this function becomes. 
 * Simply adjust the frequency of the call to match the needs of the agent.
 * 
 * @param corridor the path corridor
 * @param navMesh the navigation mesh
 * @param filter the query filter
 * @returns true if the path was optimized, false otherwise
 */
export const optimizePathTopology = (corridor: PathCorridor, navMesh: NavMesh, filter: QueryFilter): boolean => {
    if (corridor.path.length < 3) {
        return false;
    }

    const MAX_ITER = 32;
    
    const query = createSlicedNodePathQuery();
    
    // do a local area search from start to end
    initSlicedFindNodePath(
        navMesh,
        query,
        corridor.path[0],
        corridor.path[corridor.path.length - 1],
        corridor.position,
        corridor.target,
        filter,
    );
    
    updateSlicedFindNodePath(navMesh, query, MAX_ITER);
    
    const result = finalizeSlicedFindNodePathPartial(navMesh, query, corridor.path);
    
    if ((query.status & SlicedFindNodePathStatusFlags.SUCCESS) !== 0 && result.path.length > 0) {
        // merge the optimized path with the corridor using shortcut merge
        corridor.path = mergeStartShortcut(corridor.path, result.path);
        return true;
    }

    return false;
};

const _optimizePathVisibility_goal = vec3.create();
const _optimizePathVisibility_delta = vec3.create();

/**
 * Attempts to optimize the path if the specified point is visible from the current position.
 * 
 * Inaccurate locomotion or dynamic obstacle avoidance can force the agent position significantly 
 * outside the original corridor. Over time this can result in the formation of a non-optimal corridor.
 * Non-optimal paths can also form near the corners of tiles.
 * 
 * This function uses an efficient local visibility search to try to optimize the corridor 
 * between the current position and the target.
 * 
 * The corridor will change only if the target is visible from the current position and moving 
 * directly toward the point is better than following the existing path.
 * 
 * The more inaccurate the agent movement, the more beneficial this function becomes. 
 * Simply adjust the frequency of the call to match the needs of the agent.
 * 
 * This function is not suitable for long distance searches.
 * 
 * @param corridor the path corridor
 * @param next the point to search toward
 * @param pathOptimizationRange the maximum range to search
 * @param navMesh the navigation mesh
 * @param filter the query filter
 */
export const optimizePathVisibility = (
    corridor: PathCorridor, 
    next: Vec3, 
    pathOptimizationRange: number, 
    navMesh: NavMesh, 
    filter: QueryFilter
): void => {
    if (corridor.path.length === 0) {
        return;
    }

    // Clamp the ray to max distance.
    const goal = vec3.copy(_optimizePathVisibility_goal, next);
    const dx = goal[0] - corridor.position[0];
    const dz = goal[2] - corridor.position[2];
    let dist = Math.sqrt(dx * dx + dz * dz);

    // If too close to the goal, do not try to optimize.
    if (dist < 0.01) {
        return;
    }

    // Overshoot a little. This helps to optimize open fields in tiled meshes.
    dist = Math.min(dist + 0.01, pathOptimizationRange);

    // Adjust ray length.
    const delta = vec3.subtract(_optimizePathVisibility_delta, goal, corridor.position);
    vec3.scaleAndAdd(goal, corridor.position, delta, pathOptimizationRange / dist);

    const result = raycast(navMesh, corridor.path[0], corridor.position, goal, filter);
    
    if (result.path.length > 1 && result.t > 0.99) {
        corridor.path = mergeStartShortcut(corridor.path, result.path);
    }
};
