import { describe, expect, test } from 'vitest';
import {
    addHeightfieldSpan,
    BuildContext,
    buildCompactHeightfield,
    createHeightfield,
    getCon,
    markBoxArea,
    markConvexPolyArea,
    markCylinderArea,
    markRotatedBoxArea,
    NULL_AREA,
    setCon,
} from '../dist';

describe('compact-heightfield', () => {
    describe('setCon and getCon', () => {
        test('sets and gets connection data for a single direction', () => {
            const span = { y: 0, region: 0, con: 0, h: 0 };

            setCon(span, 0, 5);

            expect(getCon(span, 0)).toBe(5);
            expect(getCon(span, 1)).toBe(0);
            expect(getCon(span, 2)).toBe(0);
            expect(getCon(span, 3)).toBe(0);
        });

        test('sets and gets connection data for all four directions', () => {
            const span = { y: 0, region: 0, con: 0, h: 0 };

            setCon(span, 0, 1);
            setCon(span, 1, 2);
            setCon(span, 2, 3);
            setCon(span, 3, 4);

            expect(getCon(span, 0)).toBe(1);
            expect(getCon(span, 1)).toBe(2);
            expect(getCon(span, 2)).toBe(3);
            expect(getCon(span, 3)).toBe(4);
        });

        test('handles maximum layer index (0x3f)', () => {
            const span = { y: 0, region: 0, con: 0, h: 0 };
            const maxLayer = 0x3f; // 63

            setCon(span, 0, maxLayer);

            expect(getCon(span, 0)).toBe(maxLayer);
        });

        test('preserves other direction data when setting one direction', () => {
            const span = { y: 0, region: 0, con: 0, h: 0 };

            setCon(span, 0, 5);
            setCon(span, 1, 10);
            setCon(span, 2, 15);
            setCon(span, 3, 20);

            // Overwrite direction 1
            setCon(span, 1, 25);

            expect(getCon(span, 0)).toBe(5);
            expect(getCon(span, 1)).toBe(25);
            expect(getCon(span, 2)).toBe(15);
            expect(getCon(span, 3)).toBe(20);
        });
    });

    describe('buildCompactHeightfield', () => {
        test('creates compact heightfield with correct dimensions', () => {
            const heightfield = createHeightfield(
                5,
                5,
                [
                    [0, 0, 0],
                    [5, 5, 5],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);

            const ctx = BuildContext.create();
            const compact = buildCompactHeightfield(ctx, 2, 2, heightfield);

            expect(compact.width).toBe(5);
            expect(compact.height).toBe(5);
            expect(compact.cells.length).toBe(25);
        });

        test('counts only walkable spans', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1); // Walkable
            addHeightfieldSpan(heightfield, 1, 2, 0, 10, NULL_AREA, 1); // Non-walkable

            const ctx = BuildContext.create();
            const compact = buildCompactHeightfield(ctx, 2, 2, heightfield);

            expect(compact.spanCount).toBe(1); // Only 1 walkable span
        });

        test('adjusts upper bounds for walkable height', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                0.5,
            );
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);

            const ctx = BuildContext.create();
            const walkableHeightVoxels = 4;
            const compact = buildCompactHeightfield(ctx, walkableHeightVoxels, 2, heightfield);

            // Upper bound should be adjusted by walkableHeight * cellHeight
            expect(compact.bounds[1][1]).toBe(3 + walkableHeightVoxels * 0.5);
        });

        test('converts heightfield spans to compact spans correctly', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 1, 1, 5, 15, 1, 1);

            const ctx = BuildContext.create();
            const compact = buildCompactHeightfield(ctx, 2, 2, heightfield);

            const cell = compact.cells[1 + 1 * 3];
            expect(cell.count).toBe(1);

            const span = compact.spans[cell.index];
            expect(span.y).toBe(15); // bot = span.max
            expect(span.h).toBeGreaterThan(0); // top - bot
            expect(compact.areas[cell.index]).toBe(1);
        });

        test('establishes neighbor connections in cardinal directions', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                1.0,
            );
            // Create a row of walkable spans
            addHeightfieldSpan(heightfield, 0, 1, 0, 10, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);
            addHeightfieldSpan(heightfield, 2, 1, 0, 10, 1, 1);

            const ctx = BuildContext.create();
            const compact = buildCompactHeightfield(ctx, 5, 3, heightfield);

            // Middle span should have connections to left and right
            const middleCell = compact.cells[1 + 1 * 3];
            const middleSpan = compact.spans[middleCell.index];

            expect(getCon(middleSpan, 0)).not.toBe(0x3f); // West connected
            expect(getCon(middleSpan, 2)).not.toBe(0x3f); // East connected
        });

        test('only connects neighbors within walkable height gap', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);
            addHeightfieldSpan(heightfield, 2, 1, 0, 10, 1, 1); // Same height, good gap

            const ctx = BuildContext.create();
            const walkableHeightVoxels = 5;
            const compact = buildCompactHeightfield(ctx, walkableHeightVoxels, 10, heightfield);

            const cell = compact.cells[1 + 1 * 3];
            const span = compact.spans[cell.index];

            // Should connect to neighbor (gap is sufficient: 10 - 0 = 10 >= 5)
            expect(getCon(span, 2)).not.toBe(0x3f); // East connected
        });

        test('only connects neighbors within walkable climb distance', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);
            addHeightfieldSpan(heightfield, 2, 1, 20, 30, 1, 1); // 10 units higher

            const ctx = BuildContext.create();
            const walkableClimbVoxels = 5;
            const compact = buildCompactHeightfield(ctx, 5, walkableClimbVoxels, heightfield);

            const cell = compact.cells[1 + 1 * 3];
            const span = compact.spans[cell.index];

            // Should not connect (climb too high: 20 - 10 = 10 > 5)
            expect(getCon(span, 2)).toBe(0x3f); // East not connected
        });

        test('handles cells with no walkable spans', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);
            // Leave (0, 0) empty

            const ctx = BuildContext.create();
            const compact = buildCompactHeightfield(ctx, 2, 2, heightfield);

            const emptyCell = compact.cells[0];
            expect(emptyCell.index).toBe(0);
            expect(emptyCell.count).toBe(0);
        });

        test('handles multiple spans in same column', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 2, 1);

            const ctx = BuildContext.create();
            const compact = buildCompactHeightfield(ctx, 2, 2, heightfield);

            const cell = compact.cells[1 + 1 * 3];
            expect(cell.count).toBe(2);

            // Check both spans exist
            const span1 = compact.spans[cell.index];
            const span2 = compact.spans[cell.index + 1];
            expect(span1.y).toBe(10);
            expect(span2.y).toBe(30);
        });

        test('handles edge cells with missing neighbors', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 3, 3],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 0, 0, 0, 10, 1, 1); // Corner cell

            const ctx = BuildContext.create();
            const compact = buildCompactHeightfield(ctx, 5, 3, heightfield);

            const cornerCell = compact.cells[0];
            const cornerSpan = compact.spans[cornerCell.index];

            // West and North should be not connected (out of bounds)
            expect(getCon(cornerSpan, 0)).toBe(0x3f);
            expect(getCon(cornerSpan, 3)).toBe(0x3f);
        });
    });

    // Shared test helpers
    const createGridWithSpans = (size: number) => {
        const heightfield = createHeightfield(
            size,
            size,
            [
                [0, 0, 0],
                [size, 10, size],
            ],
            1.0,
            1.0,
        );
        for (let x = 0; x < size; x++) {
            for (let z = 0; z < size; z++) {
                addHeightfieldSpan(heightfield, x, z, 0, 10, 1, 1);
            }
        }
        const ctx = BuildContext.create();
        return buildCompactHeightfield(ctx, 5, 3, heightfield);
    };

    const countMarked = (compact: ReturnType<typeof buildCompactHeightfield>, areaId: number) => {
        return compact.areas.filter((a) => a === areaId).length;
    };

    describe('markBoxArea', () => {
        test('marks spans within axis-aligned box bounds', () => {
            const compact = createGridWithSpans(5);
            const bounds: [[number, number, number], [number, number, number]] = [
                [1, 0, 1],
                [3, 10, 3],
            ];

            markBoxArea(bounds, 2, compact);

            const markedCount = countMarked(compact, 2);
            expect(markedCount).toBeGreaterThan(0);
            expect(markedCount).toBeLessThan(compact.spanCount);

            // Center should be marked
            expect(compact.areas[compact.cells[2 + 2 * 5].index]).toBe(2);

            // Corner should be unchanged
            expect(compact.areas[compact.cells[0].index]).toBe(1);
        });

        test('respects Y bounds and skips NULL_AREA', () => {
            const heightfield = createHeightfield(
                3,
                3,
                [
                    [0, 0, 0],
                    [3, 10, 3],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 1, 1, 0, 5, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 15, 20, 2, 1);
            addHeightfieldSpan(heightfield, 2, 1, 0, 5, NULL_AREA, 1);
            const compact = buildCompactHeightfield(BuildContext.create(), 5, 3, heightfield);

            markBoxArea(
                [
                    [0, 0, 0],
                    [3, 7, 3],
                ],
                3,
                compact,
            );

            const cell = compact.cells[1 + 1 * 3];
            expect(compact.areas[cell.index]).toBe(3); // Low span marked
            expect(compact.areas[cell.index + 1]).toBe(2); // High span unchanged
            expect(countMarked(compact, 3)).toBe(1); // NULL_AREA not counted
        });
    });

    describe('markConvexPolyArea', () => {
        test('marks spans within convex polygon bounds', () => {
            const compact = createGridWithSpans(7);

            // Triangle in center
            const verts = [2.0, 0, 2.0, 5.0, 0, 3.5, 3.5, 0, 5.0];

            markConvexPolyArea(verts, 0, 10, 4, compact);

            const markedCount = countMarked(compact, 4);
            expect(markedCount).toBeGreaterThan(0);
            expect(markedCount).toBeLessThan(compact.spanCount);

            // Point clearly inside triangle should be marked
            expect(compact.areas[compact.cells[3 + 3 * 7].index]).toBe(4);
        });

        test('respects Y bounds and handles edge cases', () => {
            const heightfield = createHeightfield(
                5,
                5,
                [
                    [0, 0, 0],
                    [5, 10, 5],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 2, 2, 0, 5, 1, 1);
            addHeightfieldSpan(heightfield, 2, 2, 15, 20, 2, 1);
            const compact = buildCompactHeightfield(BuildContext.create(), 5, 3, heightfield);

            const verts = [1.0, 0, 1.0, 4.0, 0, 1.0, 4.0, 0, 4.0, 1.0, 0, 4.0];
            markConvexPolyArea(verts, 0, 7, 5, compact);

            const cell = compact.cells[2 + 2 * 5];
            expect(compact.areas[cell.index]).toBe(5); // Low span marked
            expect(compact.areas[cell.index + 1]).toBe(2); // High span unchanged
        });
    });

    describe('markCylinderArea', () => {
        test('marks spans within cylinder radius', () => {
            const compact = createGridWithSpans(7);

            markCylinderArea([3.5, 0, 3.5], 1.5, 10, 6, compact);

            const markedCount = countMarked(compact, 6);
            expect(markedCount).toBeGreaterThan(0);
            expect(markedCount).toBeLessThan(compact.spanCount);

            // Center should be marked
            expect(compact.areas[compact.cells[3 + 3 * 7].index]).toBe(6);

            // Far corner should be unchanged
            expect(compact.areas[compact.cells[0].index]).toBe(1);
        });

        test('respects Y bounds and radius precisely', () => {
            const heightfield = createHeightfield(
                5,
                5,
                [
                    [0, 0, 0],
                    [5, 10, 5],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 2, 2, 0, 5, 1, 1);
            addHeightfieldSpan(heightfield, 2, 2, 15, 20, 2, 1);
            const compact = buildCompactHeightfield(BuildContext.create(), 5, 3, heightfield);

            markCylinderArea([2.5, 0, 2.5], 1.0, 7, 7, compact);

            const cell = compact.cells[2 + 2 * 5];
            expect(compact.areas[cell.index]).toBe(7); // Low span marked
            expect(compact.areas[cell.index + 1]).toBe(2); // High span unchanged

            // Should only mark cells within radius
            const markedCount = countMarked(compact, 7);
            expect(markedCount).toBeLessThan(5); // Not all cells
        });
    });

    describe('markRotatedBoxArea', () => {
        /**
         * Helper to get marked cell positions
         */
        const getMarkedPositions = (compact: ReturnType<typeof buildCompactHeightfield>, areaId: number, width: number) => {
            const positions: Array<{ x: number; z: number }> = [];
            for (let i = 0; i < compact.cells.length; i++) {
                const cell = compact.cells[i];
                if (cell.count > 0 && compact.areas[cell.index] === areaId) {
                    positions.push({
                        x: i % width,
                        z: Math.floor(i / width),
                    });
                }
            }
            return positions.sort((a, b) => (a.z === b.z ? a.x - b.x : a.z - b.z));
        };

        test('marks spans within rotated box at 0 degrees (aligned)', () => {
            const compact = createGridWithSpans(7);

            // Box centered at (3.5, 5, 3.5) with halfExtents [1.5, 5, 1.5]
            // Box extends from X:[2.0-5.0], Z:[2.0-5.0]
            // Cell centers at: X:[2.5, 3.5, 4.5], Z:[2.5, 3.5, 4.5]
            // These 9 cell centers are all within the box bounds
            markRotatedBoxArea([3.5, 5, 3.5], [1.5, 5, 1.5], 0, 2, compact);

            const marked = getMarkedPositions(compact, 2, 7);

            // At 0 degrees, should mark a 3x3 box centered at grid (3,3)
            expect(marked).toEqual([
                { x: 2, z: 2 },
                { x: 3, z: 2 },
                { x: 4, z: 2 },
                { x: 2, z: 3 },
                { x: 3, z: 3 },
                { x: 4, z: 3 },
                { x: 2, z: 4 },
                { x: 3, z: 4 },
                { x: 4, z: 4 },
            ]);
        });

        test('marks spans within rotated box at 45 degrees', () => {
            const compact = createGridWithSpans(9);

            // Box centered at (4.5, 5, 4.5), halfExtents [1.0, 5, 1.0], rotated 45 degrees
            // A 1x1 square rotated 45° forms a diamond pattern
            // The center cell and 4 adjacent cells in cardinal directions should be marked
            markRotatedBoxArea([4.5, 5, 4.5], [1.0, 5, 1.0], Math.PI / 4, 3, compact);

            const marked = getMarkedPositions(compact, 3, 9);

            // At 45 degrees, forms a diamond with center and 4 cardinal neighbors
            expect(marked).toEqual([
                { x: 4, z: 3 },
                { x: 3, z: 4 },
                { x: 4, z: 4 },
                { x: 5, z: 4 },
                { x: 4, z: 5 },
            ]);
        });

        test('marks spans within rotated box at 90 degrees', () => {
            const compact = createGridWithSpans(9);

            // Box centered at (4.5, 5, 4.5) with halfExtents [2.0, 5, 1.0]
            // At 0°: would be wide (5x3 cells), at 90°: becomes tall
            markRotatedBoxArea([4.5, 5, 4.5], [2.0, 5, 1.0], Math.PI / 2, 4, compact);

            const marked = getMarkedPositions(compact, 4, 9);

            // At 90 degrees, the long axis (X=2.0) becomes the Z axis
            // Should mark 13 cells in a vertical pattern
            expect(marked.length).toBe(13);

            // Check that it's vertical (more unique Z values than X values)
            const uniqueX = new Set(marked.map((p) => p.x)).size;
            const uniqueZ = new Set(marked.map((p) => p.z)).size;
            expect(uniqueZ).toBeGreaterThan(uniqueX);
            expect(uniqueZ).toBeGreaterThanOrEqual(5); // Tall
            expect(uniqueX).toBeLessThanOrEqual(3); // Narrow
        });

        test('marks spans within rotated box at 180 degrees (same as 0)', () => {
            const compact = createGridWithSpans(7);

            markRotatedBoxArea([3.5, 5, 3.5], [1.5, 5, 1.5], Math.PI, 5, compact);

            const marked = getMarkedPositions(compact, 5, 7);

            // At 180 degrees with a symmetric box, should be same as 0 degrees
            expect(marked).toEqual([
                { x: 2, z: 2 },
                { x: 3, z: 2 },
                { x: 4, z: 2 },
                { x: 2, z: 3 },
                { x: 3, z: 3 },
                { x: 4, z: 3 },
                { x: 2, z: 4 },
                { x: 3, z: 4 },
                { x: 4, z: 4 },
            ]);
        });

        test('marks rectangular box rotated at 30 degrees - snapshot', () => {
            const compact = createGridWithSpans(11);

            // Rectangular box (wider in X) rotated 30 degrees
            markRotatedBoxArea([5.5, 5, 5.5], [2.5, 5, 1.0], Math.PI / 6, 6, compact);

            const marked = getMarkedPositions(compact, 6, 11);

            // Snapshot: At 30 degrees, marks cells in a tilted rectangular pattern
            expect(marked.length).toBeGreaterThanOrEqual(10);
            expect(marked.length).toBeLessThanOrEqual(18);

            // Center should be marked
            expect(marked).toContainEqual({ x: 5, z: 5 });

            // Should have cells distributed across multiple rows and columns
            const uniqueX = new Set(marked.map((p) => p.x)).size;
            const uniqueZ = new Set(marked.map((p) => p.z)).size;
            expect(uniqueX).toBeGreaterThanOrEqual(4);
            expect(uniqueZ).toBeGreaterThanOrEqual(3);
        });

        test('marks rectangular box rotated at -45 degrees - snapshot', () => {
            const compact = createGridWithSpans(11);

            // Rectangular box rotated -45 degrees (clockwise)
            markRotatedBoxArea([5.5, 5, 5.5], [2.0, 5, 1.0], -Math.PI / 4, 7, compact);

            const marked = getMarkedPositions(compact, 7, 11);

            // Snapshot: A 2x1 rectangle at -45° forms a diagonal
            expect(marked.length).toBeGreaterThanOrEqual(5);
            expect(marked.length).toBeLessThanOrEqual(9);

            // Center should always be marked
            expect(marked).toContainEqual({ x: 5, z: 5 });

            // At -45 degrees (clockwise), the long axis (X=2.0) tilts from top-left to bottom-right
            const hasTopLeft = marked.some((p) => p.x < 5 && p.z < 5);
            const hasBottomRight = marked.some((p) => p.x > 5 && p.z > 5);
            expect(hasTopLeft).toBe(true);
            expect(hasBottomRight).toBe(true);
        });

        test('respects Y bounds and skips NULL_AREA spans', () => {
            const heightfield = createHeightfield(
                5,
                5,
                [
                    [0, 0, 0],
                    [5, 10, 5],
                ],
                1.0,
                1.0,
            );
            addHeightfieldSpan(heightfield, 2, 2, 0, 5, 1, 1); // Low span (y=5)
            addHeightfieldSpan(heightfield, 2, 2, 15, 20, 2, 1); // High span (y=20)
            addHeightfieldSpan(heightfield, 3, 2, 0, 5, NULL_AREA, 1); // NULL_AREA span
            const compact = buildCompactHeightfield(BuildContext.create(), 5, 3, heightfield);

            // Box with Y range [0-7] (center=3.5, halfExtent=3.5)
            // Should only mark spans with y in [0-7], which includes low span (y=5) but not high (y=20)
            markRotatedBoxArea([2.5, 3.5, 2.5], [1.0, 3.5, 1.0], Math.PI / 4, 8, compact);

            const cell22 = compact.cells[2 + 2 * 5];

            // Low span at (2,2) should be marked (y=5 is within [0-7])
            expect(compact.areas[cell22.index]).toBe(8);
            // High span at (2,2) should be unchanged (y=20 is outside [0-7])
            expect(compact.areas[cell22.index + 1]).toBe(2);

            // Cell (3,2) has NULL_AREA which should never be marked
            const cell32 = compact.cells[3 + 2 * 5];
            if (cell32.count > 0) {
                expect(compact.areas[cell32.index]).toBe(NULL_AREA);
            }
        });

        test('handles box partially outside grid bounds', () => {
            const compact = createGridWithSpans(5);

            // Box centered near corner, partially outside
            markRotatedBoxArea([1.0, 5, 1.0], [2.0, 5, 2.0], Math.PI / 4, 9, compact);

            const marked = getMarkedPositions(compact, 9, 5);

            // Should mark some cells but not crash
            expect(marked.length).toBeGreaterThan(0);
            expect(marked.length).toBeLessThan(compact.spanCount);

            // All marked positions should be within bounds
            for (const pos of marked) {
                expect(pos.x).toBeGreaterThanOrEqual(0);
                expect(pos.x).toBeLessThan(5);
                expect(pos.z).toBeGreaterThanOrEqual(0);
                expect(pos.z).toBeLessThan(5);
            }
        });

        test('handles box completely outside grid bounds - early exit', () => {
            const compact = createGridWithSpans(5);

            // Box way outside the grid
            markRotatedBoxArea([50.0, 5, 50.0], [1.0, 5, 1.0], 0, 10, compact);

            const marked = countMarked(compact, 10);

            // Should not mark any cells
            expect(marked).toBe(0);
            // All cells should retain original area
            expect(countMarked(compact, 1)).toBe(compact.spanCount);
        });

        test('small box rotated 360 degrees in 8 steps - full rotation snapshot', () => {
            const results: Array<{ angle: number; pattern: Array<{ x: number; z: number }> }> = [];

            for (let i = 0; i < 8; i++) {
                const compact = createGridWithSpans(9);
                const angle = (i * Math.PI) / 4; // 0, 45, 90, 135, 180, 225, 270, 315 degrees

                markRotatedBoxArea([4.5, 5, 4.5], [1.0, 5, 1.0], angle, 2, compact);

                results.push({
                    angle: (angle * 180) / Math.PI,
                    pattern: getMarkedPositions(compact, 2, 9),
                });
            }

            // All rotations should have similar counts for a square (due to symmetry)
            for (const result of results) {
                expect(result.pattern.length).toBeGreaterThanOrEqual(5);
                expect(result.pattern.length).toBeLessThanOrEqual(9);
            }

            // Each rotation should mark at least the center cell
            for (const result of results) {
                expect(result.pattern).toContainEqual({ x: 4, z: 4 });
                expect(result.pattern.length).toBeGreaterThan(0);
            }

            // Diagonal rotations (45°, 135°, 225°, 315°) should mark fewer cells (diamond pattern)
            // Axis-aligned rotations (0°, 90°, 180°, 270°) should mark more cells (square pattern)
            expect(results[1].pattern.length).toBeLessThan(results[0].pattern.length);
            expect(results[3].pattern.length).toBeLessThan(results[2].pattern.length);
        });

        test('thin rectangle rotating shows clear orientation changes', () => {
            const results: Array<{ angle: number; width: number; height: number }> = [];

            // Test a 4x1 rectangle at 0° and 90°
            for (const angle of [0, Math.PI / 2]) {
                const compact = createGridWithSpans(11);

                markRotatedBoxArea([5.5, 5, 5.5], [2.5, 5, 0.5], angle, 2, compact);

                const marked = getMarkedPositions(compact, 2, 11);
                const xs = marked.map((p) => p.x);
                const zs = marked.map((p) => p.z);
                const width = Math.max(...xs) - Math.min(...xs) + 1;
                const height = Math.max(...zs) - Math.min(...zs) + 1;

                results.push({
                    angle: (angle * 180) / Math.PI,
                    width,
                    height,
                });
            }

            // At 0°, should be wider than tall
            expect(results[0].width).toBeGreaterThan(results[0].height);

            // At 90°, should be taller than wide (orientation flipped)
            expect(results[1].height).toBeGreaterThan(results[1].width);
        });
    });
});
