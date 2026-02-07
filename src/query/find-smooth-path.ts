import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import { findStraightPath, StraightPathPointFlags } from './find-straight-path';
import type { NavMesh } from './nav-mesh';
import type { QueryFilter } from './nav-mesh-api';
import { createFindNearestPolyResult, findNearestPoly, getNodeByRef } from './nav-mesh-api';
import { type FindNodePathResult, FindNodePathResultFlags, findNodePath, moveAlongSurface } from './nav-mesh-search';
import { INVALID_NODE_REF, type NodeRef, NodeType } from './node';

const _findSmoothPath_delta = vec3.create();
const _findSmoothPath_moveTarget = vec3.create();
const _findSmoothPath_startNearestPolyResult = createFindNearestPolyResult();
const _findSmoothPath_endNearestPolyResult = createFindNearestPolyResult();

export enum FindSmoothPathResultFlags {
    NONE = 0,
    SUCCESS = 1 << 0,
    COMPLETE_PATH = 1 << 1,
    PARTIAL_PATH = 1 << 2,
    INVALID_INPUT = 1 << 3,
    FIND_NODE_PATH_FAILED = 1 << 4,
    FIND_STRAIGHT_PATH_FAILED = 1 << 5,
}

export enum SmoothPathPointFlags {
    START = 0,
    END = 1,
    OFFMESH = 2,
}

export type SmoothPathPoint = {
    position: Vec3;
    type: NodeType;
    nodeRef: NodeRef | null;
    /** @see SmoothPathPointFlags */
    flags: number;
};

