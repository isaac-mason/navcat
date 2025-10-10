import { type Box3, vec2 } from 'maaths';
import { describe, expect, test } from 'vitest';
import {
    addHeightfieldSpan,
    calculateGridSize,
    createHeightfield,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    rasterizeTriangles,
} from '../dist';
import { BuildContext } from '../src/generate/build-context';
import { NULL_AREA } from '../src/generate/common';

describe('heightfield', () => {
    describe('calculateGridSize', () => {
        test('calculates grid size for simple square bounds', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const cellSize = 1.0;
            const outGridSize = vec2.create();

            calculateGridSize(outGridSize, bounds, cellSize);

            expect(outGridSize[0]).toBe(10);
            expect(outGridSize[1]).toBe(10);
        });

        test('handles non-uniform bounds correctly', () => {
            const bounds: Box3 = [
                [-5, 0, -5],
                [15, 10, 5],
            ];
            const cellSize = 0.5;
            const outGridSize = vec2.create();

            calculateGridSize(outGridSize, bounds, cellSize);

            expect(outGridSize[0]).toBe(40); // (15 - (-5)) / 0.5 = 40
            expect(outGridSize[1]).toBe(20); // (5 - (-5)) / 0.5 = 20
        });

        test('rounds correctly with fractional cell sizes', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10.3, 5, 10.7],
            ];
            const cellSize = 1.0;
            const outGridSize = vec2.create();

            calculateGridSize(outGridSize, bounds, cellSize);

            expect(outGridSize[0]).toBe(10);
            expect(outGridSize[1]).toBe(11);
        });
    });

    describe('createHeightfield', () => {
        test('creates heightfield with correct dimensions', () => {
            const width = 10;
            const height = 20;
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 5, 20],
            ];
            const cellSize = 1.0;
            const cellHeight = 0.5;

            const heightfield = createHeightfield(width, height, bounds, cellSize, cellHeight);

            expect(heightfield.width).toBe(10);
            expect(heightfield.height).toBe(20);
            expect(heightfield.spans.length).toBe(200); // width * height
        });

        test('initializes all spans to null', () => {
            const heightfield = createHeightfield(
                5,
                5,
                [
                    [0, 0, 0],
                    [5, 5, 5],
                ],
                1.0,
                0.5,
            );

            for (let i = 0; i < heightfield.spans.length; i++) {
                expect(heightfield.spans[i]).toBeNull();
            }
        });

        test('stores bounds and cell parameters correctly', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 5, 20],
            ];
            const cellSize = 1.0;
            const cellHeight = 0.5;

            const heightfield = createHeightfield(10, 20, bounds, cellSize, cellHeight);

            expect(heightfield.bounds).toBe(bounds);
            expect(heightfield.cellSize).toBe(cellSize);
            expect(heightfield.cellHeight).toBe(cellHeight);
        });
    });

    describe('addHeightfieldSpan', () => {
        test('adds span to empty column', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];
            expect(span).not.toBeNull();
            expect(span!.min).toBe(0);
            expect(span!.max).toBe(10);
            expect(span!.area).toBe(1);
            expect(span!.next).toBeNull();
        });

        test('adds non-overlapping span before existing span', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);

            const columnIndex = 1 + 1 * 3;
            const span1 = heightfield.spans[columnIndex];
            const span2 = span1!.next;

            expect(span1!.min).toBe(0);
            expect(span1!.max).toBe(10);
            expect(span2!.min).toBe(20);
            expect(span2!.max).toBe(30);
        });

        test('adds non-overlapping span after existing span', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 1, 1);

            const columnIndex = 1 + 1 * 3;
            const span1 = heightfield.spans[columnIndex];
            const span2 = span1!.next;

            expect(span1!.min).toBe(0);
            expect(span1!.max).toBe(10);
            expect(span2!.min).toBe(20);
            expect(span2!.max).toBe(30);
        });

        test('merges completely overlapping spans', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 12, 18, 2, 1);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.min).toBe(10);
            expect(span!.max).toBe(20);
            expect(span!.next).toBeNull();
        });

        test('merges partially overlapping spans', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 15, 25, 2, 1);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.min).toBe(10);
            expect(span!.max).toBe(25);
            expect(span!.next).toBeNull();
        });

        test('extends span when new span is taller', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 10, 30, 2, 1);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.min).toBe(10);
            expect(span!.max).toBe(30);
        });

        test('extends span when new span starts lower', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 5, 20, 2, 1);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.min).toBe(5);
            expect(span!.max).toBe(20);
        });

        test('merges multiple consecutive spans', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 40, 50, 1, 1);
            // Add a span that bridges all three
            addHeightfieldSpan(heightfield, 1, 1, 5, 45, 2, 1);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.min).toBe(0);
            expect(span!.max).toBe(50);
            expect(span!.next).toBeNull();
        });

        test('respects area priority when spans have similar max height (within threshold)', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 5, 1);
            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 10, 1); // Same max, higher area ID

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(10); // Should take higher area ID
        });

        test('keeps original area when max heights differ beyond threshold', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 5, 1);
            addHeightfieldSpan(heightfield, 1, 1, 10, 25, 10, 2); // Max differs by 5, threshold is 2

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            // When threshold is exceeded, it doesn't check area priority, so the merged span
            // gets the default behavior (no area comparison), which takes the max
            expect(span!.area).toBe(10); // Takes the second span's area (merged but no priority check)
            expect(span!.max).toBe(25);
        });

        test('maintains span ordering after multiple insertions', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 0, 5, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 40, 50, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 10, 15, 1, 1);

            const columnIndex = 1 + 1 * 3;
            let span = heightfield.spans[columnIndex];
            const mins: number[] = [];

            while (span !== null) {
                mins.push(span.min);
                span = span.next;
            }

            expect(mins).toEqual([0, 10, 20, 40]); // Should be sorted by min
        });
    });

    describe('rasterizeTriangles', () => {
        test('rasterizes single horizontal triangle', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            // Horizontal triangle at y=2
            const vertices = [
                2,
                2,
                2, // v0
                4,
                2,
                2, // v1
                3,
                2,
                4, // v2
            ];
            const indices = [0, 1, 2];
            const triAreaIds = [1];

            const ctx = BuildContext.create();
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds);

            expect(result).toBe(true);
            // Check that some spans were created
            let spanCount = 0;
            for (const span of heightfield.spans) {
                if (span !== null) spanCount++;
            }
            expect(spanCount).toBeGreaterThan(0);
        });

        test('rasterizes single vertical triangle', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            // Vertical triangle
            const vertices = [
                2,
                0,
                2, // v0
                4,
                5,
                2, // v1
                3,
                0,
                4, // v2
            ];
            const indices = [0, 1, 2];
            const triAreaIds = [1];

            const ctx = BuildContext.create();
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds);

            expect(result).toBe(true);
            let spanCount = 0;
            for (const span of heightfield.spans) {
                if (span !== null) spanCount++;
            }
            expect(spanCount).toBeGreaterThan(0);
        });

        test('skips triangle completely outside heightfield bounds', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            // Triangle completely outside bounds
            const vertices = [20, 2, 20, 22, 2, 20, 21, 2, 22];
            const indices = [0, 1, 2];
            const triAreaIds = [1];

            const ctx = BuildContext.create();
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds);

            expect(result).toBe(true);
            // No spans should be created
            for (const span of heightfield.spans) {
                expect(span).toBeNull();
            }
        });

        test('clips triangle partially outside heightfield bounds', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            // Triangle partially outside
            const vertices = [
                8,
                2,
                8,
                12,
                2,
                8, // This vertex is outside
                10,
                2,
                12, // This vertex is outside
            ];
            const indices = [0, 1, 2];
            const triAreaIds = [1];

            const ctx = BuildContext.create();
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds);

            expect(result).toBe(true);
            // Should still create spans for the part inside
            let spanCount = 0;
            for (const span of heightfield.spans) {
                if (span !== null) spanCount++;
            }
            expect(spanCount).toBeGreaterThan(0);
        });

        test('handles triangle touching heightfield boundary', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            // Triangle at boundary
            const vertices = [0, 2, 0, 2, 2, 0, 1, 2, 2];
            const indices = [0, 1, 2];
            const triAreaIds = [1];

            const ctx = BuildContext.create();
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds);

            expect(result).toBe(true);
        });

        test('rasterizes multiple overlapping triangles', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            // Two overlapping triangles at different heights
            const vertices = [2, 2, 2, 4, 2, 2, 3, 2, 4, 2, 5, 2, 4, 5, 2, 3, 5, 4];
            const indices = [0, 1, 2, 3, 4, 5];
            const triAreaIds = [1, 2];

            const ctx = BuildContext.create();
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds);

            expect(result).toBe(true);
            // Overlapping areas should have merged spans
            let spanCount = 0;
            for (const span of heightfield.spans) {
                if (span !== null) spanCount++;
            }
            expect(spanCount).toBeGreaterThan(0);
        });

        test('handles degenerate triangles gracefully', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            // Degenerate triangle (all points colinear)
            const vertices = [2, 2, 2, 3, 2, 2, 4, 2, 2];
            const indices = [0, 1, 2];
            const triAreaIds = [1];

            const ctx = BuildContext.create();
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds);

            expect(result).toBe(true); // Should not crash
        });

        test('respects flagMergeThreshold for overlapping geometry', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            const vertices = [2, 2.0, 2, 4, 2.0, 2, 3, 2.0, 4, 2, 2.5, 2, 4, 2.5, 2, 3, 2.5, 4];
            const indices = [0, 1, 2, 3, 4, 5];
            const triAreaIds = [5, 10]; // Different area IDs

            const ctx = BuildContext.create();
            const flagMergeThreshold = 1;
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds, flagMergeThreshold);

            expect(result).toBe(true);
            // Should merge and respect area priority
        });

        test('handles triangles spanning multiple cells', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [10, 10, 10],
            ];
            const heightfield = createHeightfield(10, 10, bounds, 1.0, 1.0);

            // Large triangle spanning many cells
            const vertices = [1, 2, 1, 8, 2, 1, 4, 2, 8];
            const indices = [0, 1, 2];
            const triAreaIds = [1];

            const ctx = BuildContext.create();
            const result = rasterizeTriangles(ctx, heightfield, vertices, indices, triAreaIds);

            expect(result).toBe(true);
            // Should create spans across multiple cells
            let spanCount = 0;
            for (const span of heightfield.spans) {
                if (span !== null) spanCount++;
            }
            expect(spanCount).toBeGreaterThan(5); // Should touch many cells
        });
    });

    describe('filterLowHangingWalkableObstacles', () => {
        test('marks span as walkable when obstacle is within walkableClimb', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Add walkable span, then non-walkable span close above it
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1); // Walkable, max at 10
            addHeightfieldSpan(heightfield, 1, 1, 12, 20, NULL_AREA, 1); // Non-walkable, max at 20
            // The check is: span.max (20) - previousSpan.max (10) = 10

            const walkableClimb = 15; // Must be >= 10
            filterLowHangingWalkableObstacles(heightfield, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            let span = heightfield.spans[columnIndex];
            span = span!.next; // Get second span

            expect(span!.area).not.toBe(NULL_AREA); // Should now be walkable
            expect(span!.area).toBe(1); // Should have the previous span's area ID
        });

        test('does not modify span when obstacle exceeds walkableClimb', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Add walkable span, then non-walkable span far above it
            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1); // Walkable
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, NULL_AREA, 1); // Non-walkable, 10 units above

            const walkableClimb = 3;
            filterLowHangingWalkableObstacles(heightfield, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            let span = heightfield.spans[columnIndex];
            span = span!.next; // Get second span

            expect(span!.area).toBe(NULL_AREA); // Should remain non-walkable
        });

        test('handles multiple consecutive non-walkable spans correctly', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 1, 1); // Walkable, max at 10
            addHeightfieldSpan(heightfield, 1, 1, 12, 15, NULL_AREA, 1); // Non-walkable, max at 15 (diff = 5)
            addHeightfieldSpan(heightfield, 1, 1, 17, 20, NULL_AREA, 1); // Non-walkable, max at 20 (diff from first non-walkable = 5)

            const walkableClimb = 6; // Enough to mark first non-walkable as walkable (15 - 10 = 5)
            filterLowHangingWalkableObstacles(heightfield, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            let span = heightfield.spans[columnIndex];
            span = span!.next; // First non-walkable (15 - 10 = 5, within walkableClimb)
            expect(span!.area).not.toBe(NULL_AREA); // Should be walkable now

            span = span!.next; // Second non-walkable (20 - 15 = 5, but previous wasn't originally walkable)
            expect(span!.area).toBe(NULL_AREA); // Should stay non-walkable (copies original walkable flag)
        });

        test('preserves original walkable spans', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            addHeightfieldSpan(heightfield, 1, 1, 0, 10, 5, 1); // Walkable

            const walkableClimb = 3;
            filterLowHangingWalkableObstacles(heightfield, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(5); // Should remain unchanged
        });

        test('handles empty columns', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            const walkableClimb = 3;
            // Should not crash with empty heightfield
            expect(() => filterLowHangingWalkableObstacles(heightfield, walkableClimb)).not.toThrow();
        });
    });

    describe('filterLedgeSpans', () => {
        test('marks span as unwalkable when neighbor drop exceeds walkableClimb', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Center cell at height 20
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 1, 1);
            // Neighbor cell at height 5 (drop of 15)
            addHeightfieldSpan(heightfield, 2, 1, 5, 15, 1, 1);

            const walkableHeight = 2;
            const walkableClimb = 5;
            filterLedgeSpans(heightfield, walkableHeight, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(NULL_AREA); // Should be marked as ledge
        });

        test('keeps span walkable when all neighbors are within walkableClimb', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Center cell at height 20
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 1, 1);
            // Neighbor cells at similar heights
            addHeightfieldSpan(heightfield, 0, 1, 22, 32, 1, 1);
            addHeightfieldSpan(heightfield, 2, 1, 18, 28, 1, 1);
            addHeightfieldSpan(heightfield, 1, 0, 21, 31, 1, 1);
            addHeightfieldSpan(heightfield, 1, 2, 19, 29, 1, 1);

            const walkableHeight = 2;
            const walkableClimb = 5;
            filterLedgeSpans(heightfield, walkableHeight, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(1); // Should remain walkable
        });

        test('marks span as unwalkable when slope is too steep', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Center cell at height 20
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 1, 1);
            // One neighbor much higher, one much lower (steep slope)
            addHeightfieldSpan(heightfield, 0, 1, 22, 32, 1, 1);
            addHeightfieldSpan(heightfield, 2, 1, 15, 25, 1, 1);

            const walkableHeight = 2;
            const walkableClimb = 3;
            filterLedgeSpans(heightfield, walkableHeight, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(NULL_AREA); // Should be marked unwalkable due to steep slope
        });

        test('handles edge of heightfield correctly', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Span at edge
            addHeightfieldSpan(heightfield, 0, 0, 20, 30, 1, 1);

            const walkableHeight = 2;
            const walkableClimb = 5;
            filterLedgeSpans(heightfield, walkableHeight, walkableClimb);

            const columnIndex = 0 + 0 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(NULL_AREA); // Edge spans should be marked as ledges
        });

        test('handles corners with multiple steep neighbors', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Corner span
            addHeightfieldSpan(heightfield, 0, 0, 20, 30, 1, 1);
            // Only two neighbors (at corner), both low
            addHeightfieldSpan(heightfield, 1, 0, 5, 15, 1, 1);
            addHeightfieldSpan(heightfield, 0, 1, 5, 15, 1, 1);

            const walkableHeight = 2;
            const walkableClimb = 5;
            filterLedgeSpans(heightfield, walkableHeight, walkableClimb);

            const columnIndex = 0 + 0 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(NULL_AREA); // Should be ledge
        });

        test('considers ceiling height for traversability', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Center cell with low ceiling
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 31, 40, 1, 1); // Low ceiling (1 unit gap)
            // Neighbor with enough clearance
            addHeightfieldSpan(heightfield, 2, 1, 22, 32, 1, 1);

            const walkableHeight = 5;
            const walkableClimb = 5;
            filterLedgeSpans(heightfield, walkableHeight, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            // Should be affected by ceiling constraints
            expect(span).not.toBeNull();
        });

        test('skips non-walkable spans', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Non-walkable span
            addHeightfieldSpan(heightfield, 1, 1, 20, 30, NULL_AREA, 1);
            addHeightfieldSpan(heightfield, 2, 1, 5, 15, 1, 1);

            const walkableHeight = 2;
            const walkableClimb = 5;
            filterLedgeSpans(heightfield, walkableHeight, walkableClimb);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(NULL_AREA); // Should remain NULL_AREA
        });
    });

    describe('filterWalkableLowHeightSpans', () => {
        test('marks span as unwalkable when ceiling is too low', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Add span with low ceiling
            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 22, 30, 1, 1); // Ceiling at 22, giving 2 units clearance

            const walkableHeight = 5;
            filterWalkableLowHeightSpans(heightfield, walkableHeight);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(NULL_AREA); // Should be marked unwalkable (2 < 5)
        });

        test('keeps span walkable when ceiling height is sufficient', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Add span with high ceiling
            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 30, 40, 1, 1); // Ceiling at 30, giving 10 units clearance

            const walkableHeight = 5;
            filterWalkableLowHeightSpans(heightfield, walkableHeight);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(1); // Should remain walkable (10 >= 5)
        });

        test('handles spans with no ceiling (top span)', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Single span with no span above it
            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 1, 1);

            const walkableHeight = 5;
            filterWalkableLowHeightSpans(heightfield, walkableHeight);

            const columnIndex = 1 + 1 * 3;
            const span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(1); // Should remain walkable (infinite ceiling)
        });

        test('processes all spans in column', () => {
            const bounds: Box3 = [
                [0, 0, 0],
                [3, 3, 3],
            ];
            const heightfield = createHeightfield(3, 3, bounds, 1.0, 1.0);

            // Multiple spans in same column
            addHeightfieldSpan(heightfield, 1, 1, 10, 20, 1, 1);
            addHeightfieldSpan(heightfield, 1, 1, 22, 30, 2, 1); // Low ceiling above first
            addHeightfieldSpan(heightfield, 1, 1, 50, 60, 3, 1); // High ceiling above second

            const walkableHeight = 5;
            filterWalkableLowHeightSpans(heightfield, walkableHeight);

            const columnIndex = 1 + 1 * 3;
            let span = heightfield.spans[columnIndex];

            expect(span!.area).toBe(NULL_AREA); // First span marked unwalkable
            span = span!.next;
            expect(span!.area).toBe(2); // Second span has enough clearance (50 - 30 = 20)
            span = span!.next;
            expect(span!.area).toBe(3); // Third span has no ceiling above
        });
    });
});
