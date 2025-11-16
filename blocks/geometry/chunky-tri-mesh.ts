import type { Vec2 } from 'mathcat';

/*
 * Spatial chunking utility for triangles based on Recast's ChunkyTriMesh.
 *
 * This builds a hierarchical spatial data structure (binary tree) that allows
 * efficient querying of triangles overlapping with spatial regions, avoiding
 * the need to test all triangles against each tile.
 */

type Box2 = [min: Vec2, max: Vec2];

export type ChunkyTriMeshNode = {
    /** bounding box of this node in XZ plane */
    bounds: Box2;

    /**
     * for leaf nodes: index into the triangles array
     * for internal nodes: negative escape index for tree traversal
     */
    index: number;

    /**
     * for leaf nodes: number of triangles in this chunk
     * for internal nodes: 0
     */
    count: number;
};

/** Spatial chunking structure for triangles */
export type ChunkyTriMesh = {
    /** tree nodes for spatial hierarchy */
    nodes: ChunkyTriMeshNode[];

    /** reordered triangle indices */
    triangles: number[];

    /** maximum triangles per leaf chunk */
    maxTrisPerChunk: number;
};

type BoundsItem = {
    bounds: Box2;
    index: number;
};

const calculateTriangleBounds = (vertices: ArrayLike<number>, indices: ArrayLike<number>, triIndex: number): Box2 => {
    const i0 = indices[triIndex * 3 + 0] * 3;
    const i1 = indices[triIndex * 3 + 1] * 3;
    const i2 = indices[triIndex * 3 + 2] * 3;

    const v0x = vertices[i0 + 0];
    const v0z = vertices[i0 + 2];
    const v1x = vertices[i1 + 0];
    const v1z = vertices[i1 + 2];
    const v2x = vertices[i2 + 0];
    const v2z = vertices[i2 + 2];

    return [
        [Math.min(v0x, v1x, v2x), Math.min(v0z, v1z, v2z)],
        [Math.max(v0x, v1x, v2x), Math.max(v0z, v1z, v2z)],
    ];
};

const calculateExtents = (items: BoundsItem[], min: number, max: number): Box2 => {
    const bounds: Box2 = [
        [items[min].bounds[0][0], items[min].bounds[0][1]],
        [items[min].bounds[1][0], items[min].bounds[1][1]],
    ];

    for (let i = min + 1; i < max; i++) {
        const item = items[i];
        bounds[0][0] = Math.min(bounds[0][0], item.bounds[0][0]);
        bounds[0][1] = Math.min(bounds[0][1], item.bounds[0][1]);
        bounds[1][0] = Math.max(bounds[1][0], item.bounds[1][0]);
        bounds[1][1] = Math.max(bounds[1][1], item.bounds[1][1]);
    }

    return bounds;
};

const longestAxis = (x: number, y: number): 0 | 1 => {
    return y > x ? 1 : 0;
}

const subdivide = (
    items: BoundsItem[],
    min: number,
    max: number,
    trisPerChunk: number,
    nodes: ChunkyTriMeshNode[],
    outTriangles: number[],
    inTriangles: ArrayLike<number>,
): void => {
    const nodeIndex = nodes.length;
    const count = max - min;

    const node: ChunkyTriMeshNode = {
        bounds: [
            [0, 0],
            [0, 0],
        ],
        index: 0,
        count: 0,
    };

    nodes.push(node);

    if (count <= trisPerChunk) {
        // leaf node - calculate bounds and copy triangles
        node.bounds = calculateExtents(items, min, max);
        node.index = outTriangles.length / 3;
        node.count = count;

        // copy triangle indices
        for (let i = min; i < max; i++) {
            const triIndex = items[i].index;
            outTriangles.push(inTriangles[triIndex * 3 + 0], inTriangles[triIndex * 3 + 1], inTriangles[triIndex * 3 + 2]);
        }
    } else {
        // internal node - split along longest axis
        node.bounds = calculateExtents(items, min, max);

        const axis = longestAxis(node.bounds[1][0] - node.bounds[0][0], node.bounds[1][1] - node.bounds[0][1]);

        // sort items along the chosen axis (in-place sort of the range [min, max))
        const sorted = items.slice(min, max).sort((a, b) => {
            return a.bounds[0][axis] - b.bounds[0][axis];
        });
        for (let i = 0; i < sorted.length; i++) {
            items[min + i] = sorted[i];
        }

        const split = min + Math.floor(count / 2);

        // recursively build left and right subtrees
        subdivide(items, min, split, trisPerChunk, nodes, outTriangles, inTriangles);
        subdivide(items, split, max, trisPerChunk, nodes, outTriangles, inTriangles);

        // store escape index (negative to indicate internal node)
        const escapeIndex = nodes.length - nodeIndex;
        node.index = -escapeIndex;
    }
}

/**
 * Create a chunky triangle mesh from vertices and indices
 *
 * @param vertices flat array of vertex positions [x, y, z, x, y, z, ...]
 * @param indices flat array of triangle indices [i0, i1, i2, i0, i1, i2, ...]
 * @param trisPerChunk target number of triangles per leaf chunk (default: 256)
 * @returns ChunkyTriMesh spatial data structure
 */
