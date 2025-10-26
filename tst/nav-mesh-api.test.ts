import { describe, expect, test } from 'vitest';
import { addTile, createNavMesh, getTileAt, getTilesAt, type NavMeshTile } from '../src';

const mockTile = (tileX: number, tileY: number, tileLayer: number): NavMeshTile => ({
    id: -1,
    sequence: -1,
    tileX,
    tileY,
    tileLayer,
    bounds: [
        [0, 0, 0],
        [10, 10, 10],
    ],
    vertices: [],
    detailMeshes: [],
    detailVertices: [],
    detailTriangles: [],
    polys: [],
    polyNodes: [],
    bvTree: {
        nodes: [],
        quantFactor: 0,
    },
    cellSize: 0.3,
    cellHeight: 0.2,
    walkableHeight: 2,
    walkableRadius: 0.6,
    walkableClimb: 0.9,
});

describe('nav-mesh-api', () => {
    describe('getTileAt', () => {
        test('returns tile at specific x, y, layer position', () => {
            const navMesh = createNavMesh();

            const tile = mockTile(0, 0, 0);

            addTile(navMesh, tile);

            const result = getTileAt(navMesh, 0, 0, 0);
            expect(result).toBeDefined();
            expect(result?.tileX).toBe(tile.tileX);
            expect(result?.tileY).toBe(tile.tileY);
            expect(result?.tileLayer).toBe(tile.tileLayer);
        });

        test('returns undefined for non-existent tile position', () => {
            const navMesh = createNavMesh();

            const tile = getTileAt(navMesh, 5, 5, 0);
            expect(tile).toBeUndefined();
        });

        test('differentiates between different layers at same x, y', () => {
            const navMesh = createNavMesh();

            const tile0 = mockTile(1, 1, 0);
            const tile1 = mockTile(1, 1, 1);

            addTile(navMesh, tile0);
            addTile(navMesh, tile1);

            const tileLayer0 = getTileAt(navMesh, 1, 1, 0);
            const tileLayer1 = getTileAt(navMesh, 1, 1, 1);

            expect(tileLayer0?.tileLayer).toBe(0);
            expect(tileLayer1?.tileLayer).toBe(1);
            expect(tileLayer0?.id).not.toBe(tileLayer1?.id);
        });

        test('handles negative tile coordinates', () => {
            const navMesh = createNavMesh();

            const tile = mockTile(-5, -3, 0);

            addTile(navMesh, tile);

            const result = getTileAt(navMesh, -5, -3, 0);
            expect(result).toBeDefined();
            expect(result?.tileX).toBe(-5);
            expect(result?.tileY).toBe(-3);
        });
    });

    describe('getTilesAt', () => {
        test('returns all tiles at x, y position across all layers', () => {
            const navMesh = createNavMesh();

            const tile0 = mockTile(2, 3, 0);
            const tile1 = mockTile(2, 3, 1);
            const tile2 = mockTile(2, 3, 2);

            addTile(navMesh, tile0);
            addTile(navMesh, tile1);
            addTile(navMesh, tile2);

            const tiles = getTilesAt(navMesh, 2, 3);

            expect(tiles.length).toBe(3);
            expect(tiles.map((t) => t.tileLayer).sort()).toEqual([0, 1, 2]);
        });

        test('returns empty array for position with no tiles', () => {
            const navMesh = createNavMesh();

            const tiles = getTilesAt(navMesh, 10, 10);

            expect(tiles).toEqual([]);
        });

        test('returns single tile when only one layer exists', () => {
            const navMesh = createNavMesh();

            const tile = mockTile(0, 0, 0);

            addTile(navMesh, tile);

            const tiles = getTilesAt(navMesh, 0, 0);

            expect(tiles.length).toBe(1);
            expect(tiles[0].tileLayer).toBe(0);
        });

        test('handles negative tile coordinates', () => {
            const navMesh = createNavMesh();

            const tile = mockTile(-10, -5, 0);

            addTile(navMesh, tile);

            const tiles = getTilesAt(navMesh, -10, -5);

            expect(tiles.length).toBe(1);
            expect(tiles[0].tileX).toBe(-10);
            expect(tiles[0].tileY).toBe(-5);
        });

        test('does not return tiles from different x, y positions', () => {
            const navMesh = createNavMesh();

            const tile1 = mockTile(0, 0, 0);
            const tile2 = mockTile(1, 0, 0);

            addTile(navMesh, tile1);
            addTile(navMesh, tile2);

            const tiles = getTilesAt(navMesh, 0, 0);

            expect(tiles.length).toBe(1);
            expect(tiles[0].tileX).toBe(0);
        });
    });
});
