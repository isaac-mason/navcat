import { type Box3, box3, clamp, type Vec2, type Vec3, vec3 } from 'mathcat';
import { BuildContext, type BuildContextState } from './build-context';
import { type ArrayLike, AXIS_X, AXIS_Z, getDirOffsetX, getDirOffsetY, NULL_AREA } from './common';

export type HeightfieldSpan = {
    /** the lower limit of the span */
    min: number;
    /** the upper limit of the span */
    max: number;
    /** the area id assigned to the span */
    area: number;
    /** the next heightfield span */
    next: HeightfieldSpan | null;
};

export type Heightfield = {
    /** the width of the heightfield (along x axis in cell units) */
    width: number;
    /** the height of the heightfield (along z axis in cell units) */
    height: number;
    /** the bounds in world space */
    bounds: Box3;
    /** the vertical size of each cell (minimum increment along y) */
    cellHeight: number;
    /** the vertical size of each cell (minimum increment along x and z) */
    cellSize: number;
    /** the heightfield of spans, (width*height) */
    spans: (HeightfieldSpan | null)[];
};

const SPAN_MAX_HEIGHT = 0x1fff; // 8191
const MAX_HEIGHTFIELD_HEIGHT = 0xffff;

export const calculateGridSize = (outGridSize: Vec2, bounds: Box3, cellSize: number): [width: number, height: number] => {
    outGridSize[0] = Math.floor((bounds[3] - bounds[0]) / cellSize + 0.5);
    outGridSize[1] = Math.floor((bounds[5] - bounds[2]) / cellSize + 0.5);

    return outGridSize;
};

export const createHeightfield = (
    width: number,
    height: number,
    bounds: Box3,
    cellSize: number,
    cellHeight: number,
): Heightfield => {
    const numSpans = width * height;

    const spans: (HeightfieldSpan | null)[] = new Array(numSpans).fill(null);

    return {
        width,
        height,
        spans,
        bounds,
        cellHeight,
        cellSize,
    };
};

/**
 * Adds a span to the heightfield. If the new span overlaps existing spans,
 * it will merge the new span with the existing ones.
 */
export const addHeightfieldSpan = (
    heightfield: Heightfield,
    x: number,
    z: number,
    min: number,
    max: number,
    areaID: number,
    flagMergeThreshold: number,
): boolean => {
    // Create the new span
    const newSpan: HeightfieldSpan = {
        min,
        max,
        area: areaID,
        next: null,
    };

    const columnIndex = x + z * heightfield.width;
    let previousSpan: HeightfieldSpan | null = null;
    let currentSpan = heightfield.spans[columnIndex];

    // Insert the new span, possibly merging it with existing spans
    while (currentSpan !== null) {
        if (currentSpan.min > newSpan.max) {
            // Current span is completely after the new span, break
            break;
        }

        if (currentSpan.max < newSpan.min) {
            // Current span is completely before the new span. Keep going
            previousSpan = currentSpan;
            currentSpan = currentSpan.next;
        } else {
            // The new span overlaps with an existing span. Merge them
            if (currentSpan.min < newSpan.min) {
                newSpan.min = currentSpan.min;
            }
            if (currentSpan.max > newSpan.max) {
                newSpan.max = currentSpan.max;
            }

            // Merge flags
            if (Math.abs(newSpan.max - currentSpan.max) <= flagMergeThreshold) {
                // Higher area ID numbers indicate higher resolution priority
                newSpan.area = Math.max(newSpan.area, currentSpan.area);
            }

            // Remove the current span since it's now merged with newSpan
            const next = currentSpan.next;
            if (previousSpan) {
                previousSpan.next = next;
            } else {
                heightfield.spans[columnIndex] = next;
            }
            currentSpan = next;
        }
    }

    // Insert new span after prev
    if (previousSpan !== null) {
        newSpan.next = previousSpan.next;
        previousSpan.next = newSpan;
    } else {
        // This span should go before the others in the list
        newSpan.next = heightfield.spans[columnIndex];
        heightfield.spans[columnIndex] = newSpan;
    }

    return true;
};

/**
 * Divides a convex polygon of max 12 vertices into two convex polygons
 * across a separating axis.
 */
const dividePoly = (
    out: { nv1: number; nv2: number },
    inVerts: number[],
    inVertsCount: number,
    outVerts1: number[],
    outVerts2: number[],
    axisOffset: number,
    axis: number,
): void => {
    // How far positive or negative away from the separating axis is each vertex
    const inVertAxisDelta = _inVertAxisDelta;
    for (let inVert = 0; inVert < inVertsCount; ++inVert) {
        inVertAxisDelta[inVert] = axisOffset - inVerts[inVert * 3 + axis];
    }

    let poly1Vert = 0;
    let poly2Vert = 0;

    for (let inVertA = 0, inVertB = inVertsCount - 1; inVertA < inVertsCount; inVertB = inVertA, ++inVertA) {
        // If the two vertices are on the same side of the separating axis
        const sameSide = inVertAxisDelta[inVertA] >= 0 === inVertAxisDelta[inVertB] >= 0;

        if (!sameSide) {
            const s = inVertAxisDelta[inVertB] / (inVertAxisDelta[inVertB] - inVertAxisDelta[inVertA]);
            outVerts1[poly1Vert * 3 + 0] = inVerts[inVertB * 3 + 0] + (inVerts[inVertA * 3 + 0] - inVerts[inVertB * 3 + 0]) * s;
            outVerts1[poly1Vert * 3 + 1] = inVerts[inVertB * 3 + 1] + (inVerts[inVertA * 3 + 1] - inVerts[inVertB * 3 + 1]) * s;
            outVerts1[poly1Vert * 3 + 2] = inVerts[inVertB * 3 + 2] + (inVerts[inVertA * 3 + 2] - inVerts[inVertB * 3 + 2]) * s;

            // Copy to second polygon
            outVerts2[poly2Vert * 3 + 0] = outVerts1[poly1Vert * 3 + 0];
            outVerts2[poly2Vert * 3 + 1] = outVerts1[poly1Vert * 3 + 1];
            outVerts2[poly2Vert * 3 + 2] = outVerts1[poly1Vert * 3 + 2];

            poly1Vert++;
            poly2Vert++;

            // Add the inVertA point to the right polygon. Do NOT add points that are on the dividing line
            // since these were already added above
            if (inVertAxisDelta[inVertA] > 0) {
                outVerts1[poly1Vert * 3 + 0] = inVerts[inVertA * 3 + 0];
                outVerts1[poly1Vert * 3 + 1] = inVerts[inVertA * 3 + 1];
                outVerts1[poly1Vert * 3 + 2] = inVerts[inVertA * 3 + 2];
                poly1Vert++;
            } else if (inVertAxisDelta[inVertA] < 0) {
                outVerts2[poly2Vert * 3 + 0] = inVerts[inVertA * 3 + 0];
                outVerts2[poly2Vert * 3 + 1] = inVerts[inVertA * 3 + 1];
                outVerts2[poly2Vert * 3 + 2] = inVerts[inVertA * 3 + 2];
                poly2Vert++;
            }
        } else {
            // Add the inVertA point to the right polygon. Addition is done even for points on the dividing line
            if (inVertAxisDelta[inVertA] >= 0) {
                outVerts1[poly1Vert * 3 + 0] = inVerts[inVertA * 3 + 0];
                outVerts1[poly1Vert * 3 + 1] = inVerts[inVertA * 3 + 1];
                outVerts1[poly1Vert * 3 + 2] = inVerts[inVertA * 3 + 2];
                poly1Vert++;
                if (inVertAxisDelta[inVertA] !== 0) {
                    continue;
                }
            }
            outVerts2[poly2Vert * 3 + 0] = inVerts[inVertA * 3 + 0];
            outVerts2[poly2Vert * 3 + 1] = inVerts[inVertA * 3 + 1];
            outVerts2[poly2Vert * 3 + 2] = inVerts[inVertA * 3 + 2];
            poly2Vert++;
        }
    }

    out.nv1 = poly1Vert;
    out.nv2 = poly2Vert;
};

