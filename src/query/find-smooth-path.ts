import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import { StraightPathPointFlags, findStraightPath } from './find-straight-path';
import { type NavMesh, OffMeshConnectionSide } from './nav-mesh';
import { createFindNearestPolyResult, findNearestPoly } from './nav-mesh-api';
import { FindNodePathResultFlags, type FindNodePathResult, findNodePath, moveAlongSurface } from './nav-mesh-search';
import { desNodeRef, type NodeRef, NodeType } from './node';
import type { QueryFilter } from './query-filter';

const _findSmoothPathDelta = vec3.create();
const _findSmoothPathMoveTarget = vec3.create();
const _findSmoothPathStartNearestPolyResult = createFindNearestPolyResult();
const _findSmoothPathEndNearestPolyResult = createFindNearestPolyResult();

export enum FindSmoothPathFlags {
    NONE = 0,
    SUCCESS = 1 << 0,
    COMPLETE_PATH = 1 << 1,
    PARTIAL_PATH = 1 << 2,
    INVALID_INPUT = 1 << 3,
    FIND_NODE_PATH_FAILED = 1 << 4,
    FIND_STRAIGHT_PATH_FAILED = 1 << 5,
}

export enum SmoothPathPointType {
    START = 0,
    MOVE_ALONG_SURFACE = 1,
    OFFMESH_CONNECTION = 2,
    END = 3,
}

export type SmoothPathPoint = {
    position: Vec3;
    type: NodeType;
    nodeRef: NodeRef;
    pointType: SmoothPathPointType;
    steerTarget: Vec3 | null;
    moveAlongSurfaceTarget: Vec3 | null;
};

