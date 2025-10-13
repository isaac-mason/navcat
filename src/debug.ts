import { type Vec3, vec3 } from 'maaths';
import type { ArrayLike, CompactHeightfield, ContourSet, Heightfield, PolyMesh, PolyMeshDetail } from './generate';
import { MESH_NULL_IDX, NULL_AREA, POLY_NEIS_FLAG_EXT_LINK, WALKABLE_AREA } from './generate';
import type { NavMesh, NavMeshTile, NodeRef, SearchNode, SearchNodePool } from './query';
import { getNodeByRef, OffMeshConnectionDirection } from './query';

// debug primitive types
export enum DebugPrimitiveType {
    Triangles = 0,
    Lines = 1,
    Points = 2,
    Boxes = 3,
}

export type DebugTriangles = {
    type: DebugPrimitiveType.Triangles;
    positions: number[]; // x,y,z for each vertex
    colors: number[]; // r,g,b for each vertex
    indices: number[]; // triangle indices
    transparent?: boolean;
    opacity?: number;
    doubleSided?: boolean;
};

export type DebugLines = {
    type: DebugPrimitiveType.Lines;
    positions: number[]; // x,y,z for each line endpoint
    colors: number[]; // r,g,b for each line endpoint
    lineWidth?: number;
    transparent?: boolean;
    opacity?: number;
};

export type DebugPoints = {
    type: DebugPrimitiveType.Points;
    positions: number[]; // x,y,z for each point
    colors: number[]; // r,g,b for each point
    size: number;
    transparent?: boolean;
    opacity?: number;
};

export type DebugBoxes = {
    type: DebugPrimitiveType.Boxes;
    positions: number[]; // x,y,z center for each box
    colors: number[]; // r,g,b for each box
    scales: number[]; // sx,sy,sz for each box
    rotations?: number[]; // qx,qy,qz,qw for each box (optional)
    transparent?: boolean;
    opacity?: number;
};

export type DebugPrimitive = DebugTriangles | DebugLines | DebugPoints | DebugBoxes;

// Utility functions
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    h /= 360;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + h * 12) % 12;
        return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    return [f(0), f(8), f(4)];
}

function regionToColor(regionId: number, alpha = 1.0): [number, number, number] {
    if (regionId === 0) {
        return [0, 0, 0];
    }
    const hash = regionId * 137.5;
    const hue = hash % 360;
    const [r, g, b] = hslToRgb(hue, 0.7, 0.6);
    return [r * alpha, g * alpha, b * alpha];
}

function areaToColor(area: number, alpha = 1.0): [number, number, number] {
    if (area === WALKABLE_AREA) {
        return [0, 192 / 255, 1];
    }
    if (area === NULL_AREA) {
        return [0, 0, 0];
    }
    const hash = area * 137.5;
    const hue = hash % 360;
    const [r, g, b] = hslToRgb(hue, 0.7, 0.6);
    return [r * alpha, g * alpha, b * alpha];
}

export function createTriangleAreaIdsHelper(
    input: { positions: ArrayLike<number>; indices: ArrayLike<number> },
    triAreaIds: ArrayLike<number>,
): DebugPrimitive[] {
    const areaToColorMap: Record<number, [number, number, number]> = {};
    const positions: number[] = [];
    const indices: number[] = [];
    const vertexColors: number[] = [];

    let positionsIndex = 0;
    let indicesIndex = 0;
    let vertexColorsIndex = 0;

    for (let triangle = 0; triangle < input.indices.length / 3; triangle++) {
        const areaId = triAreaIds[triangle];

        let color = areaToColorMap[areaId];
        if (!color) {
            if (areaId === WALKABLE_AREA) {
                color = [0, 1, 0];
            } else if (areaId === NULL_AREA) {
                color = [1, 0, 0];
            } else {
                color = areaToColor(areaId);
            }
            areaToColorMap[areaId] = color;
        }

        positions[positionsIndex++] = input.positions[input.indices[triangle * 3] * 3];
        positions[positionsIndex++] = input.positions[input.indices[triangle * 3] * 3 + 1];
        positions[positionsIndex++] = input.positions[input.indices[triangle * 3] * 3 + 2];

        positions[positionsIndex++] = input.positions[input.indices[triangle * 3 + 1] * 3];
        positions[positionsIndex++] = input.positions[input.indices[triangle * 3 + 1] * 3 + 1];
        positions[positionsIndex++] = input.positions[input.indices[triangle * 3 + 1] * 3 + 2];

        positions[positionsIndex++] = input.positions[input.indices[triangle * 3 + 2] * 3];
        positions[positionsIndex++] = input.positions[input.indices[triangle * 3 + 2] * 3 + 1];
        positions[positionsIndex++] = input.positions[input.indices[triangle * 3 + 2] * 3 + 2];

        indices[indicesIndex++] = triangle * 3;
        indices[indicesIndex++] = triangle * 3 + 1;
        indices[indicesIndex++] = triangle * 3 + 2;

        for (let i = 0; i < 3; i++) {
            vertexColors[vertexColorsIndex++] = color[0];
            vertexColors[vertexColorsIndex++] = color[1];
            vertexColors[vertexColorsIndex++] = color[2];
        }
    }

    if (positions.length === 0) {
        return [];
    }

    return [
        {
            type: DebugPrimitiveType.Triangles,
            positions: positions,
            colors: vertexColors,
            indices: indices,
            transparent: true,
            opacity: 1,
        },
    ];
}