const _triangleBounds = box3.create();
const _rasterize_triMin = vec3.create();
const _rasterize_triMax = vec3.create();

const _inVerts = new Array(7 * 3);
const _inRow = new Array(7 * 3);
const _p1 = new Array(7 * 3);
const _p2 = new Array(7 * 3);

const _inVertAxisDelta = new Array(12);
const _dividePolyResult = { nv1: 0, nv2: 0 };

const _v0 = vec3.create();
const _v1 = vec3.create();
const _v2 = vec3.create();

/**
 * Rasterize a single triangle to the heightfield
 */
const rasterizeTriangle = (
    v0: Vec3,
    v1: Vec3,
    v2: Vec3,
    areaID: number,
    heightfield: Heightfield,
    flagMergeThreshold: number,
): boolean => {
    // Calculate the bounding box of the triangle
    vec3.copy(_rasterize_triMin, v0);
    vec3.min(_rasterize_triMin, _rasterize_triMin, v1);
    vec3.min(_rasterize_triMin, _rasterize_triMin, v2);

    vec3.copy(_rasterize_triMax, v0);
    vec3.max(_rasterize_triMax, _rasterize_triMax, v1);
    vec3.max(_rasterize_triMax, _rasterize_triMax, v2);

    box3.set(
        _triangleBounds,
        _rasterize_triMin[0],
        _rasterize_triMin[1],
        _rasterize_triMin[2],
        _rasterize_triMax[0],
        _rasterize_triMax[1],
        _rasterize_triMax[2],
    );

    // If the triangle does not touch the bounding box of the heightfield, skip the triangle
    if (!box3.intersectsBox3(_triangleBounds, heightfield.bounds)) {
        return true;
    }

    const w = heightfield.width;
    const h = heightfield.height;
    const by = heightfield.bounds[4] - heightfield.bounds[1];
    const cellSize = heightfield.cellSize;
    const cellHeight = heightfield.cellHeight;
    const inverseCellSize = 1.0 / cellSize;
    const inverseCellHeight = 1.0 / cellHeight;

    // Calculate the footprint of the triangle on the grid's z-axis
    let z0 = Math.floor((_rasterize_triMin[2] - heightfield.bounds[2]) * inverseCellSize);
    let z1 = Math.floor((_rasterize_triMax[2] - heightfield.bounds[2]) * inverseCellSize);

    // Use -1 rather than 0 to cut the polygon properly at the start of the tile
    z0 = clamp(z0, -1, h - 1);
    z1 = clamp(z1, 0, h - 1);

    // Clip the triangle into all grid cells it touches
    let inVerts = _inVerts;
    let inRow = _inRow;
    let p1 = _p1;
    let p2 = _p2;

    // Copy triangle vertices
    inVerts[0] = v0[0];
    inVerts[1] = v0[1];
    inVerts[2] = v0[2];
    inVerts[3] = v1[0];
    inVerts[4] = v1[1];
    inVerts[5] = v1[2];
    inVerts[6] = v2[0];
    inVerts[7] = v2[1];
    inVerts[8] = v2[2];

    let nvIn = 3;

    for (let z = z0; z <= z1; ++z) {
        // Clip polygon to row. Store the remaining polygon as well
        const cellZ = heightfield.bounds[2] + z * cellSize;
        dividePoly(_dividePolyResult, inVerts, nvIn, inRow, p1, cellZ + cellSize, AXIS_Z);
        const nvRow = _dividePolyResult.nv1;
        const nvIn2 = _dividePolyResult.nv2;

        // Swap arrays
        const temp = inVerts;
        inVerts = p1;
        p1 = temp;
        nvIn = nvIn2;

        if (nvRow < 3) {
            continue;
        }
        if (z < 0) {
            continue;
        }

        // Find X-axis bounds of the row
        let minX = inRow[0];
        let maxX = inRow[0];
        for (let vert = 1; vert < nvRow; ++vert) {
            if (minX > inRow[vert * 3]) {
                minX = inRow[vert * 3];
            }
            if (maxX < inRow[vert * 3]) {
                maxX = inRow[vert * 3];
            }
        }

        let x0 = Math.floor((minX - heightfield.bounds[0]) * inverseCellSize);
        let x1 = Math.floor((maxX - heightfield.bounds[0]) * inverseCellSize);
        if (x1 < 0 || x0 >= w) {
            continue;
        }
        x0 = clamp(x0, -1, w - 1);
        x1 = clamp(x1, 0, w - 1);

        let nv2 = nvRow;

        for (let x = x0; x <= x1; ++x) {
            // Clip polygon to column. Store the remaining polygon as well
            const cx = heightfield.bounds[0] + x * cellSize;
            dividePoly(_dividePolyResult, inRow, nv2, p1, p2, cx + cellSize, AXIS_X);
            const nv = _dividePolyResult.nv1;
            const nv2New = _dividePolyResult.nv2;

            // Swap arrays
            const temp = inRow;
            inRow = p2;
            p2 = temp;
            nv2 = nv2New;

            if (nv < 3) {
                continue;
            }
            if (x < 0) {
                continue;
            }

            // Calculate min and max of the span
            let spanMin = p1[1];
            let spanMax = p1[1];
            for (let vert = 1; vert < nv; ++vert) {
                spanMin = Math.min(spanMin, p1[vert * 3 + 1]);
                spanMax = Math.max(spanMax, p1[vert * 3 + 1]);
            }
            spanMin -= heightfield.bounds[1];
            spanMax -= heightfield.bounds[1];

            // Skip the span if it's completely outside the heightfield bounding box
            if (spanMax < 0.0) {
                continue;
            }
            if (spanMin > by) {
                continue;
            }

            // Clamp the span to the heightfield bounding box
            if (spanMin < 0.0) {
                spanMin = 0;
            }
            if (spanMax > by) {
                spanMax = by;
            }

            // Snap the span to the heightfield height grid
            const spanMinCellIndex = clamp(Math.floor(spanMin * inverseCellHeight), 0, SPAN_MAX_HEIGHT);
            const spanMaxCellIndex = clamp(Math.ceil(spanMax * inverseCellHeight), spanMinCellIndex + 1, SPAN_MAX_HEIGHT);

            if (!addHeightfieldSpan(heightfield, x, z, spanMinCellIndex, spanMaxCellIndex, areaID, flagMergeThreshold)) {
                return false;
            }
        }
    }

    return true;
};

