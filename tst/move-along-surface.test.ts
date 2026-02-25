import { type Box3, box3, type Vec3, vec3 } from 'mathcat';
import { describe, expect, test } from 'vitest';
import {
    addTile,
    buildTile,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    type ExternalPolygon,
    moveAlongSurface,
    type NavMesh,
    type NavMeshTileParams,
    polygonsToNavMeshTilePolys,
    polysToTileDetailMesh,
} from '../src';

describe('moveAlongSurface', () => {
    test('should move within single polygon', () => {
        const navMesh = createSimpleQuadNavMesh();

        const startPos: Vec3 = [0.5, 0, 0.5];
        const endPos: Vec3 = [0.8, 0, 0.8];

        const startNodeRef = navMesh.nodes[0].ref;

        const result = moveAlongSurface(navMesh, startNodeRef, startPos, endPos, DEFAULT_QUERY_FILTER);

        expect(result.success).toBe(true);
        expect(result.visited.length).toBe(1);
        expect(result.visited[0]).toBe(startNodeRef);
        expect(vec3.distance(result.position, endPos)).toBeLessThan(0.01);
    });

    test('should move across two adjacent triangles', () => {
        const navMesh = createSimpleQuadNavMesh();

        const startPos: Vec3 = [1.5, 0, 0.5];
        const endPos: Vec3 = [0.5, 0, 1.5];

        const startNodeRef = navMesh.nodes[0].ref;

        const result = moveAlongSurface(navMesh, startNodeRef, startPos, endPos, DEFAULT_QUERY_FILTER);

        expect(result.success).toBe(true);
        expect(result.visited.length).toBe(2);
        expect(vec3.distance(result.position, endPos)).toBeLessThan(0.1);
    });

    test('should handle small movement within polygon', () => {
        const navMesh = createSimpleQuadNavMesh();

        const startPos: Vec3 = [1.0, 0, 1.0];
        const endPos: Vec3 = [1.015, 0, 1.0];

        const startNodeRef = navMesh.nodes[0].ref;

        const result = moveAlongSurface(navMesh, startNodeRef, startPos, endPos, DEFAULT_QUERY_FILTER);

        expect(result.success).toBe(true);
        expect(result.visited.length).toBeGreaterThanOrEqual(1);
    });

    test('should move across long thin corridor', () => {
        const navMesh = createLongCorridorNavMesh();

        const startPos: Vec3 = [0.5, 0, 0.5];
        const endPos: Vec3 = [9.5, 0, 0.5];

        const startNodeRef = navMesh.nodes[0].ref;

        const result = moveAlongSurface(navMesh, startNodeRef, startPos, endPos, DEFAULT_QUERY_FILTER);

        expect(result.success).toBe(true);
        expect(result.visited.length).toBeGreaterThan(1);
    });

    test('should handle small movement that crosses polygon boundary', () => {
        const navMesh = createSimpleQuadNavMesh();

        // Triangle 0: [(0,0,0), (2,0,0), (2,0,2)]
        // Triangle 1: [(0,0,0), (2,0,2), (0,0,2)]
        // Shared edge: (0,0,0) to (2,0,2) - diagonal at z=x
        
        const startPos: Vec3 = [1.0, 0, 0.5]; // Triangle 0 (below diagonal)
        const endPos: Vec3 = [1.0, 0, 1.5];   // Triangle 1 (above diagonal)

        const startNodeRef = navMesh.nodes[0].ref;

        const result = moveAlongSurface(navMesh, startNodeRef, startPos, endPos, DEFAULT_QUERY_FILTER);

        expect(result.success).toBe(true);
        expect(result.visited.length).toBe(2);
    });

    test('should handle VERY small movement that crosses polygon boundary', () => {
        const navMesh = createSimpleQuadNavMesh();

        // Movement similar to crowd simulation (0.015 units)
        const startPos: Vec3 = [1.0, 0, 0.9925]; // Just below diagonal
        const endPos: Vec3 = [1.0, 0, 1.0075];   // Just above diagonal

        const startNodeRef = navMesh.nodes[0].ref;

        const result = moveAlongSurface(navMesh, startNodeRef, startPos, endPos, DEFAULT_QUERY_FILTER);

        expect(result.success).toBe(true);
        expect(result.visited.length).toBe(2);
    });

    test('should stop at wall when target is outside navmesh', () => {
        const navMesh = createSimpleQuadNavMesh();

        const startPos: Vec3 = [1.0, 0, 1.0];
        const endPos: Vec3 = [5.0, 0, 1.0]; // Way outside the 2x2 quad

        const startNodeRef = navMesh.nodes[0].ref;

        const result = moveAlongSurface(navMesh, startNodeRef, startPos, endPos, DEFAULT_QUERY_FILTER);

        expect(result.success).toBe(true);
        // Should stop at the edge (x=2)
        expect(result.position[0]).toBeLessThanOrEqual(2.0);
        expect(result.position[0]).toBeGreaterThan(1.9);
    });

    test('when start position is outside starting polygon, should snap to nearest wall edge', () => {
        const navMesh = createSimpleQuadNavMesh();

        const startPos: Vec3 = [1.0, 0, 1.5];
        const endPos: Vec3 = [1.0, 0, 1.52];

        const startNodeRef = navMesh.nodes[0].ref;

        const result = moveAlongSurface(navMesh, startNodeRef, startPos, endPos, DEFAULT_QUERY_FILTER);

        expect(result.success).toBe(true);
        
        expect(result.visited.length).toBe(1);
        expect(vec3.distance(startPos, result.position)).toBeGreaterThan(0.9);
    });
});