export function createHeightfieldHelper(heightfield: Heightfield): DebugPrimitive[] {
    // Count total spans
    let totalSpans = 0;
    for (let z = 0; z < heightfield.height; z++) {
        for (let x = 0; x < heightfield.width; x++) {
            const columnIndex = x + z * heightfield.width;
            let span = heightfield.spans[columnIndex];
            while (span) {
                totalSpans++;
                span = span.next || null;
            }
        }
    }

    if (totalSpans === 0) {
        return [];
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const scales: number[] = [];

    const heightfieldBoundsMin = heightfield.bounds[0];
    const cellSize = heightfield.cellSize;
    const cellHeight = heightfield.cellHeight;

    const areaToColorMap: Record<number, [number, number, number]> = {};

    for (let z = 0; z < heightfield.height; z++) {
        for (let x = 0; x < heightfield.width; x++) {
            const columnIndex = x + z * heightfield.width;
            let span = heightfield.spans[columnIndex];

            while (span) {
                const worldX = heightfieldBoundsMin[0] + (x + 0.5) * cellSize;
                const worldZ = heightfieldBoundsMin[2] + (z + 0.5) * cellSize;
                const spanHeight = (span.max - span.min) * cellHeight;
                const worldY = heightfieldBoundsMin[1] + (span.min + (span.max - span.min) * 0.5) * cellHeight;

                positions.push(worldX, worldY, worldZ);
                scales.push(cellSize * 0.9, spanHeight, cellSize * 0.9);

                let color = areaToColorMap[span.area];
                if (!color) {
                    if (span.area === WALKABLE_AREA) {
                        color = [0, 1, 0];
                    } else if (span.area === NULL_AREA) {
                        color = [1, 0, 0];
                    } else {
                        color = areaToColor(span.area);
                    }
                    areaToColorMap[span.area] = color;
                }

                colors.push(color[0], color[1], color[2]);

                span = span.next || null;
            }
        }
    }

    return [
        {
            type: DebugPrimitiveType.Boxes,
            positions,
            colors,
            scales,
        },
    ];
}

export function createCompactHeightfieldSolidHelper(compactHeightfield: CompactHeightfield): DebugPrimitive[] {
    const chf = compactHeightfield;

    let totalQuads = 0;
    for (let y = 0; y < chf.height; y++) {
        for (let x = 0; x < chf.width; x++) {
            const cell = chf.cells[x + y * chf.width];
            totalQuads += cell.count;
        }
    }

    if (totalQuads === 0) {
        return [];
    }

    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    let indexOffset = 0;

    for (let y = 0; y < chf.height; y++) {
        for (let x = 0; x < chf.width; x++) {
            const fx = chf.bounds[0][0] + x * chf.cellSize;
            const fz = chf.bounds[0][2] + y * chf.cellSize;
            const cell = chf.cells[x + y * chf.width];

            for (let i = cell.index; i < cell.index + cell.count; i++) {
                const span = chf.spans[i];
                const area = chf.areas[i];

                const color = areaToColor(area);

                const fy = chf.bounds[0][1] + (span.y + 1) * chf.cellHeight;

                // Create quad vertices
                positions.push(fx, fy, fz);
                colors.push(color[0], color[1], color[2]);

                positions.push(fx, fy, fz + chf.cellSize);
                colors.push(color[0], color[1], color[2]);

                positions.push(fx + chf.cellSize, fy, fz + chf.cellSize);
                colors.push(color[0], color[1], color[2]);

                positions.push(fx + chf.cellSize, fy, fz);
                colors.push(color[0], color[1], color[2]);

                // Create triangles
                indices.push(indexOffset, indexOffset + 1, indexOffset + 2);
                indices.push(indexOffset, indexOffset + 2, indexOffset + 3);

                indexOffset += 4;
            }
        }
    }

    return [
        {
            type: DebugPrimitiveType.Triangles,
            positions: positions,
            colors: colors,
            indices: indices,
            transparent: true,
            opacity: 0.6,
            doubleSided: true,
        },
    ];
}

export function createCompactHeightfieldDistancesHelper(compactHeightfield: CompactHeightfield): DebugPrimitive[] {
    const chf = compactHeightfield;

    if (!chf.distances) {
        return [];
    }

    let maxd = chf.maxDistance;
    if (maxd < 1.0) maxd = 1;
    const dscale = 255.0 / maxd;

    let totalQuads = 0;
    for (let y = 0; y < chf.height; y++) {
        for (let x = 0; x < chf.width; x++) {
            const cell = chf.cells[x + y * chf.width];
            totalQuads += cell.count;
        }
    }

    if (totalQuads === 0) {
        return [];
    }

    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    let indexOffset = 0;

    for (let y = 0; y < chf.height; y++) {
        for (let x = 0; x < chf.width; x++) {
            const fx = chf.bounds[0][0] + x * chf.cellSize;
            const fz = chf.bounds[0][2] + y * chf.cellSize;
            const cell = chf.cells[x + y * chf.width];

            for (let i = cell.index; i < cell.index + cell.count; i++) {
                const span = chf.spans[i];
                const fy = chf.bounds[0][1] + (span.y + 1) * chf.cellHeight;

                const cd = Math.min(255, Math.floor(chf.distances[i] * dscale)) / 255.0;

                // Create quad vertices
                positions.push(fx, fy, fz);
                colors.push(cd, cd, cd);

                positions.push(fx, fy, fz + chf.cellSize);
                colors.push(cd, cd, cd);

                positions.push(fx + chf.cellSize, fy, fz + chf.cellSize);
                colors.push(cd, cd, cd);

                positions.push(fx + chf.cellSize, fy, fz);
                colors.push(cd, cd, cd);

                // Create triangles
                indices.push(indexOffset, indexOffset + 1, indexOffset + 2);
                indices.push(indexOffset, indexOffset + 2, indexOffset + 3);

                indexOffset += 4;
            }
        }
    }

    return [
        {
            type: DebugPrimitiveType.Triangles,
            positions: positions,
            colors: colors,
            indices: indices,
            transparent: true,
            opacity: 0.8,
            doubleSided: true,
        },
    ];
}

export function createCompactHeightfieldRegionsHelper(compactHeightfield: CompactHeightfield): DebugPrimitive[] {
    const chf = compactHeightfield;

    let totalQuads = 0;
    for (let y = 0; y < chf.height; y++) {
        for (let x = 0; x < chf.width; x++) {
            const cell = chf.cells[x + y * chf.width];
            totalQuads += cell.count;
        }
    }

    if (totalQuads === 0) {
        return [];
    }

    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    let indexOffset = 0;

    for (let y = 0; y < chf.height; y++) {
        for (let x = 0; x < chf.width; x++) {
            const fx = chf.bounds[0][0] + x * chf.cellSize;
            const fz = chf.bounds[0][2] + y * chf.cellSize;
            const cell = chf.cells[x + y * chf.width];

            for (let i = cell.index; i < cell.index + cell.count; i++) {
                const span = chf.spans[i];
                const fy = chf.bounds[0][1] + span.y * chf.cellHeight;

                const color = regionToColor(span.region);

                // Create quad vertices
                positions.push(fx, fy, fz);
                colors.push(color[0], color[1], color[2]);

                positions.push(fx, fy, fz + chf.cellSize);
                colors.push(color[0], color[1], color[2]);

                positions.push(fx + chf.cellSize, fy, fz + chf.cellSize);
                colors.push(color[0], color[1], color[2]);

                positions.push(fx + chf.cellSize, fy, fz);
                colors.push(color[0], color[1], color[2]);

                // Create triangles
                indices.push(indexOffset, indexOffset + 1, indexOffset + 2);
                indices.push(indexOffset, indexOffset + 2, indexOffset + 3);

                indexOffset += 4;
            }
        }
    }

    return [
        {
            type: DebugPrimitiveType.Triangles,
            positions: positions,
            colors: colors,
            indices: indices,
            transparent: true,
            opacity: 0.9,
            doubleSided: true,
        },
    ];
}

export function createRawContoursHelper(contourSet: ContourSet): DebugPrimitive[] {
    if (!contourSet || contourSet.contours.length === 0) {
        return [];
    }

    const orig = contourSet.bounds[0];
    const cs = contourSet.cellSize;
    const ch = contourSet.cellHeight;

    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const pointPositions: number[] = [];
    const pointColors: number[] = [];

    // Draw lines for each contour
    for (let i = 0; i < contourSet.contours.length; ++i) {
        const c = contourSet.contours[i];
        const color = regionToColor(c.reg, 0.8);

        for (let j = 0; j < c.nRawVertices; ++j) {
            const v = c.rawVertices.slice(j * 4, j * 4 + 4);
            const fx = orig[0] + v[0] * cs;
            const fy = orig[1] + (v[1] + 1 + (i & 1)) * ch;
            const fz = orig[2] + v[2] * cs;

            linePositions.push(fx, fy, fz);
            lineColors.push(color[0], color[1], color[2]);

            if (j > 0) {
                linePositions.push(fx, fy, fz);
                lineColors.push(color[0], color[1], color[2]);
            }
        }

        // Loop last segment
        if (c.nRawVertices > 0) {
            const v = c.rawVertices.slice(0, 4);
            const fx = orig[0] + v[0] * cs;
            const fy = orig[1] + (v[1] + 1 + (i & 1)) * ch;
            const fz = orig[2] + v[2] * cs;

            linePositions.push(fx, fy, fz);
            lineColors.push(color[0], color[1], color[2]);
        }
    }

    // Draw points for each contour
    for (let i = 0; i < contourSet.contours.length; ++i) {
        const c = contourSet.contours[i];
        const baseColor = regionToColor(c.reg, 0.8);
        const darkenedColor: [number, number, number] = [baseColor[0] * 0.5, baseColor[1] * 0.5, baseColor[2] * 0.5];

        for (let j = 0; j < c.nRawVertices; ++j) {
            const v = c.rawVertices.slice(j * 4, j * 4 + 4);
            let off = 0;
            let colv = darkenedColor;

            if (v[3] & 0x10000) {
                // BORDER_VERTEX
                colv = [1, 1, 1];
                off = ch * 2;
            }

            const fx = orig[0] + v[0] * cs;
            const fy = orig[1] + (v[1] + 1 + (i & 1)) * ch + off;
            const fz = orig[2] + v[2] * cs;

            pointPositions.push(fx, fy, fz);
            pointColors.push(colv[0], colv[1], colv[2]);
        }
    }

    const primitives: DebugPrimitive[] = [];

    if (linePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: linePositions,
            colors: lineColors,
            transparent: true,
            opacity: 0.8,
            lineWidth: 2.0,
        });
    }

    if (pointPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Points,
            positions: pointPositions,
            colors: pointColors,
            size: 0.01,
            transparent: true,
        });
    }

    return primitives;
}