export const create = (vertices: ArrayLike<number>, indices: ArrayLike<number>, trisPerChunk: number = 256): ChunkyTriMesh => {
    const numTriangles = indices.length / 3;

    // build bounding items for all triangles
    const items: BoundsItem[] = [];
    for (let i = 0; i < numTriangles; i++) {
        items.push({
            bounds: calculateTriangleBounds(vertices, indices, i),
            index: i,
        });
    }

    // build spatial tree
    const nodes: ChunkyTriMeshNode[] = [];
    const triangles: number[] = [];

    subdivide(items, 0, numTriangles, trisPerChunk, nodes, triangles, indices);

    // calculate max triangles per chunk
    let maxTrisPerChunk = 0;
    for (const node of nodes) {
        if (node.index >= 0 && node.count > maxTrisPerChunk) {
            maxTrisPerChunk = node.count;
        }
    }

    return {
        nodes,
        triangles,
        maxTrisPerChunk,
    };
}

const checkOverlapRect = (aMin: Vec2, aMax: Vec2, bMin: Vec2, bMax: Vec2): boolean => {
    if (aMin[0] > bMax[0] || aMax[0] < bMin[0]) return false;
    if (aMin[1] > bMax[1] || aMax[1] < bMin[1]) return false;
    return true;
};

/**
 * Get all triangle chunks that overlap with a rectangular region
 *
 * @param chunkyTriMesh the chunky tri mesh to query
 * @param boundsMin minimum corner of query rectangle [x, z]
 * @param boundsMax maximum corner of query rectangle [x, z]
 * @returns Array of node indices that overlap the query region
 */
export const getChunksOverlappingRect = (chunkyTriMesh: ChunkyTriMesh, boundsMin: Vec2, boundsMax: Vec2): number[] => {
    const { nodes } = chunkyTriMesh;
    const result: number[] = [];

    // traverse tree
    let i = 0;
    while (i < nodes.length) {
        const node = nodes[i];
        const overlap = checkOverlapRect(boundsMin, boundsMax, node.bounds[0], node.bounds[1]);
        const isLeaf = node.index >= 0;

        if (isLeaf && overlap) {
            result.push(i);
        }

        if (overlap || isLeaf) {
            i++;
        } else {
            // skip this subtree using escape index
            i += -node.index;
        }
    }

    return result;
};

/**
 * Get all triangles that overlap with a rectangular region
 *
 * @param chunkyTriMesh the chunky tri mesh to query
 * @param boundsMin minimum corner of query rectangle [x, z]
 * @param boundsMax maximum corner of query rectangle [x, z]
 * @returns Flat array of triangle indices [i0, i1, i2, i0, i1, i2, ...]
 */
export const getTrianglesInRect = (chunkyTriMesh: ChunkyTriMesh, boundsMin: Vec2, boundsMax: Vec2): number[] => {
    const chunks = getChunksOverlappingRect(chunkyTriMesh, boundsMin, boundsMax);
    const result: number[] = [];

    for (const chunkIndex of chunks) {
        const node = chunkyTriMesh.nodes[chunkIndex];
        const startIndex = node.index * 3;
        const endIndex = startIndex + node.count * 3;

        for (let i = startIndex; i < endIndex; i++) {
            result.push(chunkyTriMesh.triangles[i]);
        }
    }

    return result;
};

/**
 * Check if a line segment overlaps with a 2D bounding box
 */
const checkOverlapSegment = (p: Vec2, q: Vec2, bMin: Vec2, bMax: Vec2): boolean => {
    const EPSILON = 1e-6;

    let tMin = 0;
    let tMax = 1;
    const d: Vec2 = [q[0] - p[0], q[1] - p[1]];

    for (let i = 0; i < 2; i++) {
        if (Math.abs(d[i]) < EPSILON) {
            // Ray is parallel to slab
            if (p[i] < bMin[i] || p[i] > bMax[i]) {
                return false;
            }
        } else {
            // Compute intersection t values
            const ood = 1.0 / d[i];
            let t1 = (bMin[i] - p[i]) * ood;
            let t2 = (bMax[i] - p[i]) * ood;

            if (t1 > t2) {
                [t1, t2] = [t2, t1];
            }

            tMin = Math.max(tMin, t1);
            tMax = Math.min(tMax, t2);

            if (tMin > tMax) {
                return false;
            }
        }
    }

    return true;
};

/**
 * Get all triangle chunks that overlap with a line segment
 *
 * @param chunkyTriMesh the chunky tri mesh to query
 * @param p start point of segment [x, z]
 * @param q end point of segment [x, z]
 * @returns Array of node indices that overlap the segment
 */
export const getChunksOverlappingSegment = (chunkyTriMesh: ChunkyTriMesh, p: Vec2, q: Vec2): number[] => {
    const { nodes } = chunkyTriMesh;
    const result: number[] = [];

    // traverse tree
    let i = 0;
    while (i < nodes.length) {
        const node = nodes[i];
        const overlap = checkOverlapSegment(p, q, node.bounds[0], node.bounds[1]);
        const isLeaf = node.index >= 0;

        if (isLeaf && overlap) {
            result.push(i);
        }

        if (overlap || isLeaf) {
            i++;
        } else {
            // skip this subtree using escape index
            i += -node.index;
        }
    }

    return result;
};