export const rasterizeTriangles = (
    ctx: BuildContextState,
    heightfield: Heightfield,
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>,
    triAreaIds: ArrayLike<number>,
    flagMergeThreshold = 1,
) => {
    const numTris = indices.length / 3;

    for (let triIndex = 0; triIndex < numTris; ++triIndex) {
        const i0 = indices[triIndex * 3 + 0];
        const i1 = indices[triIndex * 3 + 1];
        const i2 = indices[triIndex * 3 + 2];

        const v0 = vec3.fromBuffer(_v0, vertices, i0 * 3);
        const v1 = vec3.fromBuffer(_v1, vertices, i1 * 3);
        const v2 = vec3.fromBuffer(_v2, vertices, i2 * 3);

        const areaId = triAreaIds[triIndex];

        if (!rasterizeTriangle(v0, v1, v2, areaId, heightfield, flagMergeThreshold)) {
            BuildContext.error(ctx, 'Failed to rasterize triangle');
            return false;
        }
    }

    return true;
};

export const filterLowHangingWalkableObstacles = (heightfield: Heightfield, walkableClimb: number) => {
    const xSize = heightfield.width;
    const zSize = heightfield.height;

    for (let z = 0; z < zSize; ++z) {
        for (let x = 0; x < xSize; ++x) {
            let previousSpan: HeightfieldSpan | null = null;
            let previousWasWalkable = false;
            let previousAreaID = NULL_AREA;

            // For each span in the column...
            const columnIndex = x + z * xSize;
            let span = heightfield.spans[columnIndex];

            while (span !== null) {
                const walkable = span.area !== NULL_AREA;

                // If current span is not walkable, but there is walkable span just below it and the height difference
                // is small enough for the agent to walk over, mark the current span as walkable too.
                if (!walkable && previousWasWalkable && previousSpan && span.max - previousSpan.max <= walkableClimb) {
                    span.area = previousAreaID;
                }

                // Copy the original walkable value regardless of whether we changed it.
                // This prevents multiple consecutive non-walkable spans from being erroneously marked as walkable.
                previousWasWalkable = walkable;
                previousAreaID = span.area;
                previousSpan = span;
                span = span.next;
            }
        }
    }
};

export const filterLedgeSpans = (heightfield: Heightfield, walkableHeight: number, walkableClimb: number) => {
    const xSize = heightfield.width;
    const zSize = heightfield.height;

    // Mark spans that are adjacent to a ledge as unwalkable
    for (let z = 0; z < zSize; ++z) {
        for (let x = 0; x < xSize; ++x) {
            const columnIndex = x + z * xSize;
            let span = heightfield.spans[columnIndex];

            while (span !== null) {
                // Skip non-walkable spans
                if (span.area === NULL_AREA) {
                    span = span.next;
                    continue;
                }

                const floor = span.max;
                const ceiling = span.next ? span.next.min : MAX_HEIGHTFIELD_HEIGHT;

                // The difference between this walkable area and the lowest neighbor walkable area.
                // This is the difference between the current span and all neighbor spans that have
                // enough space for an agent to move between, but not accounting at all for surface slope.
                let lowestNeighborFloorDifference = MAX_HEIGHTFIELD_HEIGHT;

                // Min and max height of accessible neighbours.
                let lowestTraversableNeighborFloor = span.max;
                let highestTraversableNeighborFloor = span.max;

                for (let direction = 0; direction < 4; ++direction) {
                    const neighborX = x + getDirOffsetX(direction);
                    const neighborZ = z + getDirOffsetY(direction);

                    // Skip neighbours which are out of bounds.
                    if (neighborX < 0 || neighborZ < 0 || neighborX >= xSize || neighborZ >= zSize) {
                        lowestNeighborFloorDifference = -walkableClimb - 1;
                        break;
                    }

                    const neighborColumnIndex = neighborX + neighborZ * xSize;
                    let neighborSpan = heightfield.spans[neighborColumnIndex];

                    // The most we can step down to the neighbor is the walkableClimb distance.
                    // Start with the area under the neighbor span
                    let neighborCeiling = neighborSpan ? neighborSpan.min : MAX_HEIGHTFIELD_HEIGHT;

                    // Skip neighbour if the gap between the spans is too small.
                    if (Math.min(ceiling, neighborCeiling) - floor >= walkableHeight) {
                        lowestNeighborFloorDifference = -walkableClimb - 1;
                        break;
                    }

                    // For each span in the neighboring column...
                    while (neighborSpan !== null) {
                        const neighborFloor = neighborSpan.max;
                        neighborCeiling = neighborSpan.next ? neighborSpan.next.min : MAX_HEIGHTFIELD_HEIGHT;

                        // Only consider neighboring areas that have enough overlap to be potentially traversable.
                        if (Math.min(ceiling, neighborCeiling) - Math.max(floor, neighborFloor) < walkableHeight) {
                            // No space to traverse between them.
                            neighborSpan = neighborSpan.next;
                            continue;
                        }

                        const neighborFloorDifference = neighborFloor - floor;
                        lowestNeighborFloorDifference = Math.min(lowestNeighborFloorDifference, neighborFloorDifference);

                        // Find min/max accessible neighbor height.
                        // Only consider neighbors that are at most walkableClimb away.
                        if (Math.abs(neighborFloorDifference) <= walkableClimb) {
                            // There is space to move to the neighbor cell and the slope isn't too much.
                            lowestTraversableNeighborFloor = Math.min(lowestTraversableNeighborFloor, neighborFloor);
                            highestTraversableNeighborFloor = Math.max(highestTraversableNeighborFloor, neighborFloor);
                        } else if (neighborFloorDifference < -walkableClimb) {
                            // We already know this will be considered a ledge span so we can early-out
                            break;
                        }

                        neighborSpan = neighborSpan.next;
                    }
                }

                // The current span is close to a ledge if the magnitude of the drop to any neighbour span is greater than the walkableClimb distance.
                // That is, there is a gap that is large enough to let an agent move between them, but the drop (surface slope) is too large to allow it.
                if (lowestNeighborFloorDifference < -walkableClimb) {
                    span.area = NULL_AREA;
                }
                // If the difference between all neighbor floors is too large, this is a steep slope, so mark the span as an unwalkable ledge.
                else if (highestTraversableNeighborFloor - lowestTraversableNeighborFloor > walkableClimb) {
                    span.area = NULL_AREA;
                }

                span = span.next;
            }
        }
    }
};