export function createSimplifiedContoursHelper(contourSet: ContourSet): DebugPrimitive[] {
    if (!contourSet || contourSet.contours.length === 0) {
        return [];
    }

    const orig = contourSet.bounds[0];
    const cs = contourSet.cellSize;
    const ch = contourSet.cellHeight;

    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const pointPositions: number[] = [];
    const pointColors: number[] = [];

    // Draw lines for each contour
    for (let i = 0; i < contourSet.contours.length; ++i) {
        const c = contourSet.contours[i];
        if (c.nVertices === 0) continue;

        const baseColor = regionToColor(c.reg, 0.8);
        const whiteColor: [number, number, number] = [1, 1, 1];

        // Lerp between colors
        const lerpColor = (t: number): [number, number, number] => {
            const f = t / 255.0;
            return [
                baseColor[0] * (1 - f) + whiteColor[0] * f,
                baseColor[1] * (1 - f) + whiteColor[1] * f,
                baseColor[2] * (1 - f) + whiteColor[2] * f,
            ];
        };
        const borderColor = lerpColor(128);

        for (let j = 0, k = c.nVertices - 1; j < c.nVertices; k = j++) {
            const va = c.vertices.slice(k * 4, k * 4 + 4);
            const vb = c.vertices.slice(j * 4, j * 4 + 4);

            const isAreaBorder = (va[3] & 0x20000) !== 0;
            const col = isAreaBorder ? borderColor : baseColor;

            const fx1 = orig[0] + va[0] * cs;
            const fy1 = orig[1] + (va[1] + 1 + (i & 1)) * ch;
            const fz1 = orig[2] + va[2] * cs;

            const fx2 = orig[0] + vb[0] * cs;
            const fy2 = orig[1] + (vb[1] + 1 + (i & 1)) * ch;
            const fz2 = orig[2] + vb[2] * cs;

            linePositions.push(fx1, fy1, fz1);
            lineColors.push(col[0], col[1], col[2]);
            linePositions.push(fx2, fy2, fz2);
            lineColors.push(col[0], col[1], col[2]);
        }
    }

    // Draw points for each contour
    for (let i = 0; i < contourSet.contours.length; ++i) {
        const c = contourSet.contours[i];
        const baseColor = regionToColor(c.reg, 0.8);
        const darkenedColor: [number, number, number] = [baseColor[0] * 0.5, baseColor[1] * 0.5, baseColor[2] * 0.5];

        for (let j = 0; j < c.nVertices; ++j) {
            const v = c.vertices.slice(j * 4, j * 4 + 4);
            let off = 0;
            let colv = darkenedColor;

            if (v[3] & 0x10000) {
                colv = [1, 1, 1];
                off = ch * 2;
            }

            const fx = orig[0] + v[0] * cs;
            const fy = orig[1] + (v[1] + 1 + (i & 1)) * ch + off;
            const fz = orig[2] + v[2] * cs;

            pointPositions.push(fx, fy, fz);
            pointColors.push(colv[0], colv[1], colv[2]);
        }
    }

    const primitives: DebugPrimitive[] = [];

    if (linePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: linePositions,
            colors: lineColors,
            transparent: true,
            opacity: 0.9,
            lineWidth: 2.5,
        });
    }

    if (pointPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Points,
            positions: pointPositions,
            colors: pointColors,
            size: 0.01,
            transparent: true,
        });
    }

    return primitives;
}

export function createPolyMeshHelper(polyMesh: PolyMesh): DebugPrimitive[] {
    if (!polyMesh || polyMesh.nPolys === 0) {
        return [];
    }

    const nvp = polyMesh.maxVerticesPerPoly;
    const cs = polyMesh.cellSize;
    const ch = polyMesh.cellHeight;
    const orig = polyMesh.bounds[0];

    const triPositions: number[] = [];
    const triColors: number[] = [];
    const triIndices: number[] = [];
    const edgeLinePositions: number[] = [];
    const edgeLineColors: number[] = [];
    const vertexPositions: number[] = [];
    const vertexColors: number[] = [];

    let triVertexIndex = 0;

    // Draw polygon triangles
    for (let i = 0; i < polyMesh.nPolys; i++) {
        const polyBase = i * nvp;
        const area = polyMesh.areas[i];
        const color = areaToColor(area);

        // Triangulate polygon by creating a triangle fan from vertex 0
        for (let j = 2; j < nvp; j++) {
            const v0 = polyMesh.polys[polyBase + 0];
            const v1 = polyMesh.polys[polyBase + j - 1];
            const v2 = polyMesh.polys[polyBase + j];

            if (v2 === MESH_NULL_IDX) break;

            // Add triangle vertices
            const vertices = [v0, v1, v2];
            for (let k = 0; k < 3; k++) {
                const vertIndex = vertices[k] * 3;
                const x = orig[0] + polyMesh.vertices[vertIndex] * cs;
                const y = orig[1] + (polyMesh.vertices[vertIndex + 1] + 1) * ch;
                const z = orig[2] + polyMesh.vertices[vertIndex + 2] * cs;

                triPositions.push(x, y, z);
                triColors.push(color[0], color[1], color[2]);
            }

            triIndices.push(triVertexIndex, triVertexIndex + 1, triVertexIndex + 2);
            triVertexIndex += 3;
        }
    }

    // Draw edges
    const edgeColor: [number, number, number] = [0, 48 / 255, 64 / 255];
    for (let i = 0; i < polyMesh.nPolys; i++) {
        const polyBase = i * nvp;

        for (let j = 0; j < nvp; j++) {
            const v0 = polyMesh.polys[polyBase + j];
            if (v0 === MESH_NULL_IDX) break;

            const nj = j + 1 >= nvp || polyMesh.polys[polyBase + j + 1] === MESH_NULL_IDX ? 0 : j + 1;
            const v1 = polyMesh.polys[polyBase + nj];

            const vertices = [v0, v1];
            for (let k = 0; k < 2; k++) {
                const vertIndex = vertices[k] * 3;
                const x = orig[0] + polyMesh.vertices[vertIndex] * cs;
                const y = orig[1] + (polyMesh.vertices[vertIndex + 1] + 1) * ch + 0.01;
                const z = orig[2] + polyMesh.vertices[vertIndex + 2] * cs;

                edgeLinePositions.push(x, y, z);
                edgeLineColors.push(edgeColor[0], edgeColor[1], edgeColor[2]);
            }
        }
    }

    // Draw vertices (points)
    const vertexColor: [number, number, number] = [1, 1, 1];
    for (let i = 0; i < polyMesh.nVertices; i++) {
        const vertIndex = i * 3;
        const x = orig[0] + polyMesh.vertices[vertIndex] * cs;
        const y = orig[1] + (polyMesh.vertices[vertIndex + 1] + 1) * ch + 0.01;
        const z = orig[2] + polyMesh.vertices[vertIndex + 2] * cs;

        vertexPositions.push(x, y, z);
        vertexColors.push(vertexColor[0], vertexColor[1], vertexColor[2]);
    }

    const primitives: DebugPrimitive[] = [];

    if (triPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Triangles,
            positions: triPositions,
            colors: triColors,
            indices: triIndices,
            transparent: false,
            opacity: 1.0,
            doubleSided: true,
        });
    }

    if (edgeLinePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: edgeLinePositions,
            colors: edgeLineColors,
            transparent: true,
            opacity: 0.5,
            lineWidth: 1.5,
        });
    }

    if (vertexPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Points,
            positions: vertexPositions,
            colors: vertexColors,
            size: 0.025,
            transparent: true,
        });
    }

    return primitives;
}

