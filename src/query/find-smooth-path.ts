import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import { FindStraightPathFlags, findStraightPath, type StraightPathPoint } from './find-straight-path';
import { type NavMesh, OffMeshConnectionSide } from './nav-mesh';
import { createFindNearestPolyResult, findNearestPoly } from './nav-mesh-api';
import { FindNodePathFlags, type FindNodePathResult, findNodePath, moveAlongSurface } from './nav-mesh-search';
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

export type FindSmoothPathResult = {
    /** whether the search completed successfully */
    success: boolean;

    /** the status flags of the smooth pathfinding operation */
    flags: FindSmoothPathFlags;

    /** the smooth path points */
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
    const polys = [...nodePath.path];
    const smoothPath: StraightPathPoint[] = [];

    smoothPath.push({
        position: vec3.clone(iterPos),
        type: NodeType.GROUND_POLY,
        nodeRef: result.startNodeRef,
    });

    while (polys.length > 0 && smoothPath.length < maxPoints) {
        // find location to steer towards
        const steerTarget = getSteerTarget(navMesh, iterPos, targetPos, slop, polys);

        if (!steerTarget.success) {
            break;
        }

        const isEndOfPath = steerTarget.end;
        const isOffMeshConnection = steerTarget.offMeshStart;

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

        fixupCorridor(polys, moveAlongSurfaceResult.visited);
        fixupShortcuts(polys, navMesh);

        vec3.copy(iterPos, resultPosition);

        // handle end of path and off-mesh links when close enough
        if (isEndOfPath && inRange(iterPos, steerTarget.steerPos, slop, 1.0)) {
            // reached end of path
            vec3.copy(iterPos, targetPos);

            if (smoothPath.length < maxPoints) {
                smoothPath.push({
                    position: vec3.clone(iterPos),
                    type: NodeType.GROUND_POLY,
                    nodeRef: result.endNodeRef,
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
            smoothPath.push({
                position: vec3.clone(iterPos),
                type: NodeType.GROUND_POLY,
                nodeRef: currentNodeRef,
            });
        }
    }

    // compose flags
    let flags = FindSmoothPathFlags.SUCCESS
    if (nodePath.flags & FindNodePathFlags.COMPLETE_PATH) {
        flags |= FindSmoothPathFlags.COMPLETE_PATH;
    } else if (nodePath.flags & FindNodePathFlags.PARTIAL_PATH) {
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
    offMeshStart: boolean;
    end: boolean;
    steerPosRef: NodeRef;
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
        offMeshStart: false,
        end: false,
        steerPosRef: '' as NodeRef,
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
            result.offMeshStart = true;
            break;
        }

        // if the point is the end, we should steer to it regardless of minTargetDist
        // console.log("is complete path?", straightPath.flags & FindStraightPathFlags.COMPLETE_PATH);
        // console.log("partial path?", straightPath.flags & FindStraightPathFlags.PARTIAL_PATH);

        if ((straightPath.flags & FindStraightPathFlags.COMPLETE_PATH) !== 0 && ns === straightPath.path.length - 1) {
            result.end = true;
            // console.debug('[getSteerTarget] END at', ns, point);
            break;
        }

        // if this point is far enough from start, we can steer to it
        if (!inRange(point.position, start, minTargetDist, 1000.0)) {
            // console.debug('[getSteerTarget] Far enough at', ns, point, 'start:', start, 'minTargetDist:', minTargetDist);
            break;
        } else {
            // console.debug('[getSteerTarget] In range at', ns, point, 'start:', start, 'minTargetDist:', minTargetDist);
        }

        ns++;
    }

    // failed to find good point to steer to
    if (ns >= straightPath.path.length) {
        // console.debug('[getSteerTarget] Failed to find steer target');
        return result;
    }

    const steerPoint = straightPath.path[ns];
    // console.debug('[getSteerTarget] Selected steer point', ns, steerPoint);

    vec3.copy(result.steerPos, steerPoint.position);
    result.steerPosRef = steerPoint.nodeRef || ('' as NodeRef);
    result.success = true;

    return result;
};

const inRange = (a: Vec3, b: Vec3, r: number, h: number): boolean => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    return dx * dx + dz * dz < r * r && Math.abs(dy) < h;
};

const fixupCorridor = (pathPolys: NodeRef[], visitedPolyRefs: NodeRef[]): void => {
    const maxPath = 256; // reasonable limit
    let furthestPath = -1;
    let furthestVisited = -1;

    // find furthest common polygon.
    for (let i = pathPolys.length - 1; i >= 0; i--) {
        let found = false;
        for (let j = visitedPolyRefs.length - 1; j >= 0; j--) {
            if (pathPolys[i] === visitedPolyRefs[j]) {
                furthestPath = i;
                furthestVisited = j;
                found = true;
            }
        }
        if (found) {
            break;
        }
    }

    // if no intersection found just return current path.
    if (furthestPath === -1 || furthestVisited === -1) {
        return;
    }

    // concatenate paths.
    // adjust beginning of the buffer to include the visited.
    const req = visitedPolyRefs.length - furthestVisited;
    const orig = Math.min(furthestPath + 1, pathPolys.length);

    let size = Math.max(0, pathPolys.length - orig);

    if (req + size > maxPath) {
        size = maxPath - req;
    }
    if (size) {
        pathPolys.splice(req, size, ...pathPolys.slice(orig, orig + size));
    }

    // store visited
    for (let i = 0; i < req; i++) {
        pathPolys[i] = visitedPolyRefs[visitedPolyRefs.length - (1 + i)];
    }
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