export const filterWalkableLowHeightSpans = (heightfield: Heightfield, walkableHeight: number) => {
    const xSize = heightfield.width;
    const zSize = heightfield.height;

    // Remove walkable flag from spans which do not have enough
    // space above them for the agent to stand there.
    for (let z = 0; z < zSize; ++z) {
        for (let x = 0; x < xSize; ++x) {
            const columnIndex = x + z * xSize;
            let span = heightfield.spans[columnIndex];

            while (span !== null) {
                const floor = span.max;
                const ceiling = span.next ? span.next.min : MAX_HEIGHTFIELD_HEIGHT;

                if (ceiling - floor < walkableHeight) {
                    span.area = NULL_AREA;
                }

                span = span.next;
            }
        }
    }
};

const EPSILON: number = 0.00001;
const BOX_EDGES: number[] = [0, 1, 0, 2, 0, 4, 1, 3, 1, 5, 2, 3, 2, 6, 3, 7, 4, 5, 4, 6, 5, 7, 6, 7];

const _rasterize_bounds: Box3 = [0, 0, 0, 0, 0, 0];

export function rasterizeSphere(
    hf: Heightfield,
    center: Vec3,
    radius: number,
    area: number,
    flagMergeThr: number,
    ctx: BuildContextState,
): void {
    BuildContext.start(ctx, 'RASTERIZE_SPHERE');
    _rasterize_bounds[0] = center[0] - radius;
    _rasterize_bounds[1] = center[1] - radius;
    _rasterize_bounds[2] = center[2] - radius;
    _rasterize_bounds[3] = center[0] + radius;
    _rasterize_bounds[4] = center[1] + radius;
    _rasterize_bounds[5] = center[2] + radius;
    rasterizationFilledShape(hf, _rasterize_bounds, area, flagMergeThr, (rectangle) =>
        intersectSphere(rectangle, center, radius * radius),
    );
    BuildContext.end(ctx, 'RASTERIZE_SPHERE');
}

export function rasterizeCapsule(
    hf: Heightfield,
    start: Vec3,
    finish: Vec3,
    radius: number,
    area: number,
    flagMergeThr: number,
    ctx: BuildContextState,
): void {
    BuildContext.start(ctx, 'RASTERIZE_CAPSULE');
    _rasterize_bounds[0] = Math.min(start[0], finish[0]) - radius;
    _rasterize_bounds[1] = Math.min(start[1], finish[1]) - radius;
    _rasterize_bounds[2] = Math.min(start[2], finish[2]) - radius;
    _rasterize_bounds[3] = Math.max(start[0], finish[0]) + radius;
    _rasterize_bounds[4] = Math.max(start[1], finish[1]) + radius;
    _rasterize_bounds[5] = Math.max(start[2], finish[2]) + radius;
    const axis: Vec3 = [finish[0] - start[0], finish[1] - start[1], finish[2] - start[2]];
    rasterizationFilledShape(hf, _rasterize_bounds, area, flagMergeThr, (rectangle) =>
        intersectCapsule(rectangle, start, finish, axis, radius * radius),
    );
    BuildContext.end(ctx, 'RASTERIZE_CAPSULE');
}

export function rasterizeCylinder(
    hf: Heightfield,
    start: Vec3,
    finish: Vec3,
    radius: number,
    area: number,
    flagMergeThr: number,
    ctx: BuildContextState,
): void {
    BuildContext.start(ctx, 'RASTERIZE_CYLINDER');
    _rasterize_bounds[0] = Math.min(start[0], finish[0]) - radius;
    _rasterize_bounds[1] = Math.min(start[1], finish[1]) - radius;
    _rasterize_bounds[2] = Math.min(start[2], finish[2]) - radius;
    _rasterize_bounds[3] = Math.max(start[0], finish[0]) + radius;
    _rasterize_bounds[4] = Math.max(start[1], finish[1]) + radius;
    _rasterize_bounds[5] = Math.max(start[2], finish[2]) + radius;
    const axis: Vec3 = [finish[0] - start[0], finish[1] - start[1], finish[2] - start[2]];
    rasterizationFilledShape(hf, _rasterize_bounds, area, flagMergeThr, (rectangle) =>
        intersectCylinder(rectangle, start, finish, axis, radius * radius),
    );
    BuildContext.end(ctx, 'RASTERIZE_CYLINDER');
}

export function rasterizeBox(
    hf: Heightfield,
    center: Vec3,
    halfEdges: Vec3[],
    area: number,
    flagMergeThr: number,
    ctx: BuildContextState,
): void {
    BuildContext.start(ctx, 'RASTERIZE_BOX');
    const normals: Vec3[] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    vec3.normalize(normals[0], halfEdges[0]);
    vec3.normalize(normals[1], halfEdges[1]);
    vec3.normalize(normals[2], halfEdges[2]);

    const vertices = new Array<number>(8 * 3);
    const bounds: Box3 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; ++i) {
        const s0 = (i & 1) !== 0 ? 1 : -1;
        const s1 = (i & 2) !== 0 ? 1 : -1;
        const s2 = (i & 4) !== 0 ? 1 : -1;
        vertices[i * 3 + 0] = center[0] + s0 * halfEdges[0][0] + s1 * halfEdges[1][0] + s2 * halfEdges[2][0];
        vertices[i * 3 + 1] = center[1] + s0 * halfEdges[0][1] + s1 * halfEdges[1][1] + s2 * halfEdges[2][1];
        vertices[i * 3 + 2] = center[2] + s0 * halfEdges[0][2] + s1 * halfEdges[1][2] + s2 * halfEdges[2][2];
        bounds[0] = Math.min(bounds[0], vertices[i * 3 + 0]);
        bounds[1] = Math.min(bounds[1], vertices[i * 3 + 1]);
        bounds[2] = Math.min(bounds[2], vertices[i * 3 + 2]);
        bounds[3] = Math.max(bounds[3], vertices[i * 3 + 0]);
        bounds[4] = Math.max(bounds[4], vertices[i * 3 + 1]);
        bounds[5] = Math.max(bounds[5], vertices[i * 3 + 2]);
    }
    const planes = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ];
    for (let i = 0; i < 6; i++) {
        const m = i < 3 ? -1 : 1;
        const vi = i < 3 ? 0 : 7;
        planes[i][0] = m * normals[i % 3][0];
        planes[i][1] = m * normals[i % 3][1];
        planes[i][2] = m * normals[i % 3][2];
        planes[i][3] =
            vertices[vi * 3] * planes[i][0] + vertices[vi * 3 + 1] * planes[i][1] + vertices[vi * 3 + 2] * planes[i][2];
    }
    rasterizationFilledShape(hf, bounds, area, flagMergeThr, (rectangle) => intersectBox(rectangle, vertices, planes));
    BuildContext.end(ctx, 'RASTERIZE_BOX');
}

