import { describe, expect, test } from 'vitest';
import { buildCompactHeightfield, getCon, setCon } from '../dist';
import { BuildContext } from '../src/generate/build-context';
import { NULL_AREA } from '../src/generate/common';
import { addHeightfieldSpan, createHeightfield } from '../src/generate/heightfield';

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
});
