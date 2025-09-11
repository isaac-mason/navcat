import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import { FindStraightPathFlags, findStraightPath, type StraightPathPoint } from './find-straight-path';
import type { NavMesh } from './nav-mesh';
import { createFindNearestPolyResult, findNearestPoly } from './nav-mesh-api';
import { FindNodePathFlags, type FindNodePathResult, findNodePath } from './nav-mesh-search';
import type { NodeRef } from './node';
import type { QueryFilter } from './query-filter';

export enum FindPathFlags {
    NONE = 0,
    SUCCESS = 1 << 0,
    COMPLETE_PATH = 1 << 1,
    PARTIAL_PATH = 1 << 2,
    MAX_POINTS_REACHED = 1 << 3,
    INVALID_INPUT = 1 << 4,
    FIND_NODE_PATH_FAILED = 1 << 5,
    FIND_STRAIGHT_PATH_FAILED = 1 << 6,
}

export type FindPathResult = {
    /** whether the search completed successfully, with either a partial or complete path */
    success: boolean;

    /** the status flags of the pathfinding operation */
    flags: FindPathFlags;

    /** the path, consisting of polygon node and offmesh link node references */
    path: StraightPathPoint[];

    /** the status flags of the straight pathfinding operation */
    straightPathFlags: FindStraightPathFlags;

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

    /** the status flags of the node pathfinding operation */
    nodePathFlags: FindNodePathFlags;
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
        flags: FindPathFlags.NONE | FindPathFlags.INVALID_INPUT,
        nodePathFlags: FindNodePathFlags.NONE,
        straightPathFlags: FindStraightPathFlags.NONE,
        path: [],
        startNodeRef: null,
        startPoint: [0, 0, 0],
        endNodeRef: null,
        endPoint: [0, 0, 0],
        nodePath: null,
    };

    /* find start nearest poly */
    const startNearestPolyResult = findNearestPoly(_findPathStartNearestPolyResult, navMesh, start, halfExtents, queryFilter);
    if (!startNearestPolyResult.success) return result;

    vec3.copy(result.startPoint, startNearestPolyResult.nearestPoint);
    result.startNodeRef = startNearestPolyResult.nearestPolyRef;

    /* find end nearest poly */
    const endNearestPolyResult = findNearestPoly(_findPathEndNearestPolyResult, navMesh, end, halfExtents, queryFilter);
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
    result.nodePathFlags = nodePath.flags;

    if (!nodePath.success) {
        result.flags = FindPathFlags.FIND_NODE_PATH_FAILED;
        return result;
    }

    /* find straight path */
    const straightPath = findStraightPath(navMesh, result.startPoint, result.endPoint, nodePath.path);

    if (!straightPath.success) {
        result.flags = FindPathFlags.FIND_STRAIGHT_PATH_FAILED;
        return result;
    }

    result.success = true;
    result.path = straightPath.path;
    result.straightPathFlags = straightPath.flags;

    let flags = FindPathFlags.SUCCESS;
    if ((nodePath.flags & FindNodePathFlags.COMPLETE_PATH) && (straightPath.flags & FindStraightPathFlags.COMPLETE_PATH)) {
        flags |= FindPathFlags.COMPLETE_PATH;
    } else {
        flags |= FindPathFlags.PARTIAL_PATH;
    }
    if (straightPath.flags & FindStraightPathFlags.MAX_POINTS_REACHED) {
        flags |= FindPathFlags.MAX_POINTS_REACHED;
    }

    result.flags = flags;

    return result;
};