export type FindSmoothPathResult = {
    /** whether the search completed successfully */
    success: boolean;

    /** the status flags of the smooth pathfinding operation */
    flags: FindSmoothPathFlags;

    /** the smooth path points */
    path: SmoothPathPoint[];

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

/**
 * Find a smooth path between two positions on a NavMesh.
 *
 * This method computes a smooth path by iteratively moving along the navigation
 * mesh surface using the polygon path found between start and end positions.
 * The resulting path follows the surface more naturally than a straight path.
 *
 * If the end node cannot be reached through the navigation graph,
 * the path will go as far as possible toward the target.
 *
 * Internally:
 * - finds the closest poly for the start and end positions with @see findNearestPoly
 * - finds a nav mesh node path with @see findNodePath
 * - computes a smooth path by iteratively moving along the surface with @see moveAlongSurface
 *
 * @param navMesh The navigation mesh.
 * @param start The starting position in world space.
 * @param end The ending position in world space.
 * @param halfExtents The half extents for nearest polygon queries.
 * @param queryFilter The query filter.
 * @param stepSize The step size for movement along the surface (default: 0.5).
 * @param slop The distance tolerance for reaching waypoints (default: 0.01).
 * @returns The result of the smooth pathfinding operation, with path points containing position, type, and nodeRef information.
 */

export const findSmoothPath = (
    navMesh: NavMesh,
    start: Vec3,
    end: Vec3,
    halfExtents: Vec3,
    queryFilter: QueryFilter,
    stepSize: number,
    slop: number,
    maxPoints: number,
): FindSmoothPathResult => {
    const result: FindSmoothPathResult = {
        success: false,
        flags: FindSmoothPathFlags.NONE | FindSmoothPathFlags.INVALID_INPUT,
        path: [],
        startNodeRef: null,
        startPoint: [0, 0, 0],
        endNodeRef: null,
        endPoint: [0, 0, 0],
        nodePath: null,
    };

    /* find start nearest poly */
    const startNearestPolyResult = findNearestPoly(
        _findSmoothPathStartNearestPolyResult,
        navMesh,
        start,
        halfExtents,
        queryFilter,
    );
    if (!startNearestPolyResult.success) return result;

    vec3.copy(result.startPoint, startNearestPolyResult.nearestPoint);
    result.startNodeRef = startNearestPolyResult.nearestPolyRef;

    /* find end nearest poly */
    const endNearestPolyResult = findNearestPoly(_findSmoothPathEndNearestPolyResult, navMesh, end, halfExtents, queryFilter);
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

    if (!nodePath.success || nodePath.path.length === 0) {
        result.flags = FindSmoothPathFlags.FIND_NODE_PATH_FAILED;
        return result;
    }

    // iterate over the path to find a smooth path
    const iterPos = vec3.clone(result.startPoint);
    const targetPos = vec3.clone(result.endPoint);

    let polys = [...nodePath.path];

    const smoothPath: SmoothPathPoint[] = [];

    smoothPath.push({
        position: vec3.clone(iterPos),
        type: NodeType.GROUND_POLY,
        nodeRef: result.startNodeRef,
        pointType: SmoothPathPointType.START,
        steerTarget: null,
        moveAlongSurfaceTarget: null,
    });

    while (polys.length > 0 && smoothPath.length < maxPoints) {
        // find location to steer towards
        const steerTarget = getSteerTarget(navMesh, iterPos, targetPos, slop, polys);

        if (!steerTarget.success) {
            break;
        }

        const isEndOfPath = steerTarget.steerPosFlags & StraightPathPointFlags.END;
        const isOffMeshConnection = steerTarget.steerPosFlags & StraightPathPointFlags.OFFMESH_CONNECTION;

        smoothPath[smoothPath.length - 1].steerTarget = vec3.clone(steerTarget.steerPos);

        // find movement delta
        const steerPos = steerTarget.steerPos;
        const delta = vec3.subtract(_findSmoothPathDelta, steerPos, iterPos);

        let len = vec3.length(delta);

        // if the steer target is the end of the path or an off-mesh connection, do not move past the location
        if ((isEndOfPath || isOffMeshConnection) && len < stepSize) {
            len = 1;
        } else {
            len = stepSize / len;
        }

        const moveTarget = vec3.scaleAndAdd(_findSmoothPathMoveTarget, iterPos, delta, len);

        // move along surface
        const moveAlongSurfaceResult = moveAlongSurface(navMesh, polys[0], iterPos, moveTarget, queryFilter);

        if (!moveAlongSurfaceResult.success) {
            break;
        }

        const resultPosition = moveAlongSurfaceResult.resultPosition;

        polys = mergeCorridorStartMoved(polys, moveAlongSurfaceResult.visited, 256);
        // fixupCorridor(polys, moveAlongSurfaceResult.visited);
        fixupShortcuts(polys, navMesh);

        vec3.copy(iterPos, resultPosition);

        // handle end of path and off-mesh links when close enough
        if (isEndOfPath && inRange(iterPos, steerTarget.steerPos, slop, 1.0)) {
            // reached end of path
            vec3.copy(iterPos, targetPos);

            smoothPath[smoothPath.length - 1].moveAlongSurfaceTarget = vec3.clone(moveTarget);

            if (smoothPath.length < maxPoints) {
                smoothPath.push({
                    position: vec3.clone(iterPos),
                    type: NodeType.GROUND_POLY,
                    nodeRef: result.endNodeRef,
                    pointType: SmoothPathPointType.END,
                    steerTarget: null,
                    moveAlongSurfaceTarget: null,
                });
            }

            break;
        } else if (isOffMeshConnection && inRange(iterPos, steerTarget.steerPos, slop, 1.0)) {
            // reached off-mesh connection
            const offMeshConRef = steerTarget.steerPosRef;

            // advance the path up to and over the off-mesh connection
            let polyRef: NodeRef = polys[0];
            let npos = 0;

            while (npos < polys.length && polyRef !== offMeshConRef) {
                polyRef = polys[npos];
                npos++;
            }

            // remove processed polys
            polys.splice(0, npos);

            // handle the off-mesh connection
            const [, offMeshConnectionId, offMeshConnectionSide] = desNodeRef(offMeshConRef);
            const offMeshConnection = navMesh.offMeshConnections[offMeshConnectionId];

            if (offMeshConnection) {
                if (smoothPath.length < maxPoints) {
                    smoothPath.push({
                        position: vec3.clone(iterPos),
                        type: NodeType.OFFMESH_CONNECTION,
                        nodeRef: offMeshConRef,
                        pointType: SmoothPathPointType.OFFMESH_CONNECTION,
                        steerTarget: null,
                        moveAlongSurfaceTarget: null,
                    });

                    const endPosition =
                        offMeshConnectionSide === OffMeshConnectionSide.START ? offMeshConnection.end : offMeshConnection.start;

                    vec3.copy(iterPos, endPosition);
                }
            }
        }

        // store results - add a point for each iteration to create smooth path
        if (smoothPath.length < maxPoints) {
            // determine the current ref from the current position
            const currentNodeRef = polys.length > 0 ? polys[0] : result.endNodeRef;

            smoothPath[smoothPath.length - 1].moveAlongSurfaceTarget = vec3.clone(moveTarget);

            smoothPath.push({
                position: vec3.clone(iterPos),
                type: NodeType.GROUND_POLY,
                nodeRef: currentNodeRef,
                pointType: SmoothPathPointType.MOVE_ALONG_SURFACE,
                steerTarget: null,
                moveAlongSurfaceTarget: null,
            });
        }
    }

    // compose flags
    let flags = FindSmoothPathFlags.SUCCESS;
    if (nodePath.flags & FindNodePathResultFlags.COMPLETE_PATH) {
        flags |= FindSmoothPathFlags.COMPLETE_PATH;
    } else if (nodePath.flags & FindNodePathResultFlags.PARTIAL_PATH) {
        flags |= FindSmoothPathFlags.PARTIAL_PATH;
    }

    result.success = true;
    result.path = smoothPath;
    result.flags = flags;

    return result;
};

type GetSteerTargetResult = {
    success: boolean;
    steerPos: Vec3;
    steerPosRef: NodeRef;
    steerPosFlags: FindSmoothPathFlags;
};

const getSteerTarget = (
    navMesh: NavMesh,
    start: Vec3,
    end: Vec3,
    minTargetDist: number,
    pathPolys: NodeRef[],
): GetSteerTargetResult => {
    const result: GetSteerTargetResult = {
        success: false,
        steerPos: [0, 0, 0],
        steerPosRef: '' as NodeRef,
        steerPosFlags: 0,
    };

    const maxStraightPathPoints = 3;
    const straightPath = findStraightPath(navMesh, start, end, pathPolys, maxStraightPathPoints, 0);

    if (!straightPath.success || straightPath.path.length === 0) {
        return result;
    }

    // find vertex far enough to steer to
    let ns = 0;
    while (ns < straightPath.path.length) {
        const point = straightPath.path[ns];

        // stop at off-mesh link
        if (point.type === NodeType.OFFMESH_CONNECTION) {
            break;
        }

        // if this point is far enough from start, we can steer to it
        if (!inRange(point.position, start, minTargetDist, 1000.0)) {
            break;
        }

        ns++;
    }

    // failed to find good point to steer to
    if (ns >= straightPath.path.length) {
        return result;
    }

    const steerPoint = straightPath.path[ns];

    vec3.copy(result.steerPos, steerPoint.position);
    result.steerPosRef = steerPoint.nodeRef || ('' as NodeRef);
    result.steerPosFlags = steerPoint.flags;
    result.success = true;

    return result;
};

const inRange = (a: Vec3, b: Vec3, r: number, h: number): boolean => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    return dx * dx + dz * dz < r * r && Math.abs(dy) < h;
};