/**
 * Creates a simple 2x2 quad navmesh with 2 triangles
 */
function createSimpleQuadNavMesh(): NavMesh {
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
        0, 1, 2,  // Triangle 0
        0, 2, 3,  // Triangle 1
    ];

    return buildNavMeshFromGeometry(navMeshPositions, navMeshIndices);
}

/**
 * Creates a long corridor made of multiple quads
 * 10 units long, 1 unit wide
 */
function createLongCorridorNavMesh(): NavMesh {
    const positions: number[] = [];
    const indices: number[] = [];

    const corridorLength = 10;
    const corridorWidth = 1;
    const segmentLength = 1;
    const numSegments = corridorLength / segmentLength;

    // Create vertices for each segment
    for (let i = 0; i <= numSegments; i++) {
        const x = i * segmentLength;
        // Bottom edge
        positions.push(x, 0, 0);
        // Top edge
        positions.push(x, 0, corridorWidth);
    }

    // Create triangles for each segment
    for (let i = 0; i < numSegments; i++) {
        const baseIdx = i * 2;
        // First triangle
        indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
        // Second triangle
        indices.push(baseIdx, baseIdx + 3, baseIdx + 1);
    }

    return buildNavMeshFromGeometry(positions, indices);
}

/**
 * Helper to build a navmesh from raw geometry
 */
function buildNavMeshFromGeometry(positions: number[], indices: number[]): NavMesh {
    const bounds: Box3 = box3.create();
    const point = [0, 0, 0] as Vec3;
    for (let i = 0; i < positions.length; i += 3) {
        point[0] = positions[i];
        point[1] = positions[i + 1];
        point[2] = positions[i + 2];
        box3.expandByPoint(bounds, bounds, point);
    }

    const polys: ExternalPolygon[] = [];

    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];

        polys.push({
            vertices: [a, b, c],
            area: 0,
            flags: 1,
        });
    }

    const tilePolys = polygonsToNavMeshTilePolys(polys, positions, 0, bounds);

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
    navMesh.origin = [bounds[0], bounds[1], bounds[2]];
    navMesh.tileWidth = bounds[3] - bounds[0];
    navMesh.tileHeight = bounds[5] - bounds[2];

    addTile(navMesh, tile);

    return navMesh;
}