function plane(planes: number[][], planeIdx: number, v1: number[], v2: number[], vertices: number[], vert: number): void {
    vec3.cross(planes[planeIdx] as Vec3, v1 as Vec3, v2 as Vec3);
    planes[planeIdx][3] =
        planes[planeIdx][0] * vertices[vert] +
        planes[planeIdx][1] * vertices[vert + 1] +
        planes[planeIdx][2] * vertices[vert + 2];
}

export function rasterizeConvex(
    hf: Heightfield,
    vertices: number[],
    triangles: number[],
    area: number,
    flagMergeThr: number,
    ctx: BuildContextState,
): void {
    BuildContext.start(ctx, 'RASTERIZE_CONVEX');
    const bounds: Box3 = [vertices[0], vertices[1], vertices[2], vertices[0], vertices[1], vertices[2]];
    for (let i = 0; i < vertices.length; i += 3) {
        bounds[0] = Math.min(bounds[0], vertices[i + 0]);
        bounds[1] = Math.min(bounds[1], vertices[i + 1]);
        bounds[2] = Math.min(bounds[2], vertices[i + 2]);
        bounds[3] = Math.max(bounds[3], vertices[i + 0]);
        bounds[4] = Math.max(bounds[4], vertices[i + 1]);
        bounds[5] = Math.max(bounds[5], vertices[i + 2]);
    }
    const planes: number[][] = [];
    const triBounds: number[][] = [];
    for (let j = 0; j < triangles.length; j += 3) {
        const a = triangles[j] * 3;
        const b = triangles[j + 1] * 3;
        const c = triangles[j + 2] * 3;
        const e: Vec3 = [0, 0, 0];
        const f: Vec3 = [0, 0, 0];
        e[0] = vertices[b] - vertices[a];
        e[1] = vertices[b + 1] - vertices[a + 1];
        e[2] = vertices[b + 2] - vertices[a + 2];
        f[0] = vertices[c] - vertices[a];
        f[1] = vertices[c + 1] - vertices[a + 1];
        f[2] = vertices[c + 2] - vertices[a + 2];
        planes.push([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
        const planeIdx = j;
        plane(planes, planeIdx, e, f, vertices, a);
        f[0] = vertices[c] - vertices[b];
        f[1] = vertices[c + 1] - vertices[b + 1];
        f[2] = vertices[c + 2] - vertices[b + 2];
        plane(planes, planeIdx + 1, planes[planeIdx], f, vertices, b);
        f[0] = vertices[a] - vertices[c];
        f[1] = vertices[a + 1] - vertices[c + 1];
        f[2] = vertices[a + 2] - vertices[c + 2];
        plane(planes, planeIdx + 2, planes[planeIdx], f, vertices, c);

        let s =
            1.0 /
            (vertices[a] * planes[planeIdx + 1][0] +
                vertices[a + 1] * planes[planeIdx + 1][1] +
                vertices[a + 2] * planes[planeIdx + 1][2] -
                planes[planeIdx + 1][3]);
        planes[planeIdx + 1][0] *= s;
        planes[planeIdx + 1][1] *= s;
        planes[planeIdx + 1][2] *= s;
        planes[planeIdx + 1][3] *= s;

        s =
            1.0 /
            (vertices[b] * planes[planeIdx + 2][0] +
                vertices[b + 1] * planes[planeIdx + 2][1] +
                vertices[b + 2] * planes[planeIdx + 2][2] -
                planes[planeIdx + 2][3]);
        planes[planeIdx + 2][0] *= s;
        planes[planeIdx + 2][1] *= s;
        planes[planeIdx + 2][2] *= s;
        planes[planeIdx + 2][3] *= s;

        triBounds.push([0, 0, 0, 0]);
        const tb = planeIdx / 3;
        triBounds[tb][0] = Math.min(Math.min(vertices[a], vertices[b]), vertices[c]);
        triBounds[tb][1] = Math.min(Math.min(vertices[a + 1], vertices[b + 1]), vertices[c + 1]);
        triBounds[tb][2] = Math.max(Math.max(vertices[a], vertices[b]), vertices[c]);
        triBounds[tb][3] = Math.max(Math.max(vertices[a + 1], vertices[b + 1]), vertices[c + 1]);
    }
    rasterizationFilledShape(hf, bounds, area, flagMergeThr, (rectangle) =>
        intersectConvex(rectangle, triangles, vertices, planes, triBounds),
    );
    BuildContext.end(ctx, 'RASTERIZE_CONVEX');
}

function overlapBounds(amin: Vec3, amax: Vec3, bounds: Box3): boolean {
    let overlap = true;
    overlap = amin[0] > bounds[3] || amax[0] < bounds[0] ? false : overlap;
    overlap = amin[1] > bounds[4] ? false : overlap;
    overlap = amin[2] > bounds[5] || amax[2] < bounds[2] ? false : overlap;
    return overlap;
}

function rasterizationFilledShape(
    hf: Heightfield,
    bounds: Box3,
    area: number,
    flagMergeThr: number,
    intersection: (rectangle: number[]) => Vec2 | undefined,
): void {
    if (!overlapBounds([hf.bounds[0], hf.bounds[1], hf.bounds[2]], [hf.bounds[3], hf.bounds[4], hf.bounds[5]], bounds)) {
        return;
    }

    bounds[3] = Math.min(bounds[3], hf.bounds[3]);
    bounds[5] = Math.min(bounds[5], hf.bounds[5]);
    bounds[0] = Math.max(bounds[0], hf.bounds[0]);
    bounds[2] = Math.max(bounds[2], hf.bounds[2]);

    if (bounds[3] <= bounds[0] || bounds[4] <= bounds[1] || bounds[5] <= bounds[2]) {
        return;
    }
    const ics = 1.0 / hf.cellSize;
    const ich = 1.0 / hf.cellHeight;
    const xMin = Math.round((bounds[0] - hf.bounds[0]) * ics);
    const zMin = Math.round((bounds[2] - hf.bounds[2]) * ics);
    const xMax = Math.min(hf.width - 1, Math.round((bounds[3] - hf.bounds[0]) * ics));
    const zMax = Math.min(hf.height - 1, Math.round((bounds[5] - hf.bounds[2]) * ics));
    const rectangle = [0, 0, 0, 0, 0];
    rectangle[4] = hf.bounds[1];
    for (let x = xMin; x <= xMax; x++) {
        for (let z = zMin; z <= zMax; z++) {
            rectangle[0] = x * hf.cellSize + hf.bounds[0];
            rectangle[1] = z * hf.cellSize + hf.bounds[2];
            rectangle[2] = rectangle[0] + hf.cellSize;
            rectangle[3] = rectangle[1] + hf.cellSize;
            const h = intersection(rectangle);
            if (h !== undefined) {
                const smin = Math.floor((h[0] - hf.bounds[1]) * ich);
                const smax = Math.ceil((h[1] - hf.bounds[1]) * ich);
                if (smin !== smax) {
                    const ismin = clamp(smin, 0, SPAN_MAX_HEIGHT);
                    const ismax = clamp(smax, ismin + 1, SPAN_MAX_HEIGHT);
                    addHeightfieldSpan(hf, x, z, ismin, ismax, area, flagMergeThr);
                }
            }
        }
    }
}

function lenSqr(dx: number, dy: number, dz: number): number {
    return dx * dx + dy * dy + dz * dz;
}

function intersectSphere(rectangle: number[], center: Vec3, radiusSqr: number): Vec2 | undefined {
    const x = Math.max(rectangle[0], Math.min(center[0], rectangle[2]));
    const y = rectangle[4];
    const z = Math.max(rectangle[1], Math.min(center[2], rectangle[3]));

    const mx = x - center[0];
    const my = y - center[1];
    const mz = z - center[2];

    const b = my;
    const c = lenSqr(mx, my, mz) - radiusSqr;
    if (c > 0.0 && b > 0.0) {
        return undefined;
    }
    const discr = b * b - c;
    if (discr < 0.0) {
        return undefined;
    }
    const discrSqrt = Math.sqrt(discr);
    let tmin = -b - discrSqrt;
    const tmax = -b + discrSqrt;

    if (tmin < 0.0) {
        tmin = 0.0;
    }
    return [y + tmin, y + tmax];
}

function mergeIntersections(s1: Vec2 | undefined, s2: Vec2 | undefined): Vec2 | undefined {
    if (s1 === undefined) {
        return s2;
    }
    if (s2 === undefined) {
        return s1;
    }
    return [Math.min(s1[0], s2[0]), Math.max(s1[1], s2[1])];
}

function intersectCapsule(rectangle: number[], start: Vec3, finish: Vec3, axis: Vec3, radiusSqr: number) {
    let s = mergeIntersections(intersectSphere(rectangle, start, radiusSqr), intersectSphere(rectangle, finish, radiusSqr));
    const axisLen2dSqr = axis[0] * axis[0] + axis[2] * axis[2];
    if (axisLen2dSqr > EPSILON) {
        s = slabsCylinderIntersection(rectangle, start, finish, axis, radiusSqr, s);
    }
    return s;
}

const _intersectCylinder_rectangleOnStartPlane: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
];
const _intersectCylinder_rectangleOnEndPlane: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
];
const _intersectCylinder_point: Vec3 = [0, 0, 0];