export function createPolyMeshDetailHelper(polyMeshDetail: PolyMeshDetail): DebugPrimitive[] {
    if (!polyMeshDetail || polyMeshDetail.nMeshes === 0) {
        return [];
    }

    const primitives: DebugPrimitive[] = [];

    const edgeColor: [number, number, number] = [0, 0, 0];
    const vertexColor: [number, number, number] = [1, 1, 1];

    const submeshToColor = (submeshIndex: number): [number, number, number] => {
        const hash = submeshIndex * 137.5;
        const hue = hash % 360;
        const [r, g, b] = hslToRgb(hue, 0.7, 0.6);
        return [r * 0.3, g * 0.3, b * 0.3];
    };

    // 1. Draw triangles
    const triPositions: number[] = [];
    const triColors: number[] = [];
    const triIndices: number[] = [];
    let triVertexIndex = 0;

    for (let i = 0; i < polyMeshDetail.nMeshes; ++i) {
        const m = i * 4;
        const bverts = polyMeshDetail.meshes[m + 0];
        const btris = polyMeshDetail.meshes[m + 2];
        const ntris = polyMeshDetail.meshes[m + 3];
        const verts = bverts * 3;
        const tris = btris * 4;

        const color = submeshToColor(i);

        for (let j = 0; j < ntris; ++j) {
            const triBase = tris + j * 4;
            const t0 = polyMeshDetail.triangles[triBase + 0];
            const t1 = polyMeshDetail.triangles[triBase + 1];
            const t2 = polyMeshDetail.triangles[triBase + 2];

            // Add triangle vertices
            const v0Base = verts + t0 * 3;
            const v1Base = verts + t1 * 3;
            const v2Base = verts + t2 * 3;

            triPositions.push(
                polyMeshDetail.vertices[v0Base],
                polyMeshDetail.vertices[v0Base + 1],
                polyMeshDetail.vertices[v0Base + 2],
                polyMeshDetail.vertices[v1Base],
                polyMeshDetail.vertices[v1Base + 1],
                polyMeshDetail.vertices[v1Base + 2],
                polyMeshDetail.vertices[v2Base],
                polyMeshDetail.vertices[v2Base + 1],
                polyMeshDetail.vertices[v2Base + 2],
            );

            // Add colors for all three vertices
            for (let k = 0; k < 3; k++) {
                triColors.push(color[0], color[1], color[2]);
            }

            triIndices.push(triVertexIndex, triVertexIndex + 1, triVertexIndex + 2);
            triVertexIndex += 3;
        }
    }

    if (triPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Triangles,
            positions: triPositions,
            colors: triColors,
            indices: triIndices,
            transparent: false,
            opacity: 1.0,
        });
    }

    // 2. Draw internal edges
    const internalLinePositions: number[] = [];
    const internalLineColors: number[] = [];

    for (let i = 0; i < polyMeshDetail.nMeshes; ++i) {
        const m = i * 4;
        const bverts = polyMeshDetail.meshes[m + 0];
        const btris = polyMeshDetail.meshes[m + 2];
        const ntris = polyMeshDetail.meshes[m + 3];
        const verts = bverts * 3;
        const tris = btris * 4;

        for (let j = 0; j < ntris; ++j) {
            const t = tris + j * 4;
            const triVertices = [
                polyMeshDetail.triangles[t + 0],
                polyMeshDetail.triangles[t + 1],
                polyMeshDetail.triangles[t + 2],
            ];

            for (let k = 0, kp = 2; k < 3; kp = k++) {
                const ef = (polyMeshDetail.triangles[t + 3] >> (kp * 2)) & 0x3;
                if (ef === 0) {
                    // Internal edge
                    const tkp = triVertices[kp];
                    const tk = triVertices[k];
                    if (tkp < tk) {
                        const vkpBase = verts + tkp * 3;
                        const vkBase = verts + tk * 3;

                        internalLinePositions.push(
                            polyMeshDetail.vertices[vkpBase],
                            polyMeshDetail.vertices[vkpBase + 1],
                            polyMeshDetail.vertices[vkpBase + 2],
                            polyMeshDetail.vertices[vkBase],
                            polyMeshDetail.vertices[vkBase + 1],
                            polyMeshDetail.vertices[vkBase + 2],
                        );

                        // Add colors for both endpoints
                        for (let l = 0; l < 2; l++) {
                            internalLineColors.push(edgeColor[0], edgeColor[1], edgeColor[2]);
                        }
                    }
                }
            }
        }
    }

    if (internalLinePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: internalLinePositions,
            colors: internalLineColors,
            transparent: true,
            opacity: 0.4,
            lineWidth: 1.0,
        });
    }

    // 3. Draw external edges
    const externalLinePositions: number[] = [];
    const externalLineColors: number[] = [];

    for (let i = 0; i < polyMeshDetail.nMeshes; ++i) {
        const m = i * 4;
        const bverts = polyMeshDetail.meshes[m + 0];
        const btris = polyMeshDetail.meshes[m + 2];
        const ntris = polyMeshDetail.meshes[m + 3];
        const verts = bverts * 3;
        const tris = btris * 4;

        for (let j = 0; j < ntris; ++j) {
            const t = tris + j * 4;
            const triVertices = [
                polyMeshDetail.triangles[t + 0],
                polyMeshDetail.triangles[t + 1],
                polyMeshDetail.triangles[t + 2],
            ];

            for (let k = 0, kp = 2; k < 3; kp = k++) {
                const ef = (polyMeshDetail.triangles[t + 3] >> (kp * 2)) & 0x3;
                if (ef !== 0) {
                    // External edge
                    const tkp = triVertices[kp];
                    const tk = triVertices[k];
                    const vkpBase = verts + tkp * 3;
                    const vkBase = verts + tk * 3;

                    externalLinePositions.push(
                        polyMeshDetail.vertices[vkpBase],
                        polyMeshDetail.vertices[vkpBase + 1],
                        polyMeshDetail.vertices[vkpBase + 2],
                        polyMeshDetail.vertices[vkBase],
                        polyMeshDetail.vertices[vkBase + 1],
                        polyMeshDetail.vertices[vkBase + 2],
                    );

                    // Add colors for both endpoints
                    for (let l = 0; l < 2; l++) {
                        externalLineColors.push(edgeColor[0], edgeColor[1], edgeColor[2]);
                    }
                }
            }
        }
    }

    if (externalLinePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: externalLinePositions,
            colors: externalLineColors,
            transparent: true,
            opacity: 0.8,
            lineWidth: 10.0,
        });
    }

    // 4. Draw vertices as points
    const vertexPositions: number[] = [];
    const vertexColors: number[] = [];

    for (let i = 0; i < polyMeshDetail.nMeshes; ++i) {
        const m = i * 4;
        const bverts = polyMeshDetail.meshes[m];
        const nverts = polyMeshDetail.meshes[m + 1];
        const verts = bverts * 3;

        for (let j = 0; j < nverts; ++j) {
            const vBase = verts + j * 3;
            vertexPositions.push(
                polyMeshDetail.vertices[vBase],
                polyMeshDetail.vertices[vBase + 1],
                polyMeshDetail.vertices[vBase + 2],
            );
            vertexColors.push(vertexColor[0], vertexColor[1], vertexColor[2]);
        }
    }

    if (vertexPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Points,
            positions: vertexPositions,
            colors: vertexColors,
            size: 0.025,
        });
    }

    return primitives;
}

