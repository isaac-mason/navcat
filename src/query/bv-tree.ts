import type { Box3 } from 'maaths';
import { MESH_NULL_IDX } from '../generate';
import type { NavMeshBvNode, NavMeshTileBvTree, NavMeshTileParams } from './nav-mesh';

const compareItemX = (a: NavMeshBvNode, b: NavMeshBvNode): number => {
    if (a.bounds[0][0] < b.bounds[0][0]) return -1;
    if (a.bounds[0][0] > b.bounds[0][0]) return 1;
    return 0;
};

const compareItemY = (a: NavMeshBvNode, b: NavMeshBvNode): number => {
    if (a.bounds[0][1] < b.bounds[0][1]) return -1;
    if (a.bounds[0][1] > b.bounds[0][1]) return 1;
    return 0;
};

const compareItemZ = (a: NavMeshBvNode, b: NavMeshBvNode): number => {
    if (a.bounds[0][2] < b.bounds[0][2]) return -1;
    if (a.bounds[0][2] > b.bounds[0][2]) return 1;
    return 0;
};

const calcExtends = (items: NavMeshBvNode[], imin: number, imax: number): Box3 => {
    const bounds: Box3 = [
        [items[imin].bounds[0][0], items[imin].bounds[0][1], items[imin].bounds[0][2]],
        [items[imin].bounds[1][0], items[imin].bounds[1][1], items[imin].bounds[1][2]],
    ];

    for (let i = imin + 1; i < imax; ++i) {
        const it = items[i];
        if (it.bounds[0][0] < bounds[0][0]) bounds[0][0] = it.bounds[0][0];
        if (it.bounds[0][1] < bounds[0][1]) bounds[0][1] = it.bounds[0][1];
        if (it.bounds[0][2] < bounds[0][2]) bounds[0][2] = it.bounds[0][2];

        if (it.bounds[1][0] > bounds[1][0]) bounds[1][0] = it.bounds[1][0];
        if (it.bounds[1][1] > bounds[1][1]) bounds[1][1] = it.bounds[1][1];
        if (it.bounds[1][2] > bounds[1][2]) bounds[1][2] = it.bounds[1][2];
    }

    return bounds;
};

const longestAxis = (x: number, y: number, z: number): number => {
    let axis = 0;
    let maxVal = x;
    if (y > maxVal) {
        axis = 1;
        maxVal = y;
    }
    if (z > maxVal) {
        axis = 2;
    }
    return axis;
};

const subdivide = (
    items: NavMeshBvNode[],
    imin: number,
    imax: number,
    curNode: { value: number },
    nodes: NavMeshBvNode[],
): void => {
    const inum = imax - imin;
    const icur = curNode.value;

    const node: NavMeshBvNode = {
        bounds: [
            [0, 0, 0],
            [0, 0, 0],
        ],
        i: 0,
    };
    nodes[curNode.value++] = node;

    if (inum === 1) {
        // Leaf
        node.bounds[0][0] = items[imin].bounds[0][0];
        node.bounds[0][1] = items[imin].bounds[0][1];
        node.bounds[0][2] = items[imin].bounds[0][2];

        node.bounds[1][0] = items[imin].bounds[1][0];
        node.bounds[1][1] = items[imin].bounds[1][1];
        node.bounds[1][2] = items[imin].bounds[1][2];

        node.i = items[imin].i;
    } else {
        // Split
        const extents = calcExtends(items, imin, imax);
        node.bounds[0][0] = extents[0][0];
        node.bounds[0][1] = extents[0][1];
        node.bounds[0][2] = extents[0][2];
        node.bounds[1][0] = extents[1][0];
        node.bounds[1][1] = extents[1][1];
        node.bounds[1][2] = extents[1][2];

        const axis = longestAxis(
            node.bounds[1][0] - node.bounds[0][0],
            node.bounds[1][1] - node.bounds[0][1],
            node.bounds[1][2] - node.bounds[0][2],
        );

        if (axis === 0) {
            // Sort along x-axis
            const segment = items.slice(imin, imax);
            segment.sort(compareItemX);
            for (let i = 0; i < segment.length; i++) {
                items[imin + i] = segment[i];
            }
        } else if (axis === 1) {
            // Sort along y-axis
            const segment = items.slice(imin, imax);
            segment.sort(compareItemY);
            for (let i = 0; i < segment.length; i++) {
                items[imin + i] = segment[i];
            }
        } else {
            // Sort along z-axis
            const segment = items.slice(imin, imax);
            segment.sort(compareItemZ);
            for (let i = 0; i < segment.length; i++) {
                items[imin + i] = segment[i];
            }
        }

        const isplit = imin + Math.floor(inum / 2);

        // Left
        subdivide(items, imin, isplit, curNode, nodes);
        // Right
        subdivide(items, isplit, imax, curNode, nodes);

        const iescape = curNode.value - icur;
        // Negative index means escape.
        node.i = -iescape;
    }
};

