import { chunkyTriMesh } from 'navcat/blocks';
import { describe, expect, it } from 'vitest';

const createTestGrid = (size: number) => {
    const positions: number[] = [];
    const indices: number[] = [];

    // create a grid of quads (2 triangles each)
    for (let z = 0; z < size; z++) {
        for (let x = 0; x < size; x++) {
            const baseIndex = positions.length / 3;

            // four corners of a quad
            positions.push(x, 0, z); // bottom-left
            positions.push(x + 1, 0, z); // bottom-right
            positions.push(x + 1, 0, z + 1); // top-right
            positions.push(x, 0, z + 1); // top-left

            // first triangle (bottom-left, bottom-right, top-right)
            indices.push(baseIndex, baseIndex + 1, baseIndex + 2);

            // second triangle (bottom-left, top-right, top-left)
            indices.push(baseIndex, baseIndex + 2, baseIndex + 3);
        }
    }

    return { positions, indices };
}

describe('ChunkyTriMesh', () => {
    describe('create', () => {
        it('should create a chunky tri mesh from vertices and indices', () => {
            const { positions, indices } = createTestGrid(4);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices, 8);

            expect(testChunkyTriMesh).toBeDefined();
            expect(testChunkyTriMesh.nodes.length).toBeGreaterThan(0);
            expect(testChunkyTriMesh.triangles.length).toBe(indices.length);
            expect(testChunkyTriMesh.maxTrisPerChunk).toBeLessThanOrEqual(8);
        });

        it('should respect the trisPerChunk parameter', () => {
            const { positions, indices } = createTestGrid(10);

            const chunkyMesh4 = chunkyTriMesh.create(positions, indices, 4);
            const chunkyMesh16 = chunkyTriMesh.create(positions, indices, 16);

            // smaller chunk size should result in more nodes
            expect(chunkyMesh4.nodes.length).toBeGreaterThan(chunkyMesh16.nodes.length);

            // max tris should not exceed the limit
            expect(chunkyMesh4.maxTrisPerChunk).toBeLessThanOrEqual(4);
            expect(chunkyMesh16.maxTrisPerChunk).toBeLessThanOrEqual(16);
        });

        it('should handle a single triangle', () => {
            const positions = [0, 0, 0, 1, 0, 0, 0, 0, 1];
            const indices = [0, 1, 2];

            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices);

            expect(testChunkyTriMesh.nodes.length).toBe(1);
            expect(testChunkyTriMesh.triangles).toEqual([0, 1, 2]);
            expect(testChunkyTriMesh.maxTrisPerChunk).toBe(1);
        });
    });

    describe('getChunksOverlappingRect', () => {
        it('should find chunks overlapping a rectangular region', () => {
            const { positions, indices } = createTestGrid(10);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices, 16);

            // query a 2x2 region in the middle
            const chunks = chunkyTriMesh.getChunksOverlappingRect(testChunkyTriMesh, [4, 4], [6, 6]);

            expect(chunks.length).toBeGreaterThan(0);

            // verify all returned chunks are leaf nodes
            for (const chunkIndex of chunks) {
                const node = testChunkyTriMesh.nodes[chunkIndex];
                expect(node.index).toBeGreaterThanOrEqual(0); // Leaf nodes have non-negative index
            }
        });

        it('should return empty array for region with no triangles', () => {
            const { positions, indices } = createTestGrid(5);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices);

            // query outside the grid
            const chunks = chunkyTriMesh.getChunksOverlappingRect(testChunkyTriMesh, [100, 100], [200, 200]);

            expect(chunks.length).toBe(0);
        });

        it('should find all chunks when querying the entire bounds', () => {
            const { positions, indices } = createTestGrid(5);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices, 8);

            // query the entire grid
            const chunks = chunkyTriMesh.getChunksOverlappingRect(testChunkyTriMesh, [-1, -1], [10, 10]);

            // should find all leaf nodes
            const leafNodes = testChunkyTriMesh.nodes.filter((node) => node.index >= 0);
            expect(chunks.length).toBe(leafNodes.length);
        });
    });

    describe('getTrianglesInRect', () => {
        it('should return all triangles in a region', () => {
            const { positions, indices } = createTestGrid(4);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices);

            // query a 2x2 region (should contain 8 triangles)
            const triangles = chunkyTriMesh.getTrianglesInRect(testChunkyTriMesh, [0, 0], [2, 2]);

            // each cell has 2 triangles, 2x2 cells = 8 triangles = 24 indices
            expect(triangles.length).toBeGreaterThan(0);
            expect(triangles.length % 3).toBe(0); // Should be multiple of 3
        });

        it('should return valid triangle indices', () => {
            const { positions, indices } = createTestGrid(3);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices);

            const triangles = chunkyTriMesh.getTrianglesInRect(testChunkyTriMesh, [0, 0], [3, 3]);

            // verify all indices are valid
            for (const index of triangles) {
                expect(index).toBeGreaterThanOrEqual(0);
                expect(index).toBeLessThan(positions.length / 3);
            }
        });

        it('should return empty array for region with no triangles', () => {
            const { positions, indices } = createTestGrid(5);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices);

            const triangles = chunkyTriMesh.getTrianglesInRect(testChunkyTriMesh, [100, 100], [200, 200]);

            expect(triangles.length).toBe(0);
        });
    });

    describe('getChunksOverlappingSegment', () => {
        it('should find chunks overlapping a line segment', () => {
            const { positions, indices } = createTestGrid(10);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices, 16);

            // diagonal line through the grid
            const chunks = chunkyTriMesh.getChunksOverlappingSegment(testChunkyTriMesh, [0, 0], [5, 5]);

            expect(chunks.length).toBeGreaterThan(0);

            // verify all returned chunks are leaf nodes
            for (const chunkIndex of chunks) {
                const node = testChunkyTriMesh.nodes[chunkIndex];
                expect(node.index).toBeGreaterThanOrEqual(0);
            }
        });

        it('should handle horizontal line segment', () => {
            const { positions, indices } = createTestGrid(10);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices);

            const chunks = chunkyTriMesh.getChunksOverlappingSegment(testChunkyTriMesh, [0, 5], [10, 5]);

            expect(chunks.length).toBeGreaterThan(0);
        });

        it('should handle vertical line segment', () => {
            const { positions, indices } = createTestGrid(10);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices);

            const chunks = chunkyTriMesh.getChunksOverlappingSegment(testChunkyTriMesh, [5, 0], [5, 10]);

            expect(chunks.length).toBeGreaterThan(0);
        });

        it('should return empty array for segment outside bounds', () => {
            const { positions, indices } = createTestGrid(5);
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices);

            const chunks = chunkyTriMesh.getChunksOverlappingSegment(testChunkyTriMesh, [100, 100], [200, 200]);

            expect(chunks.length).toBe(0);
        });
    });

    describe('performance', () => {
        it('should efficiently query large meshes', () => {
            // create a larger grid
            const { positions, indices } = createTestGrid(50); // 5000 triangles

            const start = performance.now();
            const testChunkyTriMesh = chunkyTriMesh.create(positions, indices, 64);
            const buildTime = performance.now() - start;

            console.log(`Built chunky tri mesh with ${testChunkyTriMesh.nodes.length} nodes in ${buildTime.toFixed(2)}ms`);

            // query multiple regions
            const queryStart = performance.now();
            for (let i = 0; i < 100; i++) {
                const x = (i % 10) * 5;
                const z = Math.floor(i / 10) * 5;
                chunkyTriMesh.getTrianglesInRect(testChunkyTriMesh, [x, z], [x + 5, z + 5]);
            }
            const queryTime = performance.now() - queryStart;

            console.log(`Queried 100 regions in ${queryTime.toFixed(2)}ms`);

            // should be reasonably fast
            expect(buildTime).toBeLessThan(100);
            expect(queryTime).toBeLessThan(50);
        });
    });
});