export function createNavMeshHelper(navMesh: NavMesh): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    const triPositions: number[] = [];
    const triColors: number[] = [];
    const triIndices: number[] = [];
    let triVertexIndex = 0;

    const interPolyLinePositions: number[] = [];
    const interPolyLineColors: number[] = [];
    const outerPolyLinePositions: number[] = [];
    const outerPolyLineColors: number[] = [];

    const vertexPositions: number[] = [];
    const vertexColors: number[] = [];

    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        if (!tile) continue;

        // Draw detail triangles for each polygon
        for (const polyId in tile.polys) {
            const poly = tile.polys[polyId];
            const polyDetail = tile.detailMeshes[polyId];
            if (!polyDetail) continue;

            // Get polygon color based on area
            const col = areaToColor(poly.area, 0.4);

            // Draw detail triangles for this polygon
            for (let j = 0; j < polyDetail.trianglesCount; j++) {
                const triBase = (polyDetail.trianglesBase + j) * 4;
                const t0 = tile.detailTriangles[triBase];
                const t1 = tile.detailTriangles[triBase + 1];
                const t2 = tile.detailTriangles[triBase + 2];

                // Get triangle vertices
                for (let k = 0; k < 3; k++) {
                    const vertIndex = k === 0 ? t0 : k === 1 ? t1 : t2;
                    let vx: number;
                    let vy: number;
                    let vz: number;

                    if (vertIndex < poly.vertices.length) {
                        // Vertex from main polygon
                        const polyVertIndex = poly.vertices[vertIndex];
                        const vBase = polyVertIndex * 3;
                        vx = tile.vertices[vBase];
                        vy = tile.vertices[vBase + 1];
                        vz = tile.vertices[vBase + 2];
                    } else {
                        // Vertex from detail mesh
                        const detailVertIndex = (polyDetail.verticesBase + vertIndex - poly.vertices.length) * 3;
                        vx = tile.detailVertices[detailVertIndex];
                        vy = tile.detailVertices[detailVertIndex + 1];
                        vz = tile.detailVertices[detailVertIndex + 2];
                    }

                    triPositions.push(vx, vy, vz);
                    triColors.push(...col);
                }

                // Add triangle indices
                triIndices.push(triVertexIndex, triVertexIndex + 1, triVertexIndex + 2);
                triVertexIndex += 3;
            }
        }

        // Draw polygon boundaries
        const innerColor = [0.2, 0.2, 0.2];
        const outerColor = [0.6, 0.6, 1];

        for (const polyId in tile.polys) {
            const poly = tile.polys[polyId];

            for (let j = 0; j < poly.vertices.length; j++) {
                const nj = (j + 1) % poly.vertices.length;
                const nei = poly.neis[j];

                // Check if this is a boundary edge
                const isBoundary = (nei & POLY_NEIS_FLAG_EXT_LINK) !== 0;

                // Get edge vertices
                const polyVertIndex1 = poly.vertices[j];
                const polyVertIndex2 = poly.vertices[nj];

                const v1Base = polyVertIndex1 * 3;
                const v2Base = polyVertIndex2 * 3;

                const v1x = tile.vertices[v1Base];
                const v1y = tile.vertices[v1Base + 1] + 0.01; // Slightly offset up
                const v1z = tile.vertices[v1Base + 2];

                const v2x = tile.vertices[v2Base];
                const v2y = tile.vertices[v2Base + 1] + 0.01;
                const v2z = tile.vertices[v2Base + 2];

                if (isBoundary) {
                    // Outer boundary edge
                    outerPolyLinePositions.push(v1x, v1y, v1z);
                    outerPolyLineColors.push(outerColor[0], outerColor[1], outerColor[2]);
                    outerPolyLinePositions.push(v2x, v2y, v2z);
                    outerPolyLineColors.push(outerColor[0], outerColor[1], outerColor[2]);
                } else {
                    // Inner polygon edge
                    interPolyLinePositions.push(v1x, v1y, v1z);
                    interPolyLineColors.push(innerColor[0], innerColor[1], innerColor[2]);
                    interPolyLinePositions.push(v2x, v2y, v2z);
                    interPolyLineColors.push(innerColor[0], innerColor[1], innerColor[2]);
                }
            }
        }

        // Draw vertices
        const vertexColor = [1, 1, 1];
        for (let i = 0; i < tile.vertices.length; i += 3) {
            const worldX = tile.vertices[i];
            const worldY = tile.vertices[i + 1];
            const worldZ = tile.vertices[i + 2];

            vertexPositions.push(worldX, worldY, worldZ);
            vertexColors.push(vertexColor[0], vertexColor[1], vertexColor[2]);
        }
    }

    // Add triangle mesh primitive
    if (triPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Triangles,
            positions: triPositions,
            colors: triColors,
            indices: triIndices,
            transparent: true,
            opacity: 0.8,
            doubleSided: true,
        });
    }

    // Add inter-poly boundary lines
    if (interPolyLinePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: interPolyLinePositions,
            colors: interPolyLineColors,
            transparent: true,
            opacity: 0.3,
            lineWidth: 1.5,
        });
    }

    // Add outer poly boundary lines
    if (outerPolyLinePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: outerPolyLinePositions,
            colors: outerPolyLineColors,
            transparent: true,
            opacity: 0.9,
            lineWidth: 2.5,
        });
    }

    // Add vertex points
    if (vertexPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Points,
            positions: vertexPositions,
            colors: vertexColors,
            size: 0.025,
        });
    }

    return primitives;
}

export function createNavMeshTileHelper(tile: NavMeshTile): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    const triPositions: number[] = [];
    const triColors: number[] = [];
    const triIndices: number[] = [];
    let triVertexIndex = 0;

    const interPolyLinePositions: number[] = [];
    const interPolyLineColors: number[] = [];
    const outerPolyLinePositions: number[] = [];
    const outerPolyLineColors: number[] = [];

    const vertexPositions: number[] = [];
    const vertexColors: number[] = [];

    // Draw detail triangles for each polygon
    for (const polyId in tile.polys) {
        const poly = tile.polys[polyId];
        const polyDetail = tile.detailMeshes[polyId];
        if (!polyDetail) continue;

        // Get polygon color based on area
        const col = areaToColor(poly.area, 0.4);

        // Draw detail triangles for this polygon
        for (let j = 0; j < polyDetail.trianglesCount; j++) {
            const triBase = (polyDetail.trianglesBase + j) * 4;
            const t0 = tile.detailTriangles[triBase];
            const t1 = tile.detailTriangles[triBase + 1];
            const t2 = tile.detailTriangles[triBase + 2];

            // Get triangle vertices
            for (let k = 0; k < 3; k++) {
                const vertIndex = k === 0 ? t0 : k === 1 ? t1 : t2;
                let vx: number;
                let vy: number;
                let vz: number;

                if (vertIndex < poly.vertices.length) {
                    // Vertex from main polygon
                    const polyVertIndex = poly.vertices[vertIndex];
                    const vBase = polyVertIndex * 3;
                    vx = tile.vertices[vBase];
                    vy = tile.vertices[vBase + 1];
                    vz = tile.vertices[vBase + 2];
                } else {
                    // Vertex from detail mesh
                    const detailVertIndex = (polyDetail.verticesBase + vertIndex - poly.vertices.length) * 3;
                    vx = tile.detailVertices[detailVertIndex];
                    vy = tile.detailVertices[detailVertIndex + 1];
                    vz = tile.detailVertices[detailVertIndex + 2];
                }

                triPositions.push(vx, vy, vz);
                triColors.push(...col);
            }

            // Add triangle indices
            triIndices.push(triVertexIndex, triVertexIndex + 1, triVertexIndex + 2);
            triVertexIndex += 3;
        }
    }

    // Draw polygon boundaries
    const innerColor = [0.2, 0.2, 0.2];
    const outerColor = [0.6, 0.6, 1];

    for (const polyId in tile.polys) {
        const poly = tile.polys[polyId];

        for (let j = 0; j < poly.vertices.length; j++) {
            const nj = (j + 1) % poly.vertices.length;
            const nei = poly.neis[j];

            // Check if this is a boundary edge
            const isBoundary = (nei & POLY_NEIS_FLAG_EXT_LINK) !== 0;

            // Get edge vertices
            const polyVertIndex1 = poly.vertices[j];
            const polyVertIndex2 = poly.vertices[nj];

            const v1Base = polyVertIndex1 * 3;
            const v2Base = polyVertIndex2 * 3;

            const v1x = tile.vertices[v1Base];
            const v1y = tile.vertices[v1Base + 1] + 0.01; // Slightly offset up
            const v1z = tile.vertices[v1Base + 2];

            const v2x = tile.vertices[v2Base];
            const v2y = tile.vertices[v2Base + 1] + 0.01;
            const v2z = tile.vertices[v2Base + 2];

            if (isBoundary) {
                // Outer boundary edge
                outerPolyLinePositions.push(v1x, v1y, v1z);
                outerPolyLineColors.push(outerColor[0], outerColor[1], outerColor[2]);
                outerPolyLinePositions.push(v2x, v2y, v2z);
                outerPolyLineColors.push(outerColor[0], outerColor[1], outerColor[2]);
            } else {
                // Inner polygon edge
                interPolyLinePositions.push(v1x, v1y, v1z);
                interPolyLineColors.push(innerColor[0], innerColor[1], innerColor[2]);
                interPolyLinePositions.push(v2x, v2y, v2z);
                interPolyLineColors.push(innerColor[0], innerColor[1], innerColor[2]);
            }
        }
    }

    // Draw vertices
    const vertexColor = [1, 1, 1];
    for (let i = 0; i < tile.vertices.length; i += 3) {
        const worldX = tile.vertices[i];
        const worldY = tile.vertices[i + 1];
        const worldZ = tile.vertices[i + 2];

        vertexPositions.push(worldX, worldY, worldZ);
        vertexColors.push(vertexColor[0], vertexColor[1], vertexColor[2]);
    }

    // Add triangle mesh primitive
    if (triPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Triangles,
            positions: triPositions,
            colors: triColors,
            indices: triIndices,
            transparent: true,
            opacity: 0.8,
            doubleSided: true,
        });
    }

    // Add inter-poly boundary lines
    if (interPolyLinePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: interPolyLinePositions,
            colors: interPolyLineColors,
            transparent: true,
            opacity: 0.3,
            lineWidth: 1.5,
        });
    }

    // Add outer poly boundary lines
    if (outerPolyLinePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: outerPolyLinePositions,
            colors: outerPolyLineColors,
            transparent: true,
            opacity: 0.9,
            lineWidth: 2.5,
        });
    }

    // Add vertex points
    if (vertexPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Points,
            positions: vertexPositions,
            colors: vertexColors,
            size: 0.025,
        });
    }

    return primitives;
}

