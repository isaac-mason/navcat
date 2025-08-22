import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import {
    desNodeRef,
    FindStraightPathStatus,
    findStraightPath,
    getNodeRefType,
    isValidNodeRef,
    moveAlongSurface,
    type NavMesh,
    type NodeRef,
    NodeType,
    type QueryFilter,
    type StraightPathPoint,
} from 'nav3d';

export type PathCorridor = {
    position: Vec3;
    target: Vec3;
    path: NodeRef[];
    maxPath: number;
};

export const createPathCorridor = (maxPath: number): PathCorridor => ({
    position: [0, 0, 0],
    target: [0, 0, 0],
    path: [],
    maxPath,
});

export const resetCorridor = (corridor: PathCorridor, ref: NodeRef, position: Vec3): void => {
    vec3.copy(corridor.position, position);
    vec3.copy(corridor.target, position);
    corridor.path = [ref];
};

export const setCorridorPath = (corridor: PathCorridor, target: Vec3, path: NodeRef[]): void => {
    vec3.copy(corridor.target, target);
    corridor.path = path.slice(0, corridor.maxPath);
};

export const mergeCorridorStartMoved = (currentPath: NodeRef[], visited: NodeRef[], maxPath: number): NodeRef[] => {
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
    let size = Math.max(0, currentPath.length - orig);

    if (req + size > maxPath) {
        size = maxPath - req;
    }

    const newPath: NodeRef[] = [];

    // store visited polygons (in reverse order)
    for (let i = 0; i < Math.min(req, maxPath); i++) {
        newPath[i] = visited[visited.length - 1 - i];
    }

    // add remaining current path
    if (size > 0) {
        for (let i = 0; i < size; i++) {
            newPath[req + i] = currentPath[orig + i];
        }
    }

    return newPath.slice(0, req + size);
};

export const corridorMovePosition = (corridor: PathCorridor, newPos: Vec3, navMesh: NavMesh, filter: QueryFilter): boolean => {
    if (corridor.path.length === 0) return false;

    const result = moveAlongSurface(navMesh, corridor.path[0], corridor.position, newPos, filter);

    if (result.success) {
        corridor.path = mergeCorridorStartMoved(corridor.path, result.visited, corridor.maxPath);
        vec3.copy(corridor.position, result.resultPosition);
        return true;
    }

    return false;
};

const MIN_TARGET_DIST = 0.01;

export const findCorridorCorners = (
    corridor: PathCorridor,
    navMesh: NavMesh,
    maxCorners: number,
): false | { corners: StraightPathPoint[]; cornersReachTarget: boolean } => {
    if (corridor.path.length === 0) return false;

    const straightPathResult = findStraightPath(navMesh, corridor.position, corridor.target, corridor.path, maxCorners);

    if (!straightPathResult.success || straightPathResult.path.length === 0) {
        return false;
    }

    let corners = straightPathResult.path;
    let cornersReachTarget = straightPathResult.status === FindStraightPathStatus.COMPLETE_PATH;

    // prune points in the beginning of the path which are too close
    while (corners.length > 0) {
        const firstCorner = corners[0];
        const distance = vec3.distance(corridor.position, firstCorner.position);

        // if the first corner is far enough, we're done pruning
        if (distance > MIN_TARGET_DIST) {
            break;
        }

        // remove the first corner as it's too close
        corners = corners.slice(1);
    }

    // prune points after an offmesh connection
    let firstOffMeshConnectionIndex = -1;

    for (let i = 0; i < corners.length; i++) {
        if (corners[i].type === NodeType.OFFMESH_CONNECTION) {
            firstOffMeshConnectionIndex = i;
            break;
        }
    }

    if (firstOffMeshConnectionIndex !== -1) {
        corners = corners.slice(0, firstOffMeshConnectionIndex + 1);
        cornersReachTarget = false;
    }

    return { corners, cornersReachTarget };
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
        corridor.path[2] = corridor.path[corridor.path.length - 1];
        corridor.path[0] = safeRef;
        corridor.path[1] = '' as NodeRef;
        corridor.path.length = 3;
    } else {
        corridor.path[0] = safeRef;
        corridor.path[1] = '' as NodeRef;
    }

    return true;
};

// bool dtPathCorridor::moveOverOffmeshConnection(dtPolyRef offMeshConRef, dtPolyRef* refs,
// 											   float* startPos, float* endPos,
// 											   dtNavMeshQuery* navquery)
// {
// 	dtAssert(navquery);
// 	dtAssert(m_path);
// 	dtAssert(m_npath);

// 	// Advance the path up to and over the off-mesh connection.
// 	dtPolyRef prevRef = 0, polyRef = m_path[0];
// 	int npos = 0;
// 	while (npos < m_npath && polyRef != offMeshConRef)
// 	{
// 		prevRef = polyRef;
// 		polyRef = m_path[npos];
// 		npos++;
// 	}
// 	if (npos == m_npath)
// 	{
// 		// Could not find offMeshConRef
// 		return false;
// 	}

// 	// Prune path
// 	for (int i = npos; i < m_npath; ++i)
// 		m_path[i-npos] = m_path[i];
// 	m_npath -= npos;

// 	refs[0] = prevRef;
// 	refs[1] = polyRef;

// 	const dtNavMesh* nav = navquery->getAttachedNavMesh();
// 	dtAssert(nav);

// 	dtStatus status = nav->getOffMeshConnectionPolyEndPoints(refs[0], refs[1], startPos, endPos);
// 	if (dtStatusSucceed(status))
// 	{
// 		dtVcopy(m_pos, endPos);
// 		return true;
// 	}

// 	return false;
// }

export const moveOverOffMeshConnection = (corridor: PathCorridor, navMesh: NavMesh) => {
    if (corridor.path.length === 0) return false;

    // check the current node in the corridor is an off mesh link
    if (getNodeRefType(corridor.path[0]) !== NodeType.OFFMESH_CONNECTION) return false;

    const [, offMeshConnectionId] = desNodeRef(corridor.path[0]);

    // get the off mesh connection
    const offMeshConnection = navMesh.offMeshConnections[offMeshConnectionId];
    const offMeshConnectionState = navMesh.offMeshConnectionStates[offMeshConnectionId];

    if (!offMeshConnection || !offMeshConnectionState) return false;

    const onStart = offMeshConnectionState.startPolyRef === corridor.path[0];

    const endNodeRef = onStart ? offMeshConnectionState.endPolyRef : offMeshConnectionState.startPolyRef;
    const endPosition = onStart ? offMeshConnection.end : offMeshConnection.start;

    vec3.copy(corridor.position, endPosition);

    return { endPosition, endNodeRef };
};
