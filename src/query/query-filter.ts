import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import type { NavMesh } from './nav-mesh';
import { desNodeRef, getNodeRefType, type NodeRef, NodeType } from './node';

export type QueryFilter = {
    /**
     * Flags that nodes must include to be considered.
     */
    includeFlags: number;

    /**
     * Flags that nodes must not include to be considered.
     */
    excludeFlags: number;

    /**
     * Checks if a NavMesh node passes the filter.
     * @param ref The node reference.
     * @param navMesh The navmesh
     * @param filter The query filter.
     * @returns Whether the node reference passes the filter.
     */
    passFilter?: (
        nodeRef: NodeRef,
        navMesh: NavMesh,
        filter: QueryFilter,
    ) => boolean;

    /**
     * Calculates the cost of moving from one point to another.
     * @param pa The start position on the edge of the previous and current node. [(x, y, z)]
     * @param pb The end position on the edge of the current and next node. [(x, y, z)]
     * @param navMesh The navigation mesh
     * @param prevRef The reference id of the previous node. [opt]
     * @param curRef The reference id of the current node.
     * @param nextRef The reference id of the next node. [opt]
     * @returns The cost of moving from the start to the end position.
     */
    getCost?: (
        pa: Vec3,
        pb: Vec3,
        navMesh: NavMesh,
        prevRef: NodeRef | undefined,
        curRef: NodeRef,
        nextRef: NodeRef | undefined,
    ) => number;
};

export const DEFAULT_QUERY_FILTER = {
    includeFlags: 0xffffffff,
    excludeFlags: 0,
    getCost: (pa, pb, navMesh, _prevRef, _curRef, nextRef) => {
        if (
            nextRef &&
            getNodeRefType(nextRef) === NodeType.OFFMESH_CONNECTION
        ) {
            const [, offMeshConnectionId] = desNodeRef(nextRef);
            const offMeshConnection =
                navMesh.offMeshConnections[offMeshConnectionId];
            if (offMeshConnection.cost !== undefined) {
                return offMeshConnection.cost;
            }
        }

        return vec3.distance(pa, pb);
    },
    passFilter(nodeRef, navMesh, filter) {
        const nodeType = getNodeRefType(nodeRef);

        let flags = 0;

        if (nodeType === NodeType.GROUND_POLY) {
            const [, tileId, polyIndex] = desNodeRef(nodeRef);
            const poly = navMesh.tiles[tileId].polys[polyIndex];
            flags = poly.flags;
        } else if (nodeType === NodeType.OFFMESH_CONNECTION) {
            const [, offMeshConnectionId] = desNodeRef(nodeRef);
            const offMeshConnection =
                navMesh.offMeshConnections[offMeshConnectionId];
            flags = offMeshConnection.flags;
        }

        return (
            (flags & filter.includeFlags) !== 0 &&
            (flags & filter.excludeFlags) === 0
        );
    },
} satisfies QueryFilter;