export function createNavMeshPolyHelper(
    navMesh: NavMesh,
    polyRef: NodeRef,
    color: [number, number, number] = [0, 0.75, 1],
): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    // Get tile and polygon from reference
    const { tileId, polyIndex } = getNodeByRef(navMesh, polyRef);

    const tile = navMesh.tiles[tileId];
    if (!tile || !tile.polys[polyIndex]) {
        // Return empty array if polygon not found
        return primitives;
    }

    const poly = tile.polys[polyIndex];

    // Get the detail mesh for this polygon
    const detailMesh = tile.detailMeshes?.[polyIndex];
    if (!detailMesh) {
        // Fallback: draw basic polygon without detail mesh
        const triPositions: number[] = [];
        const triColors: number[] = [];
        const triIndices: number[] = [];

        // Create a simple triangle fan from the polygon vertices
        if (poly.vertices.length >= 3) {
            const baseColor = [color[0] * 0.25, color[1] * 0.25, color[2] * 0.25]; // Transparent

            for (let i = 2; i < poly.vertices.length; i++) {
                const v0Index = poly.vertices[0] * 3;
                const v1Index = poly.vertices[i - 1] * 3;
                const v2Index = poly.vertices[i] * 3;

                // Add triangle vertices
                triPositions.push(tile.vertices[v0Index], tile.vertices[v0Index + 1], tile.vertices[v0Index + 2]);
                triPositions.push(tile.vertices[v1Index], tile.vertices[v1Index + 1], tile.vertices[v1Index + 2]);
                triPositions.push(tile.vertices[v2Index], tile.vertices[v2Index + 1], tile.vertices[v2Index + 2]);

                // Add colors
                for (let j = 0; j < 3; j++) {
                    triColors.push(baseColor[0], baseColor[1], baseColor[2]);
                }

                // Add indices
                const baseIndex = (i - 2) * 3;
                triIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
            }
        }

        if (triPositions.length > 0) {
            primitives.push({
                type: DebugPrimitiveType.Triangles,
                positions: triPositions,
                colors: triColors,
                indices: triIndices,
                transparent: true,
                opacity: 0.6,
                doubleSided: true,
            });
        }

        return primitives;
    }

    // Draw detail triangles for this polygon
    const triPositions: number[] = [];
    const triColors: number[] = [];
    const triIndices: number[] = [];

    const baseColor = [color[0] * 0.25, color[1] * 0.25, color[2] * 0.25]; // Make color transparent

    for (let i = 0; i < detailMesh.trianglesCount; ++i) {
        const t = (detailMesh.trianglesBase + i) * 4;
        const detailTriangles = tile.detailTriangles;

        for (let j = 0; j < 3; ++j) {
            const vertIndex = detailTriangles[t + j];

            if (vertIndex < poly.vertices.length) {
                const polyVertIndex = poly.vertices[vertIndex] * 3;
                triPositions.push(
                    tile.vertices[polyVertIndex],
                    tile.vertices[polyVertIndex + 1],
                    tile.vertices[polyVertIndex + 2],
                );
            } else {
                const detailVertIndex = (detailMesh.verticesBase + vertIndex - poly.vertices.length) * 3;
                triPositions.push(
                    tile.detailVertices[detailVertIndex],
                    tile.detailVertices[detailVertIndex + 1],
                    tile.detailVertices[detailVertIndex + 2],
                );
            }

            triColors.push(baseColor[0], baseColor[1], baseColor[2]);
        }

        const baseIndex = i * 3;
        triIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
    }

    if (triPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Triangles,
            positions: triPositions,
            colors: triColors,
            indices: triIndices,
            transparent: true,
            opacity: 0.6,
            doubleSided: true,
        });
    }

    return primitives;
}

export function createNavMeshTileBvTreeHelper(navMeshTile: NavMeshTile): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    if (navMeshTile.bvTree.nodes.length === 0) {
        return primitives;
    }

    // Arrays for wireframe box edges
    const linePositions: number[] = [];
    const lineColors: number[] = [];

    // Color for BV tree nodes (white with transparency)
    const nodeColor = [1, 1, 1];

    // Calculate inverse quantization factor (cs = 1.0f / tile->header->bvQuantFactor)
    const cs = 1.0 / navMeshTile.bvTree.quantFactor;

    // Draw BV nodes - only internal nodes (leaf indices are positive, internal are negative)
    for (let i = 0; i < navMeshTile.bvTree.nodes.length; i++) {
        const node = navMeshTile.bvTree.nodes[i];

        // Leaf indices are positive.
        if (node.i < 0) continue;

        // Calculate world coordinates from quantized bounds
        const minX = navMeshTile.bounds[0][0] + node.bounds[0][0] * cs;
        const minY = navMeshTile.bounds[0][1] + node.bounds[0][1] * cs;
        const minZ = navMeshTile.bounds[0][2] + node.bounds[0][2] * cs;
        const maxX = navMeshTile.bounds[0][0] + node.bounds[1][0] * cs;
        const maxY = navMeshTile.bounds[0][1] + node.bounds[1][1] * cs;
        const maxZ = navMeshTile.bounds[0][2] + node.bounds[1][2] * cs;

        // Create wireframe box edges
        // Bottom face
        linePositions.push(minX, minY, minZ, maxX, minY, minZ);
        linePositions.push(maxX, minY, minZ, maxX, minY, maxZ);
        linePositions.push(maxX, minY, maxZ, minX, minY, maxZ);
        linePositions.push(minX, minY, maxZ, minX, minY, minZ);

        // Top face
        linePositions.push(minX, maxY, minZ, maxX, maxY, minZ);
        linePositions.push(maxX, maxY, minZ, maxX, maxY, maxZ);
        linePositions.push(maxX, maxY, maxZ, minX, maxY, maxZ);
        linePositions.push(minX, maxY, maxZ, minX, maxY, minZ);

        // Vertical edges
        linePositions.push(minX, minY, minZ, minX, maxY, minZ);
        linePositions.push(maxX, minY, minZ, maxX, maxY, minZ);
        linePositions.push(maxX, minY, maxZ, maxX, maxY, maxZ);
        linePositions.push(minX, minY, maxZ, minX, maxY, maxZ);

        // Add colors for all line segments (24 vertices = 12 line segments)
        for (let j = 0; j < 24; j++) {
            lineColors.push(nodeColor[0], nodeColor[1], nodeColor[2]);
        }
    }

    // Create line segments primitive
    if (linePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: linePositions,
            colors: lineColors,
            transparent: true,
            opacity: 0.5,
            lineWidth: 1.0,
        });
    }

    return primitives;
}

export function createNavMeshBvTreeHelper(navMesh: NavMesh): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    // Draw BV tree for all tiles in the nav mesh
    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        if (!tile) continue;

        const tilePrimitives = createNavMeshTileBvTreeHelper(tile);
        primitives.push(...tilePrimitives);
    }

    return primitives;
}

const _createNavMeshLinksHelper_sourceCenter = vec3.create();
const _createNavMeshLinksHelper_targetCenter = vec3.create();
const _createNavMeshLinksHelper_edgeStart = vec3.create();
const _createNavMeshLinksHelper_edgeEnd = vec3.create();
const _createNavMeshLinksHelper_edgeMidpoint = vec3.create();
const _createNavMeshLinksHelper_sourcePoint = vec3.create();
const _createNavMeshLinksHelper_targetPoint = vec3.create();

