import type { NavMesh, NodeRef } from 'navcat';

export type FlowField = {
    cost: Map<NodeRef, number>;
    next: Map<NodeRef, NodeRef | null>;
    visited: Set<NodeRef>;
};

/**
 * Computes a flow field for pathfinding from all reachable nodes to a target node.
 * @param navMesh - The navigation mesh.
 * @param targetRef - The target polygon/node reference.
 * @param maxIterations - Maximum number of BFS iterations to perform.
 * @returns FlowField object with cost, next, and visited maps.
 */
export function computeFlowField(navMesh: NavMesh, targetRef: NodeRef, maxIterations: number): FlowField {
    const cost = new Map<NodeRef, number>();
    const next = new Map<NodeRef, NodeRef | null>();
    const visited = new Set<NodeRef>();
    const queue: Array<{ ref: NodeRef; c: number }> = [{ ref: targetRef, c: 0 }];

    cost.set(targetRef, 0);
    next.set(targetRef, null);
    visited.add(targetRef);

    let iterations = 0;
    while (queue.length > 0 && iterations < maxIterations) {
        const { ref: currentRef, c: currentCost } = queue.shift()!;
        iterations++;

        // Get links for this polygon using navMesh.nodes
        const polyLinks = navMesh.nodes[currentRef];
        if (!polyLinks) continue;

        for (const linkIndex of polyLinks) {
            const link = navMesh.links[linkIndex];
            if (!link || !link.allocated) continue;
            const neighborRef = link.neighbourRef;
            if (!neighborRef) continue;
            if (visited.has(neighborRef)) continue;

            cost.set(neighborRef, currentCost + 1);
            next.set(neighborRef, currentRef);
            visited.add(neighborRef);
            queue.push({ ref: neighborRef, c: currentCost + 1 });
        }
    }

    return { cost, next, visited };
}

/**
 * Extracts a path from a start node to the target using the flow field.
 * @param flowField - The computed flow field.
 * @param startRef - The starting node reference.
 * @returns An array of NodeRefs representing the path, or null if unreachable.
 */
export function getNodePathFromFlowField(flowField: FlowField, startRef: NodeRef): NodeRef[] | null {
    const path: NodeRef[] = [];
    let current = startRef;
    const visited = new Set<NodeRef>();

    while (current && flowField.next.has(current) && !visited.has(current)) {
        path.push(current);
        visited.add(current);
        const next = flowField.next.get(current);
        if (!next) break; // reached target
        current = next;
    }

    // If the last node is not the target, path is incomplete/unreachable
    if (!flowField.next.has(current) || flowField.next.get(current) !== null) {
        return null;
    }

    return path;
}
