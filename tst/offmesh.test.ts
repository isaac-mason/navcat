import { type Box3, box3 } from 'maaths';
import { describe, expect, test } from 'vitest';
import {
    addOffMeshConnection,
    addTile,
    buildTile,
    createNavMesh,
    type ExternalPolygon,
    type NavMesh,
    type NavMeshTileParams,
    OffMeshConnectionDirection,
    polygonsToNavMeshTilePolys,
    polysToTileDetailMesh,
    removeOffMeshConnection,
} from '../dist';

const createTestNavMesh = (): NavMesh => {
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
};

describe('offmesh connections', () => {
    test('offmesh connections attachment and node allocation', () => {
        const navMesh = createTestNavMesh();

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

        // check offmesh connection nodes were created (2 nodes: start and end)
        const nodesAfterAdd = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(nodesAfterAdd.length).toBe(6); // 4 poly nodes + 2 offmesh nodes

        const offMeshNodes = nodesAfterAdd.filter((node) => node.type === 1); // NodeType.OFFMESH = 1
        expect(offMeshNodes.length).toBe(2);

        // check offmesh nodes have correct connection id
        expect(offMeshNodes[0].offMeshConnectionId).toBe(offMeshConnectionId);
        expect(offMeshNodes[1].offMeshConnectionId).toBe(offMeshConnectionId);

        // remove the offmesh connection
        removeOffMeshConnection(navMesh, offMeshConnectionId);

        // check offmesh connection was removed
        expect(navMesh.offMeshConnections[offMeshConnectionId]).toBeUndefined();

        // check offmesh nodes are deallocated
        const nodesAfterRemove = Object.values(navMesh.nodes).filter((node) => node.allocated);
        expect(nodesAfterRemove.length).toBe(4);
        const offMeshNodesAfterRemove = nodesAfterRemove.filter((node) => node.type === 1);
        expect(offMeshNodesAfterRemove.length).toBe(0);
    });
});
