import { type Box3, box3 } from 'maaths';
import { describe, expect, test } from 'vitest';
import {
    addOffMeshConnection,
    addTile,
    buildTile,
    createNavMesh,
    isValidNodeRef,
    type ExternalPolygon,
    type NavMesh,
    type NavMeshTileParams,
    OffMeshConnectionDirection,
    polygonsToNavMeshTilePolys,
    polysToTileDetailMesh,
    removeOffMeshConnection,
    removeTile,
} from '../dist';

describe('node graph', () => {
    test('tile polys', () => {
        // prepare a simple nav mesh tile of one quad

        // biome-ignore format: readability
        const navMeshPositions = [
            // quad vertices (indices 0-3)
            0, 0, 0,      // 0: bottom-left
            2, 0, 0,      // 1: bottom-right
            2, 0, 2,      // 2: top-right
            0, 0, 2,      // 3: top-left
        ];

        // biome-ignore format: readability
        const navMeshIndices = [
            // quad triangles
            0, 1, 2,
            0, 2, 3,
        ];

        const bounds: Box3 = box3.create();
        const point = [0, 0, 0] as [number, number, number];
        for (let i = 0; i < navMeshPositions.length; i += 3) {
            point[0] = navMeshPositions[i];
            point[1] = navMeshPositions[i + 1];
            point[2] = navMeshPositions[i + 2];
            box3.expandByPoint(bounds, bounds, point);
        }

        const polys: ExternalPolygon[] = [];

        for (let i = 0; i < navMeshIndices.length; i += 3) {
            const a = navMeshIndices[i];
            const b = navMeshIndices[i + 1];
            const c = navMeshIndices[i + 2];

            polys.push({
                vertices: [a, b, c],
                area: 0,
                flags: 1,
            });
        }

        const tilePolys = polygonsToNavMeshTilePolys(polys, navMeshPositions, 0, bounds);

        const tileDetailMesh = polysToTileDetailMesh(tilePolys.polys);

        const tileParams: NavMeshTileParams = {
            bounds,
            vertices: tilePolys.vertices,
            polys: tilePolys.polys,
            detailMeshes: tileDetailMesh.detailMeshes,
            detailVertices: tileDetailMesh.detailVertices,
            detailTriangles: tileDetailMesh.detailTriangles,
            tileX: 0,
            tileY: 0,
            tileLayer: 0,
            cellSize: 0.2,
            cellHeight: 0.2,
            walkableHeight: 0.5,
            walkableRadius: 0.5,
            walkableClimb: 0.5,
        };

        const tile = buildTile(tileParams);

        const navMesh = createNavMesh();
        navMesh.origin = bounds[0];
        navMesh.tileWidth = bounds[1][0] - bounds[0][0];
        navMesh.tileHeight = bounds[1][2] - bounds[0][2];

        // assert: no nodes or links yet
        expect(navMesh.nodes.length).toBe(0);
        expect(navMesh.links.length).toBe(0);

        // add the tile
        addTile(navMesh, tile);

        // assert: should have 2 polys, each with a node
        const allocatedPolyNodes = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(allocatedPolyNodes.length).toBe(2);

        // capture refs now (node objects will be pooled when deallocated)
        const allocatedPolyRefs = allocatedPolyNodes.map((n) => n.ref);

        // assert: their refs are valid according to isValidNodeRef
        for (const ref of allocatedPolyRefs) {
            expect(isValidNodeRef(navMesh, ref)).toBe(true);
        }

        // assert: each node should have one link to the other poly
        for (const node of allocatedPolyNodes) {
            expect(node.links.length).toBe(1);
            const link = navMesh.links[node.links[0]];
            const toNode = Object.values(navMesh.nodes).find((n) => n.ref === link.toNodeRef);
            expect(toNode).toBeDefined();
            expect(toNode?.type).toBe(0); // NodeType.POLY = 0
        }

        // remove the tile
        removeTile(navMesh, tile.tileX, tile.tileY, tile.tileLayer);

        // assert: no allocated nodes
        const allocatedNodes = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(allocatedNodes.length).toBe(0);

        // assert: refs should now be invalid
        for (const ref of allocatedPolyRefs) {
            expect(isValidNodeRef(navMesh, ref)).toBe(false);
        }

        // assert: nodes are pooled
        expect(navMesh.nodes.length).toBe(2);

        // assert: no allocated links
        const allocatedLinks = navMesh.links.filter((link) => link.allocated);
        expect(allocatedLinks.length).toBe(0);

        // assert: links are pooled
        expect(navMesh.links.length).toBe(2);
    });

    test('bidirectional offmesh connection', () => {
        const navMesh = createOffMeshTestNavMesh();

        // initially, there should be 4 poly nodes
        const initialPolyNodes = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(initialPolyNodes.length).toBe(4);

        // no offmesh connections initially
        expect(Object.keys(navMesh.offMeshConnections).length).toBe(0);

        const startPos: [number, number, number] = [1, 0, 1]; // Center of first quad
        const endPos: [number, number, number] = [8, 0, 1]; // Center of second quad

        // add an offmesh connection from first platform to second platform
        const offMeshConnectionId = addOffMeshConnection(navMesh, {
            start: startPos,
            end: endPos,
            radius: 0.5,
            direction: OffMeshConnectionDirection.BIDIRECTIONAL,
            area: 0,
            flags: 1,
        });

        // check offmesh connection exists
        expect(navMesh.offMeshConnections[offMeshConnectionId]).toBeDefined();

        // check offmesh connection attachment exists
        const attachment = navMesh.offMeshConnectionAttachments[offMeshConnectionId];
        expect(attachment).toBeDefined();

        // check offmesh connection nodes were created (1 node: offmesh)
        const nodesAfterAdd = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(nodesAfterAdd.length).toBe(5); // 4 poly nodes + 1 offmesh node

        const offMeshNodes = nodesAfterAdd.filter((node) => node.type === 1); // NodeType.OFFMESH = 1
        expect(offMeshNodes.length).toBe(1);

        // check offmesh node has correct connection id
        const offMeshNode = offMeshNodes[0];
        expect(offMeshNode.offMeshConnectionId).toBe(offMeshConnectionId);

        // capture the offmesh node ref now (node object will be pooled)
        const offMeshNodeRef = offMeshNode.ref;

        // Start poly should link to offmesh node
        const startPolyNode = Object.values(navMesh.nodes).find(
            (node) => node.allocated && node.ref === attachment.startPolyNode,
        );
        expect(startPolyNode).toBeDefined();
        const startPolyOffMeshLinks = startPolyNode!.links.filter((linkIdx) => {
            const link = navMesh.links[linkIdx];
            return link.toNodeRef === offMeshNode!.ref;
        });
        expect(startPolyOffMeshLinks.length).toBe(1);

        // Offmesh node should have 2 links (forward to end poly, reverse back to start poly)
        expect(offMeshNode!.links.length).toBe(2);
        const offMeshLinks = offMeshNode!.links.map((idx) => navMesh.links[idx]);
        expect(offMeshLinks.some((link) => link.toNodeRef === attachment.endPolyNode)).toBe(true);
        expect(offMeshLinks.some((link) => link.toNodeRef === attachment.startPolyNode)).toBe(true);

        // End poly should link to offmesh node
        const endPolyNode = Object.values(navMesh.nodes).find((node) => node.allocated && node.ref === attachment.endPolyNode);
        expect(endPolyNode).toBeDefined();
        const endPolyOffMeshLinks = endPolyNode!.links.filter((linkIdx) => {
            const link = navMesh.links[linkIdx];
            return link.toNodeRef === offMeshNode!.ref;
        });
        expect(endPolyOffMeshLinks.length).toBe(1);

        // remove the offmesh connection
        removeOffMeshConnection(navMesh, offMeshConnectionId);

        // check offmesh connection was removed
        expect(navMesh.offMeshConnections[offMeshConnectionId]).toBeUndefined();

        // check offmesh nodes are deallocated
        const nodesAfterRemove = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(nodesAfterRemove.length).toBe(4);
        const offMeshNodesAfterRemove = nodesAfterRemove.filter((node) => node.type === 1);
        expect(offMeshNodesAfterRemove.length).toBe(0);

        // offmesh node ref should now be invalid (use saved ref)
        expect(isValidNodeRef(navMesh, offMeshNodeRef)).toBe(false);
    });

    test('one way offmesh connection', () => {
        const navMesh = createOffMeshTestNavMesh();

        // initially, there should be 4 poly nodes
        const initialPolyNodes = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(initialPolyNodes.length).toBe(4);

        const startPos: [number, number, number] = [1, 0, 1]; // Center of first quad
        const endPos: [number, number, number] = [8, 0, 1]; // Center of second quad

        // add a one-way offmesh connection (START_TO_END)
        const offMeshConnectionId = addOffMeshConnection(navMesh, {
            start: startPos,
            end: endPos,
            radius: 0.5,
            direction: OffMeshConnectionDirection.START_TO_END,
            area: 0,
            flags: 1,
        });

        // check offmesh connection exists
        expect(navMesh.offMeshConnections[offMeshConnectionId]).toBeDefined();

        // check offmesh connection attachment exists
        const attachment = navMesh.offMeshConnectionAttachments[offMeshConnectionId];
        expect(attachment).toBeDefined();

        // for one-way connections, 1 offmesh node is created, with forward links only
        const nodesAfterAdd = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(nodesAfterAdd.length).toBe(5); // 4 poly nodes + 1 offmesh node

        const offMeshNodes = nodesAfterAdd.filter((node) => node.type === 1); // NodeType.OFFMESH = 1
        expect(offMeshNodes.length).toBe(1);

        const startOffMeshNode = offMeshNodes[0];

        // capture the offmesh node ref now
        const startOffMeshNodeRef = startOffMeshNode.ref;

        // the start poly should link to the offmesh node
        const startPolyNode = Object.values(navMesh.nodes).find(
            (node) => node.allocated && node.ref === attachment.startPolyNode,
        );
        expect(startPolyNode).toBeDefined();
        const startPolyOffMeshLinks = startPolyNode!.links.filter((linkIdx) => {
            const link = navMesh.links[linkIdx];
            return link.toNodeRef === startOffMeshNode!.ref;
        });
        expect(startPolyOffMeshLinks.length).toBe(1);

        // the offmesh node should link to the end poly (forward) and only that
        expect(startOffMeshNode!.links.length).toBe(1);
        const startOffMeshLink = navMesh.links[startOffMeshNode!.links[0]];
        expect(startOffMeshLink.toNodeRef).toBe(attachment.endPolyNode);

        // the end poly should NOT link to any offmesh node (one-way only)
        const endPolyNode = Object.values(navMesh.nodes).find((node) => node.allocated && node.ref === attachment.endPolyNode);
        expect(endPolyNode).toBeDefined();

        // the end poly should only have links to its adjacent polys, not to offmesh
        const endPolyOffMeshLinks = endPolyNode!.links.filter((linkIdx) => {
            const link = navMesh.links[linkIdx];
            const toNode = Object.values(navMesh.nodes).find((n) => n.ref === link.toNodeRef);
            return toNode?.type === 1; // NodeType.OFFMESH
        });
        expect(endPolyOffMeshLinks.length).toBe(0);

        // remove the offmesh connection
        removeOffMeshConnection(navMesh, offMeshConnectionId);

        // check offmesh connection was removed
        expect(navMesh.offMeshConnections[offMeshConnectionId]).toBeUndefined();

    // check offmesh node is deallocated
    const nodesAfterRemove = Object.values(navMesh.nodes).filter((node) => node.allocated);
    expect(nodesAfterRemove.length).toBe(4);
    const offMeshNodesAfterRemove = nodesAfterRemove.filter((node) => node.type === 1);
    expect(offMeshNodesAfterRemove.length).toBe(0);

    // and the saved ref should now be invalid
    expect(isValidNodeRef(navMesh, startOffMeshNodeRef)).toBe(false);
    });
});