const mergeCorridorStartMoved = (currentPath: NodeRef[], visited: NodeRef[], maxPath: number): NodeRef[] => {
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

/**
 * This function checks if the path has a small U-turn, that is,
 * a polygon further in the path is adjacent to the first polygon
 * in the path. If that happens, a shortcut is taken.
 * This can happen if the target (T) location is at tile boundary,
 * and we're approaching it parallel to the tile edge.
 * The choice at the vertex can be arbitrary,
 *  +---+---+
 *  |:::|:::|
 *  +-S-+-T-+
 *  |:::|   | <-- the step can end up in here, resulting U-turn path.
 *  +---+---+
 */
const fixupShortcuts = (pathPolys: NodeRef[], navMesh: NavMesh): void => {
    if (pathPolys.length < 3) {
        return;
    }

    // Get connected polygons
    const maxNeis = 16;
    let nneis = 0;
    const neis: NodeRef[] = [];

    const firstPolyLinks = navMesh.nodes[pathPolys[0]];
    if (!firstPolyLinks) return;

    for (const linkIndex of firstPolyLinks) {
        const link = navMesh.links[linkIndex];
        if (link?.neighbourRef && nneis < maxNeis) {
            neis.push(link.neighbourRef);
            nneis++;
        }
    }

    // If any of the neighbour polygons is within the next few polygons
    // in the path, short cut to that polygon directly.
    const maxLookAhead = 6;
    let cut = 0;
    for (let i = Math.min(maxLookAhead, pathPolys.length) - 1; i > 1 && cut === 0; i--) {
        for (let j = 0; j < nneis; j++) {
            if (pathPolys[i] === neis[j]) {
                cut = i;
                break;
            }
        }
    }

    if (cut > 1) {
        pathPolys.splice(1, cut - 1);
    }
};
