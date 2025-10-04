import type { NavMesh, NodeRef, QueryFilter } from 'navcat';

export type FlowField = {
    cost: Map<NodeRef, number>;
    next: Map<NodeRef, NodeRef | null>;
    visited: Set<NodeRef>;
};

/**
 * Computes a uniform cost flow field.
 * The "uniform cost" approach trades off accuracy for speed. We are assuming the cost of traversing each polygon is uniform,
 * meaning we aren't taking into account polygon sizes or other custom cost calculations from QueryFilter.getCost.
 * We do however still check QueryFilter.passFilter.
 */
export function computeUniformCostFlowField(
    navMesh: NavMesh,
    targetRef: NodeRef,
    queryFilter: QueryFilter,
    maxIterations: number,
): FlowField {
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

            const neighborRef = link.neighbourRef;

            if (visited.has(neighborRef)) continue;

            if (!queryFilter.passFilter(neighborRef, navMesh)) continue;

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