function intersectCylinder(rectangle: number[], start: Vec3, finish: Vec3, axis: Vec3, radiusSqr: number) {
    _intersectCylinder_point[0] = clamp(start[0], rectangle[0], rectangle[2]);
    _intersectCylinder_point[1] = rectangle[4];
    _intersectCylinder_point[2] = clamp(start[2], rectangle[1], rectangle[3]);
    let s: Vec2 | undefined = rayCylinderIntersection(_intersectCylinder_point, start, axis, radiusSqr);
    _intersectCylinder_point[0] = clamp(finish[0], rectangle[0], rectangle[2]);
    _intersectCylinder_point[1] = rectangle[4];
    _intersectCylinder_point[2] = clamp(finish[2], rectangle[1], rectangle[3]);
    s = mergeIntersections(s, rayCylinderIntersection(_intersectCylinder_point, start, axis, radiusSqr));
    const axisLen2dSqr = axis[0] * axis[0] + axis[2] * axis[2];
    if (axisLen2dSqr > EPSILON) {
        s = slabsCylinderIntersection(rectangle, start, finish, axis, radiusSqr, s);
    }
    if (axis[1] * axis[1] > EPSILON) {
        const ds = vec3.dot(axis, start);
        const de = vec3.dot(axis, finish);
        for (let i = 0; i < 4; i++) {
            const x = rectangle[(i + 1) & 2];
            const z = rectangle[(i & 2) + 1];
            const dotAxisA = axis[0] * x + axis[1] * rectangle[4] + axis[2] * z;
            let t = (ds - dotAxisA) / axis[1];
            _intersectCylinder_rectangleOnStartPlane[i][0] = x;
            _intersectCylinder_rectangleOnStartPlane[i][1] = rectangle[4] + t;
            _intersectCylinder_rectangleOnStartPlane[i][2] = z;
            t = (de - dotAxisA) / axis[1];
            _intersectCylinder_rectangleOnEndPlane[i][0] = x;
            _intersectCylinder_rectangleOnEndPlane[i][1] = rectangle[4] + t;
            _intersectCylinder_rectangleOnEndPlane[i][2] = z;
        }
        for (let i = 0; i < 4; i++) {
            s = cylinderCapIntersection(start, radiusSqr, s, i, _intersectCylinder_rectangleOnStartPlane);
            s = cylinderCapIntersection(finish, radiusSqr, s, i, _intersectCylinder_rectangleOnEndPlane);
        }
    }
    return s;
}

const _cylinderCapIntersection_m: Vec3 = [0, 0, 0];
const _cylinderCapIntersection_d: Vec3 = [0, 0, 0];
const _cylinderCapIntersection_y: Vec2 = [0, 0];

function cylinderCapIntersection(start: Vec3, radiusSqr: number, s: Vec2 | undefined, i: number, rectangleOnPlane: number[][]) {
    const j = (i + 1) % 4;
    _cylinderCapIntersection_m[0] = rectangleOnPlane[i][0] - start[0];
    _cylinderCapIntersection_m[1] = rectangleOnPlane[i][1] - start[1];
    _cylinderCapIntersection_m[2] = rectangleOnPlane[i][2] - start[2];
    _cylinderCapIntersection_d[0] = rectangleOnPlane[j][0] - rectangleOnPlane[i][0];
    _cylinderCapIntersection_d[1] = rectangleOnPlane[j][1] - rectangleOnPlane[i][1];
    _cylinderCapIntersection_d[2] = rectangleOnPlane[j][2] - rectangleOnPlane[i][2];
    const dl = vec3.dot(_cylinderCapIntersection_d, _cylinderCapIntersection_d);
    const b = vec3.dot(_cylinderCapIntersection_m, _cylinderCapIntersection_d) / dl;
    const c = (vec3.dot(_cylinderCapIntersection_m, _cylinderCapIntersection_m) - radiusSqr) / dl;
    const discr = b * b - c;
    if (discr > EPSILON) {
        const discrSqrt = Math.sqrt(discr);
        let t1 = -b - discrSqrt;
        let t2 = -b + discrSqrt;
        if (t1 <= 1 && t2 >= 0) {
            t1 = Math.max(0, t1);
            t2 = Math.min(1, t2);
            const y1 = rectangleOnPlane[i][1] + t1 * _cylinderCapIntersection_d[1];
            const y2 = rectangleOnPlane[i][1] + t2 * _cylinderCapIntersection_d[1];
            _cylinderCapIntersection_y[0] = Math.min(y1, y2);
            _cylinderCapIntersection_y[1] = Math.max(y1, y2);
            s = mergeIntersections(s, _cylinderCapIntersection_y);
        }
    }
    return s;
}