export type FindSmoothPathResult = {
    /** whether the search completed successfully */
    success: boolean;

    /** the status flags of the smooth pathfinding operation */
    flags: FindSmoothPathResultFlags;

    /** the path points */
    path: SmoothPathPoint[];

    /** the start poly node ref */
    startNodeRef: NodeRef | null;

    /** the start closest point */
    startPosition: Vec3;

    /** the end poly node ref */
    endNodeRef: NodeRef | null;

    /** the end closest point */
    endPosition: Vec3;

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
 * @param stepSize The step size for movement along the surface
 * @param slop The distance tolerance for reaching waypoints
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
        flags: FindSmoothPathResultFlags.NONE | FindSmoothPathResultFlags.INVALID_INPUT,
        path: [],
        startNodeRef: null,
        startPosition: [0, 0, 0],
        endNodeRef: null,
        endPosition: [0, 0, 0],
        nodePath: null,
    };

    /* find start nearest poly */
    const startNearestPolyResult = findNearestPoly(
        _findSmoothPath_startNearestPolyResult,
        navMesh,
        start,
        halfExtents,
        queryFilter,
    );
    if (!startNearestPolyResult.success) return result;

    vec3.copy(result.startPosition, startNearestPolyResult.position);
    result.startNodeRef = startNearestPolyResult.nodeRef;

    /* find end nearest poly */
    const endNearestPolyResult = findNearestPoly(_findSmoothPath_endNearestPolyResult, navMesh, end, halfExtents, queryFilter);
    if (!endNearestPolyResult.success) return result;

    vec3.copy(result.endPosition, endNearestPolyResult.position);
    result.endNodeRef = endNearestPolyResult.nodeRef;

    /* find node path */
    const nodePath = findNodePath(
        navMesh,
        result.startNodeRef,
        result.endNodeRef,
        result.startPosition,
        result.endPosition,
        queryFilter,
    );

    result.nodePath = nodePath;

    if (!nodePath.success || nodePath.path.length === 0) {
        result.flags = FindSmoothPathResultFlags.FIND_NODE_PATH_FAILED;
        return result;
    }

    // iterate over the path to find a smooth path
    const iterPos = vec3.clone(result.startPosition);
    const targetPos = vec3.clone(result.endPosition);

    let polys = [...nodePath.path];

    result.path.push({
        position: vec3.clone(iterPos),
        type: NodeType.POLY,
        nodeRef: result.startNodeRef,
        flags: SmoothPathPointFlags.START,
    });

    while (polys.length > 0 && result.path.length < maxPoints) {
        // find location to steer towards
        const steerTarget = getSteerTarget(navMesh, iterPos, targetPos, slop, polys);

        if (!steerTarget.success) {
            break;
        }

        const isEndOfPath = steerTarget.steerPosFlags & StraightPathPointFlags.END;
        const isOffMeshConnection = steerTarget.steerPosFlags & StraightPathPointFlags.OFFMESH;

        // find movement delta
        const steerPos = steerTarget.steerPos;
        const delta = vec3.subtract(_findSmoothPath_delta, steerPos, iterPos);

        let len = vec3.length(delta);

        // always move to the steer target, but limit each step to stepSize
        len = Math.min(stepSize, len) / len;

        const moveTarget = vec3.scaleAndAdd(_findSmoothPath_moveTarget, iterPos, delta, len);

        // move along surface
        const moveAlongSurfaceResult = moveAlongSurface(navMesh, polys[0], iterPos, moveTarget, queryFilter);

        if (!moveAlongSurfaceResult.success) {
            break;
        }

        const resultPosition = moveAlongSurfaceResult.position;

        polys = mergeCorridorStartMoved(polys, moveAlongSurfaceResult.visited, 256);
        fixupShortcuts(polys, navMesh);

        vec3.copy(iterPos, resultPosition);

        // handle end of path and off-mesh links when close enough
        if (isEndOfPath && inRange(iterPos, steerTarget.steerPos, slop, 1.0)) {
            // reached end of path
            vec3.copy(iterPos, targetPos);

            if (result.path.length < maxPoints) {
                result.path.push({
                    position: vec3.clone(iterPos),
                    type: NodeType.POLY,
                    nodeRef: result.endNodeRef,
                    flags: SmoothPathPointFlags.END,
                });
            }

            break;
        } else if (isOffMeshConnection && inRange(iterPos, steerTarget.steerPos, slop, 1.0)) {
            // reached off-mesh connection
            const offMeshConRef = steerTarget.steerPosRef;

            // advance the path up to and over the off-mesh connection
            let prevNodeRef: NodeRef | null = null;
            let nodeRef: NodeRef = polys[0];
            let npos = 0;

            while (npos < polys.length && nodeRef !== offMeshConRef) {
                prevNodeRef = nodeRef;
                nodeRef = polys[npos];
                npos++;
            }

            // remove processed polys
            polys.splice(0, npos);

            // handle the off-mesh connection
            const offMeshNode = getNodeByRef(navMesh, offMeshConRef);
            const offMeshConnection = navMesh.offMeshConnections[offMeshNode.offMeshConnectionId];

            if (offMeshConnection && prevNodeRef !== null) {
                // find the link from the previous poly to the off-mesh node to determine direction
                const prevNode = getNodeByRef(navMesh, prevNodeRef);
                let linkEdge = 0; // default to START

                for (const linkIndex of prevNode.links) {
                    const link = navMesh.links[linkIndex];
                    if (link.toNodeRef === offMeshConRef) {
                        linkEdge = link.edge;
                        break;
                    }
                }

                // use the link edge to determine direction
                // edge 0 = entering from START side, edge 1 = entering from END side
                const enteringFromStart = linkEdge === 0;

                if (result.path.length < maxPoints) {
                    result.path.push({
                        position: vec3.clone(iterPos),
                        type: NodeType.OFFMESH,
                        nodeRef: offMeshConRef,
                        flags: SmoothPathPointFlags.OFFMESH,
                    });

                    const endPosition = enteringFromStart ? offMeshConnection.end : offMeshConnection.start;

                    vec3.copy(iterPos, endPosition);
                }
            }
        }

        // store results - add a point for each iteration to create smooth path
        if (result.path.length < maxPoints) {
            // determine the current ref from the current position
            const currentNodeRef = polys.length > 0 ? polys[0] : result.endNodeRef;

            result.path.push({
                position: vec3.clone(iterPos),
                type: NodeType.POLY,
                nodeRef: currentNodeRef,
                flags: 0,
            });
        }
    }

    // compose flags
    let flags = FindSmoothPathResultFlags.SUCCESS;
    if (nodePath.flags & FindNodePathResultFlags.COMPLETE_PATH) {
        flags |= FindSmoothPathResultFlags.COMPLETE_PATH;
    } else if (nodePath.flags & FindNodePathResultFlags.PARTIAL_PATH) {
        flags |= FindSmoothPathResultFlags.PARTIAL_PATH;
    }

    result.success = true;
    result.flags = flags;

    return result;
};

type GetSteerTargetResult = {
    success: boolean;
    steerPos: Vec3;
    steerPosRef: NodeRef;
    steerPosFlags: FindSmoothPathResultFlags;
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
        steerPosRef: INVALID_NODE_REF,
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
        if (point.type === NodeType.OFFMESH) {
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
    result.steerPosRef = steerPoint.nodeRef ?? INVALID_NODE_REF;
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

    const firstNode = getNodeByRef(navMesh, pathPolys[0]);

    for (const linkIndex of firstNode.links) {
        const link = navMesh.links[linkIndex];
        if (link && nneis < maxNeis) {
            neis.push(link.toNodeRef);
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
