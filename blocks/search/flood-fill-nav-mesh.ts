import { getNodeByTileAndPoly, getNodeRefIndex, type NavMesh, type NodeRef } from 'navcat';

export const floodFillNavMesh = (navMesh: NavMesh, startRefs: NodeRef[]): { reachable: NodeRef[]; unreachable: NodeRef[] } => {
    const visited = new Set<number>();
    const queue: number[] = [];

    // initialize queue with all seed points
    for (const startRef of startRefs) {
        queue.push(startRef);
    }

    // bfs from all starting polygons to find all reachable polygons
    while (queue.length > 0) {
        const currentNodeRef = queue.shift()!;

        if (visited.has(currentNodeRef)) continue;

        // add to visited
        visited.add(currentNodeRef);

        // follow all links
        const nodeIndex = getNodeRefIndex(currentNodeRef);
        const node = navMesh.nodes[nodeIndex];
        for (const linkIndex of node.links) {
            const link = navMesh.links[linkIndex];
            if (visited.has(link.toNodeRef)) continue;
            queue.push(link.toNodeRef);
        }
    }

    // return reached and unreached polygons
    const reachable: NodeRef[] = Array.from(visited);
    const unreachable: NodeRef[] = [];

    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const node = getNodeByTileAndPoly(navMesh, tile, polyIndex);

            if (!visited.has(node.ref)) {
                unreachable.push(node.ref);
            }
        }
    }

    return { reachable, unreachable };
};