export function createNavMeshLinksHelper(navMesh: NavMesh): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    // Arrays for line data
    const linePositions: number[] = [];
    const lineColors: number[] = [];

    // Color for navmesh links
    const linkColor: [number, number, number] = [1, 1, 0]; // Bright yellow

    // Helper function to lerp between two values
    const lerp = (start: number, end: number, t: number): number => start + (end - start) * t;

    // Helper function to calculate polygon center
    const getPolyCenter = (out: Vec3, tile: NavMeshTile, poly: any): Vec3 => {
        let centerX = 0;
        let centerY = 0;
        let centerZ = 0;
        const nv = poly.vertices.length;

        for (let i = 0; i < nv; i++) {
            const vertIndex = poly.vertices[i] * 3;
            centerX += tile.vertices[vertIndex];
            centerY += tile.vertices[vertIndex + 1];
            centerZ += tile.vertices[vertIndex + 2];
        }

        out[0] = centerX / nv;
        out[1] = centerY / nv;
        out[2] = centerZ / nv;

        return out;
    };

    // Process each link
    for (const link of navMesh.links) {
        if (!link.allocated) continue;

        // Get source polygon info
        const { tileId: sourceTileId, polyIndex: sourcePolyId } = navMesh.nodes[link.fromNodeIndex];
        const sourceTile = navMesh.tiles[sourceTileId];
        const sourcePoly = sourceTile?.polys[sourcePolyId];

        // Get target polygon info
        const { tileId: targetTileId, polyIndex: targetPolyId } = navMesh.nodes[link.toNodeIndex];
        const targetTile = navMesh.tiles[targetTileId];
        const targetPoly = targetTile?.polys[targetPolyId];

        if (!sourceTile || !sourcePoly || !targetTile || !targetPoly) {
            continue;
        }

        // Calculate polygon centers
        const sourceCenter = getPolyCenter(_createNavMeshLinksHelper_sourceCenter, sourceTile, sourcePoly);
        const targetCenter = getPolyCenter(_createNavMeshLinksHelper_targetCenter, targetTile, targetPoly);

        // Get the edge vertices for this link
        const edgeIndex = link.edge;
        const nextEdgeIndex = (edgeIndex + 1) % sourcePoly.vertices.length;

        const v0Index = sourcePoly.vertices[edgeIndex] * 3;
        const v1Index = sourcePoly.vertices[nextEdgeIndex] * 3;

        const edgeStart = vec3.fromBuffer(_createNavMeshLinksHelper_edgeStart, sourceTile.vertices, v0Index);
        const edgeEnd = vec3.fromBuffer(_createNavMeshLinksHelper_edgeEnd, sourceTile.vertices, v1Index);

        // Calculate edge midpoint
        const edgeMidpoint = vec3.add(_createNavMeshLinksHelper_edgeMidpoint, edgeStart, edgeEnd);
        vec3.scale(edgeMidpoint, edgeMidpoint, 0.5);

        // Move the edge midpoint slightly towards the polygon center (10% of the way)
        const inwardFactor = 0.1;
        const sourcePoint = vec3.lerp(_createNavMeshLinksHelper_sourcePoint, edgeMidpoint, sourceCenter, inwardFactor);
        sourcePoint[1] += 0.05; // slight y offset

        // For the target, use the target polygon center
        const targetPoint = vec3.copy(_createNavMeshLinksHelper_targetPoint, targetCenter);
        targetPoint[1] += 0.05; // slight y offset

        // Create arced line with multiple segments
        const numSegments = 12;
        const arcHeight = 0.3;

        for (let i = 0; i < numSegments; i++) {
            const t0 = i / numSegments;
            const t1 = (i + 1) / numSegments;

            // Calculate positions along arc with sinusoidal height
            const x0 = lerp(sourcePoint[0], targetPoint[0], t0);
            const y0 = lerp(sourcePoint[1], targetPoint[1], t0) + Math.sin(t0 * Math.PI) * arcHeight;
            const z0 = lerp(sourcePoint[2], targetPoint[2], t0);

            const x1 = lerp(sourcePoint[0], targetPoint[0], t1);
            const y1 = lerp(sourcePoint[1], targetPoint[1], t1) + Math.sin(t1 * Math.PI) * arcHeight;
            const z1 = lerp(sourcePoint[2], targetPoint[2], t1);

            // Add line segment
            linePositions.push(x0, y0, z0, x1, y1, z1);

            // Add colors for both endpoints
            lineColors.push(linkColor[0], linkColor[1], linkColor[2]);
            lineColors.push(linkColor[0], linkColor[1], linkColor[2]);
        }

        // Add a simple arrow at the end to show direction
        const arrowT = 0.85; // Position arrow near the end
        const arrowX = lerp(sourcePoint[0], targetPoint[0], arrowT);
        const arrowY = lerp(sourcePoint[1], targetPoint[1], arrowT) + Math.sin(arrowT * Math.PI) * arcHeight;
        const arrowZ = lerp(sourcePoint[2], targetPoint[2], arrowT);

        // Calculate direction for arrow
        const nextT = 0.95;
        const nextX = lerp(sourcePoint[0], targetPoint[0], nextT);
        const nextY = lerp(sourcePoint[1], targetPoint[1], nextT) + Math.sin(nextT * Math.PI) * arcHeight;
        const nextZ = lerp(sourcePoint[2], targetPoint[2], nextT);

        const dirX = nextX - arrowX;
        const dirY = nextY - arrowY;
        const dirZ = nextZ - arrowZ;
        const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
        const nx = dirX / len;
        const ny = dirY / len;
        const nz = dirZ / len;

        // Create arrow head with two lines
        const arrowLength = 0.15;
        const arrowWidth = 0.08;

        // Calculate perpendicular vectors for arrow wings
        const perpX = -nz;
        const perpZ = nx;

        // Left wing
        linePositions.push(
            arrowX,
            arrowY,
            arrowZ,
            arrowX - nx * arrowLength + perpX * arrowWidth,
            arrowY - ny * arrowLength,
            arrowZ - nz * arrowLength + perpZ * arrowWidth,
        );

        // Right wing
        linePositions.push(
            arrowX,
            arrowY,
            arrowZ,
            arrowX - nx * arrowLength - perpX * arrowWidth,
            arrowY - ny * arrowLength,
            arrowZ - nz * arrowLength - perpZ * arrowWidth,
        );

        // Add colors for arrow (4 vertices = 2 line segments)
        for (let k = 0; k < 4; k++) {
            lineColors.push(linkColor[0], linkColor[1], linkColor[2]);
        }
    }

    if (linePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: linePositions,
            colors: lineColors,
            transparent: true,
            opacity: 0.9,
            lineWidth: 3.0,
        });
    }

    return primitives;
}

export function createNavMeshTilePortalsHelper(navMeshTile: NavMeshTile): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    const padx = 0.04; // (purely visual)
    const pady = navMeshTile.walkableClimb; // vertical extent

    const sideColors: Record<number, [number, number, number]> = {
        0: [128 / 255, 0, 0], // red
        2: [0, 128 / 255, 0], // green
        4: [128 / 255, 0, 128 / 255], // magenta
        6: [0, 128 / 255, 128 / 255], // cyan
    };

    const positions: number[] = [];
    const colors: number[] = [];

    const drawSides = [0, 2, 4, 6];
    for (const side of drawSides) {
        const matchMask = POLY_NEIS_FLAG_EXT_LINK | side;
        const color = sideColors[side];
        if (!color) continue;

        for (const polyId in navMeshTile.polys) {
            const poly = navMeshTile.polys[polyId];
            const nv = poly.vertices.length;
            for (let j = 0; j < nv; j++) {
                if (poly.neis[j] !== matchMask) continue; // must be exact match

                const v0Index = poly.vertices[j];
                const v1Index = poly.vertices[(j + 1) % nv];

                const aBase = v0Index * 3;
                const bBase = v1Index * 3;

                const ax = navMeshTile.vertices[aBase];
                const ay = navMeshTile.vertices[aBase + 1];
                const az = navMeshTile.vertices[aBase + 2];
                const bx = navMeshTile.vertices[bBase];
                const by = navMeshTile.vertices[bBase + 1];
                const bz = navMeshTile.vertices[bBase + 2];

                if (side === 0 || side === 4) {
                    const x = ax + (side === 0 ? -padx : padx);
                    // Four edges of rectangle (8 vertices for 4 line segments)
                    positions.push(x, ay - pady, az, x, ay + pady, az);
                    positions.push(x, ay + pady, az, x, by + pady, bz);
                    positions.push(x, by + pady, bz, x, by - pady, bz);
                    positions.push(x, by - pady, bz, x, ay - pady, az);
                } else if (side === 2 || side === 6) {
                    const z = az + (side === 2 ? -padx : padx);
                    positions.push(ax, ay - pady, z, ax, ay + pady, z);
                    positions.push(ax, ay + pady, z, bx, by + pady, z);
                    positions.push(bx, by + pady, z, bx, by - pady, z);
                    positions.push(bx, by - pady, z, ax, ay - pady, z);
                }

                // Add color entries (8 vertices per rectangle)
                for (let k = 0; k < 8; k++) {
                    colors.push(color[0], color[1], color[2]);
                }
            }
        }
    }

    if (positions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions,
            colors,
            transparent: true,
            opacity: 0.5,
            lineWidth: 2.0,
        });
    }

    return primitives;
}