function createOffMeshTestNavMesh(): NavMesh {
    // Create two disconnected quads (platforms)
    // First quad: bottom-left platform at y=0
    // Second quad: top-right platform at y=0 (separated by gap in x)

    // biome-ignore format: readability
    const navMeshPositions = [
        // First quad vertices (indices 0-3)
        0, 0, 0,      // 0: bottom-left
        2, 0, 0,      // 1: bottom-right
        2, 0, 2,      // 2: top-right
        0, 0, 2,      // 3: top-left
        
        // Second quad vertices (indices 4-7) - 5 units away on x-axis
        7, 0, 0,      // 4: bottom-left
        9, 0, 0,      // 5: bottom-right
        9, 0, 2,      // 6: top-right
        7, 0, 2,      // 7: top-left
    ];

    // biome-ignore format: readability
    const navMeshIndices = [
        // First quad triangles
        0, 1, 2,
        0, 2, 3,
        
        // Second quad triangles
        4, 5, 6,
        4, 6, 7,
    ];

    // Calculate bounds
    const bounds: Box3 = box3.create();
    const point = [0, 0, 0] as [number, number, number];
    for (let i = 0; i < navMeshPositions.length; i += 3) {
        point[0] = navMeshPositions[i];
        point[1] = navMeshPositions[i + 1];
        point[2] = navMeshPositions[i + 2];
        box3.expandByPoint(bounds, bounds, point);
    }

    // Create polygons
    const polys: ExternalPolygon[] = [];

    for (let i = 0; i < navMeshIndices.length; i += 3) {
        const a = navMeshIndices[i];
        const b = navMeshIndices[i + 1];
        const c = navMeshIndices[i + 2];

        polys.push({
            vertices: [a, b, c],
            area: 0,
            flags: 1,
        });
    }

    const tilePolys = polygonsToNavMeshTilePolys(polys, navMeshPositions, 0, bounds);

    const tileDetailMesh = polysToTileDetailMesh(tilePolys.polys);

    // Create nav mesh tile
    const tileParams: NavMeshTileParams = {
        bounds,
        vertices: tilePolys.vertices,
        polys: tilePolys.polys,
        detailMeshes: tileDetailMesh.detailMeshes,
        detailVertices: tileDetailMesh.detailVertices,
        detailTriangles: tileDetailMesh.detailTriangles,
        tileX: 0,
        tileY: 0,
        tileLayer: 0,
        cellSize: 0.2,
        cellHeight: 0.2,
        walkableHeight: 0.5,
        walkableRadius: 0.5,
        walkableClimb: 0.5,
    };

    const tile = buildTile(tileParams);

    const navMesh = createNavMesh();
    navMesh.origin = bounds[0];
    navMesh.tileWidth = bounds[1][0] - bounds[0][0];
    navMesh.tileHeight = bounds[1][2] - bounds[0][2];

    addTile(navMesh, tile);

    return navMesh;
}
