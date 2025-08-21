import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import { findStraightPath, moveAlongSurface, type NavMesh, type NodeRef, type QueryFilter } from 'nav3d';

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
        // update corridor path using the visited polygons (like Detour does)
        corridor.path = mergeCorridorStartMoved(corridor.path, result.visited, corridor.maxPath);

        // update corridor position
        vec3.copy(corridor.position, result.resultPosition);
        return true;
    }
    return false;
};

// prune points in the beginning of the path which are too close
const MIN_TARGET_DIST = 0.01;

export const findCorridorCorners = (corridor: PathCorridor, navMesh: NavMesh, maxCorners: number): Vec3[] => {
    if (corridor.path.length === 0) return [];

    const straightPathResult = findStraightPath(navMesh, corridor.position, corridor.target, corridor.path, maxCorners);

    if (!straightPathResult.success || straightPathResult.path.length === 0) {
        return [];
    }

    // get initial corners from findStraightPath
    let corners = straightPathResult.path.map((p) => p.position);

    while (corners.length > 0) {
        const firstCorner = corners[0];
        const distance = vec3.distance(corridor.position, firstCorner);

        // if the first corner is far enough, we're done pruning
        if (distance > MIN_TARGET_DIST) {
            break;
        }

        // remove the first corner as it's too close
        corners = corners.slice(1);
    }

    return corners;
};