/**
 * Builds a bounding volume tree for the given nav mesh tile.
 * @param navMeshTile the nav mesh tile to build the BV tree for
 * @returns
 */
export const buildNavMeshBvTree = (
    params: NavMeshTileParams,
): NavMeshTileBvTree => {
    // use cellSize for quantization factor
    const quantFactor = 1 / params.cellSize;
    
    // early exit if the tile has no polys
    if (params.polys.length === 0) {
        return {
            nodes: [],
            quantFactor,
        }
    }

    // allocate bv tree nodes for polys
    const items: NavMeshBvNode[] = new Array(Object.keys(params.polys).length);

    // calculate bounds for each polygon
    for (let i = 0; i < params.polys.length; i++) {
        const item: NavMeshBvNode = {
            bounds: [
                [0, 0, 0],
                [0, 0, 0],
            ],
            i,
        };

        const poly = params.polys[i];
        const nvp = poly.vertices.length;

        if (nvp > 0) {
            // expand bounds with polygon vertices
            const firstVertIndex = poly.vertices[0] * 3;

            item.bounds[0][0] = item.bounds[1][0] = params.vertices[firstVertIndex];
            item.bounds[0][1] = item.bounds[1][1] = params.vertices[firstVertIndex + 1];
            item.bounds[0][2] = item.bounds[1][2] = params.vertices[firstVertIndex + 2];

            for (let j = 1; j < nvp; j++) {
                const vertexIndex = poly.vertices[j];
                if (vertexIndex === MESH_NULL_IDX) break;

                const vertIndex = vertexIndex * 3;
                const x = params.vertices[vertIndex];
                const y = params.vertices[vertIndex + 1];
                const z = params.vertices[vertIndex + 2];

                if (x < item.bounds[0][0]) item.bounds[0][0] = x;
                if (y < item.bounds[0][1]) item.bounds[0][1] = y;
                if (z < item.bounds[0][2]) item.bounds[0][2] = z;

                if (x > item.bounds[1][0]) item.bounds[1][0] = x;
                if (y > item.bounds[1][1]) item.bounds[1][1] = y;
                if (z > item.bounds[1][2]) item.bounds[1][2] = z;
            }

            // expand bounds with additional detail vertices if available
            if (params.detailMeshes.length > 0 && params.detailVertices.length > 0) {
                const detailMesh = params.detailMeshes[i];
                const vb = detailMesh.verticesBase;
                const ndv = detailMesh.verticesCount;

                // iterate through additional detail vertices (not including poly vertices)
                for (let j = 0; j < ndv; j++) {
                    const vertIndex = (vb + j) * 3;
                    const x = params.detailVertices[vertIndex];
                    const y = params.detailVertices[vertIndex + 1];
                    const z = params.detailVertices[vertIndex + 2];

                    if (x < item.bounds[0][0]) item.bounds[0][0] = x;
                    if (y < item.bounds[0][1]) item.bounds[0][1] = y;
                    if (z < item.bounds[0][2]) item.bounds[0][2] = z;

                    if (x > item.bounds[1][0]) item.bounds[1][0] = x;
                    if (y > item.bounds[1][1]) item.bounds[1][1] = y;
                    if (z > item.bounds[1][2]) item.bounds[1][2] = z;
                }
            }

            // bv tree uses cellSize for all dimensions, quantize relative to tile bounds
            item.bounds[0][0] = (item.bounds[0][0] - params.bounds[0][0]) * quantFactor;
            item.bounds[0][1] = (item.bounds[0][1] - params.bounds[0][1]) * quantFactor;
            item.bounds[0][2] = (item.bounds[0][2] - params.bounds[0][2]) * quantFactor;

            item.bounds[1][0] = (item.bounds[1][0] - params.bounds[0][0]) * quantFactor;
            item.bounds[1][1] = (item.bounds[1][1] - params.bounds[0][1]) * quantFactor;
            item.bounds[1][2] = (item.bounds[1][2] - params.bounds[0][2]) * quantFactor;
        }

        items[i] = item;
    }

    const curNode = { value: 0 };
    const nPolys = Object.keys(params.polys).length;
    const nodes: NavMeshBvNode[] = new Array(nPolys * 2);

    subdivide(items, 0, nPolys, curNode, nodes);

    // trim the nodes array to actual size
    const trimmedNodes = nodes.slice(0, curNode.value);

    const bvTree = {
        nodes: trimmedNodes,
        quantFactor: quantFactor,
    };

    return bvTree;
};