function slabsCylinderIntersection(
    rectangle: number[],
    start: Vec3,
    finish: Vec3,
    axis: Vec3,
    radiusSqr: number,
    s: Vec2 | undefined,
) {
    if (Math.min(start[0], finish[0]) < rectangle[0]) {
        s = mergeIntersections(s, xSlabCylinderIntersection(rectangle, start, axis, radiusSqr, rectangle[0]));
    }
    if (Math.max(start[0], finish[0]) > rectangle[2]) {
        s = mergeIntersections(s, xSlabCylinderIntersection(rectangle, start, axis, radiusSqr, rectangle[2]));
    }
    if (Math.min(start[2], finish[2]) < rectangle[1]) {
        s = mergeIntersections(s, zSlabCylinderIntersection(rectangle, start, axis, radiusSqr, rectangle[1]));
    }
    if (Math.max(start[2], finish[2]) > rectangle[3]) {
        s = mergeIntersections(s, zSlabCylinderIntersection(rectangle, start, axis, radiusSqr, rectangle[3]));
    }
    return s;
}

function xSlabCylinderIntersection(rectangle: number[], start: Vec3, axis: Vec3, radiusSqr: number, x: number) {
    return rayCylinderIntersection(xSlabRayIntersection(rectangle, start, axis, x), start, axis, radiusSqr);
}

const _xSlabRayIntersection_result: Vec3 = [0, 0, 0];

function xSlabRayIntersection(rectangle: number[], start: Vec3, direction: Vec3, x: number): Vec3 {
    const t = (x - start[0]) / direction[0];
    _xSlabRayIntersection_result[0] = x;
    _xSlabRayIntersection_result[1] = rectangle[4];
    _xSlabRayIntersection_result[2] = clamp(start[2] + t * direction[2], rectangle[1], rectangle[3]);
    return _xSlabRayIntersection_result;
}

function zSlabCylinderIntersection(rectangle: number[], start: Vec3, axis: Vec3, radiusSqr: number, z: number) {
    return rayCylinderIntersection(zSlabRayIntersection(rectangle, start, axis, z), start, axis, radiusSqr);
}

const _zSlabRayIntersection_result: Vec3 = [0, 0, 0];

function zSlabRayIntersection(rectangle: number[], start: Vec3, direction: Vec3, z: number): Vec3 {
    const t = (z - start[2]) / direction[2];
    _zSlabRayIntersection_result[0] = clamp(start[0] + t * direction[0], rectangle[0], rectangle[2]);
    _zSlabRayIntersection_result[1] = rectangle[4];
    _zSlabRayIntersection_result[2] = z;
    return _zSlabRayIntersection_result;
}

const _rayCylinderIntersection_m: Vec3 = [0, 0, 0];

// Based on Christer Ericsons's "Real-Time Collision Detection"
function rayCylinderIntersection(point: Vec3, start: Vec3, axis: Vec3, radiusSqr: number): Vec2 | undefined {
    const d = axis;
    _rayCylinderIntersection_m[0] = point[0] - start[0];
    _rayCylinderIntersection_m[1] = point[1] - start[1];
    _rayCylinderIntersection_m[2] = point[2] - start[2];
    const md = vec3.dot(_rayCylinderIntersection_m, d);
    const nd = axis[1];
    const dd = vec3.dot(d, d);

    const nn = 1;
    const mn = _rayCylinderIntersection_m[1];
    const a = dd - nd * nd;
    const k = vec3.dot(_rayCylinderIntersection_m, _rayCylinderIntersection_m) - radiusSqr;
    const c = dd * k - md * md;
    if (Math.abs(a) < EPSILON) {
        // Segment runs parallel to cylinder axis
        if (c > 0.0) {
            return undefined; // ’a’ and thus the segment lie outside cylinder
        }
        // Now known that segment intersects cylinder; figure out how it intersects
        const t1 = -mn / nn; // Intersect segment against ’p’ endcap
        const t2 = (nd - mn) / nn; // Intersect segment against ’q’ endcap
        return [point[1] + Math.min(t1, t2), point[1] + Math.max(t1, t2)];
    }
    const b = dd * mn - nd * md;
    const discr = b * b - a * c;
    if (discr < 0.0) {
        return undefined; // No real roots; no intersection
    }
    const discSqrt = Math.sqrt(discr);
    let t1 = (-b - discSqrt) / a;
    let t2 = (-b + discSqrt) / a;

    if (md + t1 * nd < 0.0) {
        // Intersection outside cylinder on ’p’ side
        t1 = -md / nd;
        if (k + t1 * (2 * mn + t1 * nn) > 0.0) {
            return undefined;
        }
    } else if (md + t1 * nd > dd) {
        // Intersection outside cylinder on ’q’ side
        t1 = (dd - md) / nd;
        if (k + dd - 2 * md + t1 * (2 * (mn - nd) + t1 * nn) > 0.0) {
            return undefined;
        }
    }
    if (md + t2 * nd < 0.0) {
        // Intersection outside cylinder on ’p’ side
        t2 = -md / nd;
        if (k + t2 * (2 * mn + t2 * nn) > 0.0) {
            return undefined;
        }
    } else if (md + t2 * nd > dd) {
        // Intersection outside cylinder on ’q’ side
        t2 = (dd - md) / nd;
        if (k + dd - 2 * md + t2 * (2 * (mn - nd) + t2 * nn) > 0.0) {
            return undefined;
        }
    }
    return [point[1] + Math.min(t1, t2), point[1] + Math.max(t1, t2)];
}

const _intersectBox_point: Vec3 = [0, 0, 0];

