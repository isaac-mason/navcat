import { getNodeByRef, INVALID_NODE_REF, type NavMesh, type NodeRef, type QueryFilter } from 'navcat';

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
    const queue: Array<{ nodeRef: NodeRef; c: number }> = [{ nodeRef: targetRef, c: 0 }];

    cost.set(targetRef, 0);
    next.set(targetRef, null);
    visited.add(targetRef);

    let iterations = 0;
    while (queue.length > 0 && iterations < maxIterations) {
        const { nodeRef: currentRef, c: currentCost } = queue.shift()!;
        iterations++;

        // get links for this node
        const node = getNodeByRef(navMesh, currentRef);

        for (const linkIndex of node.links) {
            const link = navMesh.links[linkIndex];

            const neighborRef = link.toNodeRef;

            if (visited.has(neighborRef)) continue;

            if (!queryFilter.passFilter(neighborRef, navMesh)) continue;

            cost.set(neighborRef, currentCost + 1);
            next.set(neighborRef, currentRef);
            visited.add(neighborRef);
            queue.push({ nodeRef: neighborRef, c: currentCost + 1 });
        }
    }

    return { cost, next, visited };
}

/**
 * Extracts a path from a start node to the target using the flow field.
 * @param flowField - The computed flow field.
 * @param startNodeRef - The starting node reference.
 * @returns An array of NodeRefs representing the path, or null if unreachable.
 */
export function getNodePathFromFlowField(flowField: FlowField, startNodeRef: NodeRef): NodeRef[] | null {
    const path: NodeRef[] = [];
    let current = startNodeRef;
    const visited = new Set<NodeRef>();

    while (current !== INVALID_NODE_REF && flowField.next.has(current) && !visited.has(current)) {
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
