import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import {
    findStraightPath,
    getNodeByRef,
    isValidNodeRef,
    moveAlongSurface,
    type NavMesh,
    type NodeRef,
    NodeType,
    type QueryFilter,
    type StraightPathPoint,
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
    // check all nodes are still valid and pass query filter
    const n = Math.min(corridor.path.length, maxLookAhead);

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
        corridor.path[1] = 0;
        corridor.path.length = 3;
    } else {
        corridor.path[0] = safeRef;
        corridor.path[1] = 0;
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

    // update corridor position to the end position
    vec3.copy(corridor.position, endPosition);

    return { 
        startPosition: onStart ? offMeshConnection.start : offMeshConnection.end,
        endPosition, 
        endNodeRef, 
        prevNodeRef, 
        offMeshNodeRef, 
    };
};