export function createNavMeshPortalsHelper(navMesh: NavMesh): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        if (!tile) continue;
        const tilePrimitives = createNavMeshTilePortalsHelper(tile);
        primitives.push(...tilePrimitives);
    }

    return primitives;
}

export function createSearchNodesHelper(nodePool: SearchNodePool): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    if (!nodePool || Object.keys(nodePool).length === 0) {
        return primitives;
    }

    const yOffset = 0.5;
    const pointPositions: number[] = [];
    const pointColors: number[] = [];
    const linePositions: number[] = [];
    const lineColors: number[] = [];

    // Color (255,192,0) -> (1, 0.7529, 0)
    const pointColor = [1.0, 192 / 255, 0.0];
    const lineColor = [1.0, 192 / 255, 0.0];

    // Collect all nodes from the pool (each nodeRef can have multiple states)
    for (const nodeRef in nodePool) {
        const nodes = nodePool[nodeRef];
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const [x, y, z] = node.position;
            pointPositions.push(x, y + yOffset, z);
            pointColors.push(pointColor[0], pointColor[1], pointColor[2]);
        }
    }

    // Lines to parents
    for (const nodeRef in nodePool) {
        const nodes = nodePool[nodeRef];
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (node.parentNodeRef === null || node.parentState === null) continue;

            // Find parent node
            const parentNodes = nodePool[node.parentNodeRef];
            if (!parentNodes) continue;

            let parent: SearchNode | undefined;
            for (let j = 0; j < parentNodes.length; j++) {
                if (parentNodes[j].state === node.parentState) {
                    parent = parentNodes[j];
                    break;
                }
            }

            if (!parent) continue;

            const [cx, cy, cz] = node.position;
            const [px, py, pz] = parent.position;
            linePositions.push(cx, cy + yOffset, cz, px, py + yOffset, pz);
            lineColors.push(lineColor[0], lineColor[1], lineColor[2], lineColor[0], lineColor[1], lineColor[2]);
        }
    }

    if (pointPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Points,
            positions: pointPositions,
            colors: pointColors,
            size: 0.01,
            transparent: true,
            opacity: 1.0,
        });
    }

    if (linePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: linePositions,
            colors: lineColors,
            transparent: true,
            opacity: 0.5,
            lineWidth: 2.0,
        });
    }

    return primitives;
}

export function createNavMeshOffMeshConnectionsHelper(navMesh: NavMesh): DebugPrimitive[] {
    const primitives: DebugPrimitive[] = [];

    const arcSegments = 16;
    const circleSegments = 20;

    // Aggregated arrays for arcs & circles
    const arcPositions: number[] = [];
    const arcColors: number[] = [];
    const circlePositions: number[] = [];
    const circleColors: number[] = [];

    const arcColor: [number, number, number] = [255 / 255, 196 / 255, 0 / 255]; // main arc color
    const pillarColor: [number, number, number] = [0 / 255, 48 / 255, 64 / 255]; // pillar color
    const oneWayEndColor: [number, number, number] = [220 / 255, 32 / 255, 16 / 255]; // end marker if one-way

    // Helper function to lerp between two values
    const lerp = (start: number, end: number, t: number): number => start + (end - start) * t;

    for (const id in navMesh.offMeshConnections) {
        const con = navMesh.offMeshConnections[id];
        if (!con) continue;
        const start = con.start;
        const end = con.end;
        const radius = con.radius;

        // Arc polyline (adds a vertical sinusoidal lift up to 0.25 at mid)
        for (let i = 0; i < arcSegments; i++) {
            const t0 = i / arcSegments;
            const t1 = (i + 1) / arcSegments;
            const x0 = lerp(start[0], end[0], t0);
            const y0 = lerp(start[1], end[1], t0) + Math.sin(t0 * Math.PI) * 0.25;
            const z0 = lerp(start[2], end[2], t0);
            const x1 = lerp(start[0], end[0], t1);
            const y1 = lerp(start[1], end[1], t1) + Math.sin(t1 * Math.PI) * 0.25;
            const z1 = lerp(start[2], end[2], t1);
            arcPositions.push(x0, y0, z0, x1, y1, z1);
            for (let k = 0; k < 2; k++) arcColors.push(arcColor[0], arcColor[1], arcColor[2]);
        }

        // One-way direction arrow in the middle of arc
        if (con.direction === OffMeshConnectionDirection.START_TO_END) {
            const tMid = 0.5;
            const xMid = lerp(start[0], end[0], tMid);
            const yMid = lerp(start[1], end[1], tMid) + 0.25;
            const zMid = lerp(start[2], end[2], tMid);
            const dirX = end[0] - start[0];
            const dirZ = end[2] - start[2];
            const len = Math.hypot(dirX, dirZ) || 1;
            const nx = dirX / len;
            const nz = dirZ / len;
            const back = 0.3;
            arcPositions.push(
                xMid,
                yMid,
                zMid,
                xMid - nx * back + nz * back * 0.5,
                yMid - 0.05,
                zMid - nz * back - nx * back * 0.5,
                xMid,
                yMid,
                zMid,
                xMid - nx * back - nz * back * 0.5,
                yMid - 0.05,
                zMid - nz * back + nx * back * 0.5,
            );
            for (let k = 0; k < 4; k++) arcColors.push(arcColor[0], arcColor[1], arcColor[2]);
        }

        const addCircle = (center: [number, number, number], color: [number, number, number]) => {
            for (let i = 0; i < circleSegments; i++) {
                const a0 = (i / circleSegments) * Math.PI * 2;
                const a1 = ((i + 1) / circleSegments) * Math.PI * 2;
                const x0 = center[0] + Math.cos(a0) * radius;
                const z0 = center[2] + Math.sin(a0) * radius;
                const x1 = center[0] + Math.cos(a1) * radius;
                const z1 = center[2] + Math.sin(a1) * radius;
                circlePositions.push(x0, center[1] + 0.1, z0, x1, center[1] + 0.1, z1);
                for (let k = 0; k < 2; k++) circleColors.push(color[0], color[1], color[2]);
            }
            // Pillar
            circlePositions.push(center[0], center[1], center[2], center[0], center[1] + 0.2, center[2]);
            for (let k = 0; k < 2; k++) circleColors.push(pillarColor[0], pillarColor[1], pillarColor[2]);
        };

        addCircle(start, arcColor);
        addCircle(end, con.direction === OffMeshConnectionDirection.BIDIRECTIONAL ? arcColor : oneWayEndColor);
    }

    if (arcPositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: arcPositions,
            colors: arcColors,
            transparent: true,
            opacity: 0.9,
            lineWidth: 2.0,
        });
    }

    if (circlePositions.length > 0) {
        primitives.push({
            type: DebugPrimitiveType.Lines,
            positions: circlePositions,
            colors: circleColors,
            transparent: true,
            opacity: 0.8,
            lineWidth: 1.5,
        });
    }

    return primitives;
}

// All debug helper functions are now implemented
// The pattern is: return DebugPrimitive[] where each primitive has a 'type' field