function intersectBox(rectangle: number[], vertices: number[], planes: number[][]): Vec2 | undefined {
    let yMin = Infinity;
    let yMax = -Infinity;
    // check intersection with rays starting in box vertices first
    for (let i = 0; i < 8; i++) {
        const vi = i * 3;
        if (
            vertices[vi] >= rectangle[0] &&
            vertices[vi] < rectangle[2] &&
            vertices[vi + 2] >= rectangle[1] &&
            vertices[vi + 2] < rectangle[3]
        ) {
            yMin = Math.min(yMin, vertices[vi + 1]);
            yMax = Math.max(yMax, vertices[vi + 1]);
        }
    }

    // check intersection with rays starting in rectangle vertices
    _intersectBox_point[1] = rectangle[1];
    for (let i = 0; i < 4; i++) {
        _intersectBox_point[0] = (i & 1) === 0 ? rectangle[0] : rectangle[2];
        _intersectBox_point[2] = (i & 2) === 0 ? rectangle[1] : rectangle[3];
        for (let j = 0; j < 6; j++) {
            if (Math.abs(planes[j][1]) > EPSILON) {
                const dotNormalPoint = vec3.dot(planes[j] as Vec3, _intersectBox_point as Vec3);
                const t = (planes[j][3] - dotNormalPoint) / planes[j][1];
                const y = _intersectBox_point[1] + t;
                let valid = true;
                for (let k = 0; k < 6; k++) {
                    if (k !== j) {
                        if (
                            _intersectBox_point[0] * planes[k][0] + y * planes[k][1] + _intersectBox_point[2] * planes[k][2] >
                            planes[k][3]
                        ) {
                            valid = false;
                            break;
                        }
                    }
                }
                if (valid) {
                    yMin = Math.min(yMin, y);
                    yMax = Math.max(yMax, y);
                }
            }
        }
    }

    // check intersection with box edges
    for (let i = 0; i < BOX_EDGES.length; i += 2) {
        const vi = BOX_EDGES[i] * 3;
        const vj = BOX_EDGES[i + 1] * 3;
        const x = vertices[vi];
        const z = vertices[vi + 2];
        // edge slab intersection
        const y = vertices[vi + 1];
        const dx = vertices[vj] - x;
        const dy = vertices[vj + 1] - y;
        const dz = vertices[vj + 2] - z;
        if (Math.abs(dx) > EPSILON) {
            let iy = xSlabSegmentIntersection(rectangle, x, y, z, dx, dy, dz, rectangle[0]);
            if (iy !== undefined) {
                yMin = Math.min(yMin, iy);
                yMax = Math.max(yMax, iy);
            }
            iy = xSlabSegmentIntersection(rectangle, x, y, z, dx, dy, dz, rectangle[2]);
            if (iy !== undefined) {
                yMin = Math.min(yMin, iy);
                yMax = Math.max(yMax, iy);
            }
        }
        if (Math.abs(dz) > EPSILON) {
            let iy = zSlabSegmentIntersection(rectangle, x, y, z, dx, dy, dz, rectangle[1]);
            if (iy !== undefined) {
                yMin = Math.min(yMin, iy);
                yMax = Math.max(yMax, iy);
            }
            iy = zSlabSegmentIntersection(rectangle, x, y, z, dx, dy, dz, rectangle[3]);
            if (iy !== undefined) {
                yMin = Math.min(yMin, iy);
                yMax = Math.max(yMax, iy);
            }
        }
    }

    if (yMin <= yMax) {
        return [yMin, yMax];
    }
    return undefined;
}

const _intersectConvex_point: Vec3 = [0, 0, 0];

function intersectConvex(
    rectangle: number[],
    triangles: number[],
    verts: number[],
    planes: number[][],
    triBounds: number[][],
): Vec2 | undefined {
    let imin = Infinity;
    let imax = -Infinity;
    for (let tr = 0, tri = 0; tri < triangles.length; tr++, tri += 3) {
        if (
            triBounds[tr][0] > rectangle[2] ||
            triBounds[tr][2] < rectangle[0] ||
            triBounds[tr][1] > rectangle[3] ||
            triBounds[tr][3] < rectangle[1]
        ) {
            continue;
        }
        if (Math.abs(planes[tri][1]) < EPSILON) {
            continue;
        }
        for (let i = 0; i < 3; i++) {
            const vi = triangles[tri + i] * 3;
            const vj = triangles[tri + ((i + 1) % 3)] * 3;
            const x = verts[vi];
            const z = verts[vi + 2];
            // triangle vertex
            if (x >= rectangle[0] && x <= rectangle[2] && z >= rectangle[1] && z <= rectangle[3]) {
                imin = Math.min(imin, verts[vi + 1]);
                imax = Math.max(imax, verts[vi + 1]);
            }
            // triangle slab intersection
            const y = verts[vi + 1];
            const dx = verts[vj] - x;
            const dy = verts[vj + 1] - y;
            const dz = verts[vj + 2] - z;
            if (Math.abs(dx) > EPSILON) {
                let iy = xSlabSegmentIntersection(rectangle, x, y, z, dx, dy, dz, rectangle[0]);
                if (iy !== undefined) {
                    imin = Math.min(imin, iy);
                    imax = Math.max(imax, iy);
                }
                iy = xSlabSegmentIntersection(rectangle, x, y, z, dx, dy, dz, rectangle[2]);
                if (iy !== undefined) {
                    imin = Math.min(imin, iy);
                    imax = Math.max(imax, iy);
                }
            }
            if (Math.abs(dz) > EPSILON) {
                let iy = zSlabSegmentIntersection(rectangle, x, y, z, dx, dy, dz, rectangle[1]);
                if (iy !== undefined) {
                    imin = Math.min(imin, iy);
                    imax = Math.max(imax, iy);
                }
                iy = zSlabSegmentIntersection(rectangle, x, y, z, dx, dy, dz, rectangle[3]);
                if (iy !== undefined) {
                    imin = Math.min(imin, iy);
                    imax = Math.max(imax, iy);
                }
            }
        }
        // rectangle vertex
        _intersectConvex_point[1] = rectangle[1];
        for (let i = 0; i < 4; i++) {
            _intersectConvex_point[0] = (i & 1) === 0 ? rectangle[0] : rectangle[2];
            _intersectConvex_point[2] = (i & 2) === 0 ? rectangle[1] : rectangle[3];
            const y = rayTriangleIntersection(_intersectConvex_point, tri, planes);
            if (y !== undefined) {
                imin = Math.min(imin, y);
                imax = Math.max(imax, y);
            }
        }
    }
    if (imin < imax) {
        return [imin, imax];
    }
    return undefined;
}

function xSlabSegmentIntersection(
    rectangle: number[],
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    slabX: number,
) {
    const x2 = x + dx;
    if ((x < slabX && x2 > slabX) || (x > slabX && x2 < slabX)) {
        const t = (slabX - x) / dx;
        const iz = z + dz * t;
        if (iz >= rectangle[1] && iz <= rectangle[3]) {
            return y + dy * t;
        }
    }
    return undefined;
}

function zSlabSegmentIntersection(
    rectangle: number[],
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    slabZ: number,
) {
    const z2 = z + dz;
    if ((z < slabZ && z2 > slabZ) || (z > slabZ && z2 < slabZ)) {
        const t = (slabZ - z) / dz;
        const ix = x + dx * t;
        if (ix >= rectangle[0] && ix <= rectangle[2]) {
            return y + dy * t;
        }
    }
    return undefined;
}

const _rayTriangleIntersection_s: Vec3 = [0, 0, 0];

function rayTriangleIntersection(point: Vec3, plane: number, planes: number[][]) {
    const t = (planes[plane][3] - vec3.dot(planes[plane] as Vec3, point)) / planes[plane][1];
    _rayTriangleIntersection_s[0] = point[0];
    _rayTriangleIntersection_s[1] = point[1] + t;
    _rayTriangleIntersection_s[2] = point[2];
    const u = vec3.dot(_rayTriangleIntersection_s, planes[plane + 1] as Vec3) - planes[plane + 1][3];
    if (u < 0.0 || u > 1.0) {
        return undefined;
    }
    const v = vec3.dot(_rayTriangleIntersection_s, planes[plane + 2] as Vec3) - planes[plane + 2][3];
    if (v < 0.0) {
        return undefined;
    }
    const w = 1 - u - v;
    if (w < 0.0) {
        return undefined;
    }
    return _rayTriangleIntersection_s[1];
}
