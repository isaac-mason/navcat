import { clamp, type Vec2, type Vec3, vec2, vec3, triangle2, circle } from 'maaths';
import { distancePtSeg, distToPoly, distToTriMesh, overlapSegSeg2d, polyMinExtent } from '../geometry';
import { BuildContext, type BuildContextState } from './build-context';
import { getDirForOffset, getDirOffsetX, getDirOffsetY, MESH_NULL_IDX, MULTIPLE_REGS, NOT_CONNECTED } from './common';
import type { CompactHeightfield } from './compact-heightfield';
import { getCon } from './compact-heightfield';
import type { PolyMesh } from './poly-mesh';

/**
 * Contains triangle meshes that represent detailed height data associated
 * with the polygons in its associated polygon mesh object.
 */
export type PolyMeshDetail = {
    /** The sub-mesh data. Size: 4*nMeshes. Layout: [verticesBase1, trianglesBase1, verticesCount1, trianglesCount1, ...] */
    meshes: number[];
    /** The mesh vertices. Size: 3*nVertices */
    vertices: number[];
    /** The mesh triangles. Size: 4*nTriangles */
    triangles: number[];
    /** The number of sub-meshes defined by meshes */
    nMeshes: number;
    /** The number of vertices in verts */
    nVertices: number;
    /** The number of triangles in tris */
    nTriangles: number;
};

export const DETAIL_EDGE_BOUNDARY = 0x1;

const UNSET_HEIGHT = 0xffff;
const MAX_VERTS = 127;
const MAX_TRIS = 255;
const MAX_VERTS_PER_EDGE = 32;
const RETRACT_SIZE = 256;

// Edge values enum
const EV_UNDEF = -1;
const EV_HULL = -2;

// Height patch structure
type HeightPatch = {
    data: number[];
    xmin: number;
    ymin: number;
    width: number;
    height: number;
};

// Helper to extract 2D vector from 3D array (x, z components)
const getVec2XZ = (out: Vec2, arr: number[], index = 0): Vec2 => {
    out[0] = arr[index]; // x component
    out[1] = arr[index + 2]; // z component (skip y)
    return out;
};

// Jitter functions for sampling
const getJitterX = (i: number): number => {
    return (((i * 0x8da6b343) & 0xffff) / 65535.0) * 2.0 - 1.0;
};

const getJitterY = (i: number): number => {
    return (((i * 0xd8163841) & 0xffff) / 65535.0) * 2.0 - 1.0;
};

// Helper functions for array navigation
const prev = (i: number, n: number): number => (i - 1 >= 0 ? i - 1 : n - 1);
const next = (i: number, n: number): number => (i + 1 < n ? i + 1 : 0);

// Height sampling function with spiral search
const getHeight = (
    fx: number,
    fy: number,
    fz: number,
    _cs: number,
    ics: number,
    ch: number,
    radius: number,
    hp: HeightPatch,
): number => {
    let ix = Math.floor(fx * ics + 0.01);
    let iz = Math.floor(fz * ics + 0.01);
    ix = clamp(ix - hp.xmin, 0, hp.width - 1);
    iz = clamp(iz - hp.ymin, 0, hp.height - 1);
    let h = hp.data[ix + iz * hp.width];

    if (h === UNSET_HEIGHT) {
        // Special case when data might be bad.
        // Walk adjacent cells in a spiral up to 'radius', and look
        // for a pixel which has a valid height.
        let x = 1;
        let z = 0;
        let dx = 1;
        let dz = 0;
        const maxSize = radius * 2 + 1;
        const maxIter = maxSize * maxSize - 1;

        let nextRingIterStart = 8;
        let nextRingIters = 16;

        let dmin = Number.MAX_VALUE;
        for (let i = 0; i < maxIter; i++) {
            const nx = ix + x;
            const nz = iz + z;

            if (nx >= 0 && nz >= 0 && nx < hp.width && nz < hp.height) {
                const nh = hp.data[nx + nz * hp.width];
                if (nh !== UNSET_HEIGHT) {
                    const d = Math.abs(nh * ch - fy);
                    if (d < dmin) {
                        h = nh;
                        dmin = d;
                    }
                }
            }

            // We are searching in a grid which looks approximately like this:
            //  __________
            // |2 ______ 2|
            // | |1 __ 1| |
            // | | |__| | |
            // | |______| |
            // |__________|
            // We want to find the best height as close to the center cell as possible. This means that
            // if we find a height in one of the neighbor cells to the center, we don't want to
            // expand further out than the 8 neighbors - we want to limit our search to the closest
            // of these "rings", but the best height in the ring.
            // For example, the center is just 1 cell. We checked that at the entrance to the function.
            // The next "ring" contains 8 cells (marked 1 above). Those are all the neighbors to the center cell.
            // The next one again contains 16 cells (marked 2). In general each ring has 8 additional cells, which
            // can be thought of as adding 2 cells around the "center" of each side when we expand the ring.
            // Here we detect if we are about to enter the next ring, and if we are and we have found
            // a height, we abort the search.
            if (i + 1 === nextRingIterStart) {
                if (h !== UNSET_HEIGHT) break;

                nextRingIterStart += nextRingIters;
                nextRingIters += 8;
            }

            if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
                const tmp = dx;
                dx = -dz;
                dz = tmp;
            }
            x += dx;
            z += dz;
        }
    }
    return h;
};

// Edge management functions for triangulation
const findEdge = (edges: number[], nedges: number, s: number, t: number): number => {
    for (let i = 0; i < nedges; i++) {
        const e = i * 4;
        if ((edges[e] === s && edges[e + 1] === t) || (edges[e] === t && edges[e + 1] === s)) {
            return i;
        }
    }
    return EV_UNDEF;
};

const addEdge = (
    ctx: BuildContextState,
    edges: number[],
    nedges: { value: number },
    maxEdges: number,
    s: number,
    t: number,
    l: number,
    r: number,
): number => {
    if (nedges.value >= maxEdges) {
        BuildContext.error(ctx, `addEdge: Too many edges (${nedges.value}/${maxEdges}).`);
        return EV_UNDEF;
    }

    // Add edge if not already in the triangulation.
    const e = findEdge(edges, nedges.value, s, t);
    if (e === EV_UNDEF) {
        const edgeIdx = nedges.value * 4;
        edges[edgeIdx] = s;
        edges[edgeIdx + 1] = t;
        edges[edgeIdx + 2] = l;
        edges[edgeIdx + 3] = r;
        return nedges.value++;
    }
    return EV_UNDEF;
};

const _completeFacetC = vec3.create();
const _completeFacetPointS: Vec2 = vec2.create();
const _completeFacetPointT: Vec2 = vec2.create();
const _completeFacetPointU: Vec2 = vec2.create();
const _completeFacetCircleCenter: Vec2 = vec2.create();
const _completeFacetDistanceCalc: Vec2 = vec2.create();

const _circumcircleTriangle = triangle2.create();
const _circumcircleResult = circle.create();

// Triangle completion function for Delaunay triangulation
const completeFacet = (
    ctx: BuildContextState,
    points: number[],
    nPoints: number,
    edges: number[],
    nEdges: { value: number },
    maxEdges: number,
    nFaces: { value: number },
    e: number,
): void => {
    const EPS_FACET = 1e-5;

    const edgeIdx = e * 4;

    // Cache s and t.
    let s: number;
    let t: number;
    if (edges[edgeIdx + 2] === EV_UNDEF) {
        s = edges[edgeIdx];
        t = edges[edgeIdx + 1];
    } else if (edges[edgeIdx + 3] === EV_UNDEF) {
        s = edges[edgeIdx + 1];
        t = edges[edgeIdx];
    } else {
        // Edge already completed.
        return;
    }

    // Find best point on left of edge.
    let pt = nPoints;
    const c = vec3.set(_completeFacetC, 0, 0, 0);
    let r = -1;

    for (let u = 0; u < nPoints; ++u) {
        if (u === s || u === t) continue;
        // Calculate cross product to check if points are in correct order for triangle
        getVec2XZ(_completeFacetPointS, points, s * 3);
        getVec2XZ(_completeFacetPointT, points, t * 3);
        getVec2XZ(_completeFacetPointU, points, u * 3);
        vec2.subtract(_completeFacetPointT, _completeFacetPointT, _completeFacetPointS); // t - s
        vec2.subtract(_completeFacetPointU, _completeFacetPointU, _completeFacetPointS); // u - s
        const crossProduct =
            _completeFacetPointT[0] * _completeFacetPointU[1] - _completeFacetPointT[1] * _completeFacetPointU[0];

        if (crossProduct > EPS_FACET) {
            if (r < 0) {
                // The circle is not updated yet, do it now.
                pt = u;

                getVec2XZ(_circumcircleTriangle[0], points, s * 3);
                getVec2XZ(_circumcircleTriangle[1], points, t * 3);
                getVec2XZ(_circumcircleTriangle[2], points, u * 3);

                triangle2.circumcircle(_circumcircleResult, _circumcircleTriangle);

                c[0] = _circumcircleResult.center[0];
                c[1] = 0;
                c[2] = _circumcircleResult.center[1];

                r = _circumcircleResult.radius;

                continue;
            }
            getVec2XZ(_completeFacetCircleCenter, c, 0);
            getVec2XZ(_completeFacetDistanceCalc, points, u * 3);
            const d = vec2.distance(_completeFacetCircleCenter, _completeFacetDistanceCalc);
            const tol = 0.001;

            if (d > r * (1 + tol)) {
                // Outside current circumcircle, skip
                continue;
            }

            if (d >= r * (1 - tol)) {
                // Inside epsilon circumcircle, do extra tests to make sure the edge is valid.
                if (overlapEdges(points, edges, nEdges.value, s, u)) continue;
                if (overlapEdges(points, edges, nEdges.value, t, u)) continue;
            }

            // Edge is valid.
            pt = u;

            getVec2XZ(_circumcircleTriangle[0], points, s * 3);
            getVec2XZ(_circumcircleTriangle[1], points, t * 3);
            getVec2XZ(_circumcircleTriangle[2], points, u * 3);

            triangle2.circumcircle(_circumcircleResult, _circumcircleTriangle);

            c[0] = _circumcircleResult.center[0];
            c[1] = 0;
            c[2] = _circumcircleResult.center[1];

            r = _circumcircleResult.radius;
        }
    }

    // Add new triangle or update edge info if s-t is on hull.
    if (pt < nPoints) {
        // Update face information of edge being completed.
        updateLeftFace(edges, e, s, t, nFaces.value);

        // Add new edge or update face info of old edge.
        let newE = findEdge(edges, nEdges.value, pt, s);
        if (newE === EV_UNDEF) {
            addEdge(ctx, edges, nEdges, maxEdges, pt, s, nFaces.value, EV_UNDEF);
        } else {
            updateLeftFace(edges, newE, pt, s, nFaces.value);
        }

        // Add new edge or update face info of old edge.
        newE = findEdge(edges, nEdges.value, t, pt);
        if (newE === EV_UNDEF) {
            addEdge(ctx, edges, nEdges, maxEdges, t, pt, nFaces.value, EV_UNDEF);
        } else {
            updateLeftFace(edges, newE, t, pt, nFaces.value);
        }

        nFaces.value++;
    } else {
        updateLeftFace(edges, e, s, t, EV_HULL);
    }
};

const updateLeftFace = (edges: number[], edgeIdx: number, s: number, t: number, f: number): void => {
    const e = edgeIdx * 4;
    if (edges[e] === s && edges[e + 1] === t && edges[e + 2] === EV_UNDEF) {
        edges[e + 2] = f;
    } else if (edges[e + 1] === s && edges[e] === t && edges[e + 3] === EV_UNDEF) {
        edges[e + 3] = f;
    }
};

const _overlapEdgesS0: Vec2 = vec2.create();
const _overlapEdgesT0: Vec2 = vec2.create();
const _overlapEdgesS1: Vec2 = vec2.create();
const _overlapEdgesT1: Vec2 = vec2.create();

const overlapEdges = (pts: number[], edges: number[], nedges: number, s1: number, t1: number): boolean => {
    for (let i = 0; i < nedges; ++i) {
        const s0 = edges[i * 4];
        const t0 = edges[i * 4 + 1];
        // Same or connected edges do not overlap.
        if (s0 === s1 || s0 === t1 || t0 === s1 || t0 === t1) continue;
        getVec2XZ(_overlapEdgesS0, pts, s0 * 3);
        getVec2XZ(_overlapEdgesT0, pts, t0 * 3);
        getVec2XZ(_overlapEdgesS1, pts, s1 * 3);
        getVec2XZ(_overlapEdgesT1, pts, t1 * 3);
        if (overlapSegSeg2d(_overlapEdgesS0, _overlapEdgesT0, _overlapEdgesS1, _overlapEdgesT1)) return true;
    }
    return false;
};

// Delaunay triangulation hull function
const delaunayHull = (
    ctx: BuildContextState,
    npts: number,
    pts: number[],
    nhull: number,
    hull: number[],
    tris: number[],
    edges: number[],
): void => {
    const nfaces = { value: 0 };
    const nedges = { value: 0 };
    const maxEdges = npts * 10;

    // Resize edges array
    edges.length = maxEdges * 4;

    for (let i = 0, j = nhull - 1; i < nhull; j = i++) {
        addEdge(ctx, edges, nedges, maxEdges, hull[j], hull[i], EV_HULL, EV_UNDEF);
    }

    let currentEdge = 0;
    while (currentEdge < nedges.value) {
        if (edges[currentEdge * 4 + 2] === EV_UNDEF) {
            completeFacet(ctx, pts, npts, edges, nedges, maxEdges, nfaces, currentEdge);
        }
        if (edges[currentEdge * 4 + 3] === EV_UNDEF) {
            completeFacet(ctx, pts, npts, edges, nedges, maxEdges, nfaces, currentEdge);
        }
        currentEdge++;
    }

    // Create tris
    tris.length = nfaces.value * 4;
    for (let i = 0; i < nfaces.value * 4; ++i) {
        tris[i] = -1;
    }

    for (let i = 0; i < nedges.value; ++i) {
        const e = i * 4;
        if (edges[e + 3] >= 0) {
            // Left face
            const t = edges[e + 3] * 4;
            if (tris[t] === -1) {
                tris[t] = edges[e];
                tris[t + 1] = edges[e + 1];
            } else if (tris[t] === edges[e + 1]) {
                tris[t + 2] = edges[e];
            } else if (tris[t + 1] === edges[e]) {
                tris[t + 2] = edges[e + 1];
            }
        }
        if (edges[e + 2] >= 0) {
            // Right
            const t = edges[e + 2] * 4;
            if (tris[t] === -1) {
                tris[t] = edges[e + 1];
                tris[t + 1] = edges[e];
            } else if (tris[t] === edges[e]) {
                tris[t + 2] = edges[e + 1];
            } else if (tris[t + 1] === edges[e + 1]) {
                tris[t + 2] = edges[e];
            }
        }
    }

    // Remove dangling faces
    for (let i = 0; i < tris.length / 4; ++i) {
        const t = i * 4;
        if (tris[t] === -1 || tris[t + 1] === -1 || tris[t + 2] === -1) {
            BuildContext.warn(ctx, `delaunayHull: Removing dangling face ${i} [${tris[t]},${tris[t + 1]},${tris[t + 2]}].`);
            tris[t] = tris[tris.length - 4];
            tris[t + 1] = tris[tris.length - 3];
            tris[t + 2] = tris[tris.length - 2];
            tris[t + 3] = tris[tris.length - 1];
            tris.length -= 4;
            --i;
        }
    }
};

const triangulateHull = (verts: number[], nhull: number, hull: number[], nin: number, tris: number[]): void => {
    let start = 0;
    let left = 1;
    let right = nhull - 1;

    // Start from an ear with shortest perimeter.
    let dmin = Number.MAX_VALUE;
    for (let i = 0; i < nhull; i++) {
        if (hull[i] >= nin) continue; // Ears are triangles with original vertices as middle vertex
        const pi = prev(i, nhull);
        const ni = next(i, nhull);
        const pv = hull[pi] * 3;
        const cv = hull[i] * 3;
        const nv = hull[ni] * 3;
        // Calculate triangle perimeter using 2D distances
        getVec2XZ(_triangulateHullPrev, verts, pv);
        getVec2XZ(_triangulateHullCurrent, verts, cv);
        getVec2XZ(_triangulateHullNext, verts, nv);

        const d =
            vec2.distance(_triangulateHullPrev, _triangulateHullCurrent) +
            vec2.distance(_triangulateHullCurrent, _triangulateHullNext) +
            vec2.distance(_triangulateHullNext, _triangulateHullPrev);
        if (d < dmin) {
            start = i;
            left = ni;
            right = pi;
            dmin = d;
        }
    }

    // Add first triangle
    tris.push(hull[start]);
    tris.push(hull[left]);
    tris.push(hull[right]);
    tris.push(0);

    // Triangulate the polygon by moving left or right
    while (next(left, nhull) !== right) {
        // Check to see if we should advance left or right.
        const nleft = next(left, nhull);
        const nright = prev(right, nhull);

        const cvleft = hull[left] * 3;
        const nvleft = hull[nleft] * 3;
        const cvright = hull[right] * 3;
        const nvright = hull[nright] * 3;
        // Calculate distances for left and right triangulation options
        getVec2XZ(_triangulateHullPrev, verts, cvleft);
        getVec2XZ(_triangulateHullCurrent, verts, nvleft);
        getVec2XZ(_triangulateHullNext, verts, cvright);
        getVec2XZ(_triangulateHullRight, verts, nvright);

        const dleft =
            vec2.distance(_triangulateHullPrev, _triangulateHullCurrent) +
            vec2.distance(_triangulateHullCurrent, _triangulateHullNext);
        const dright =
            vec2.distance(_triangulateHullNext, _triangulateHullRight) +
            vec2.distance(_triangulateHullPrev, _triangulateHullRight);

        if (dleft < dright) {
            tris.push(hull[left]);
            tris.push(hull[nleft]);
            tris.push(hull[right]);
            tris.push(0);
            left = nleft;
        } else {
            tris.push(hull[left]);
            tris.push(hull[nright]);
            tris.push(hull[right]);
            tris.push(0);
            right = nright;
        }
    }
};

// Check if edge is on hull
const onHull = (a: number, b: number, nhull: number, hull: number[]): boolean => {
    // All internal sampled points come after the hull so we can early out for those.
    if (a >= nhull || b >= nhull) return false;

    for (let j = nhull - 1, i = 0; i < nhull; j = i++) {
        if (a === hull[j] && b === hull[i]) return true;
    }
    return false;
};

// Set triangle flags for boundary edges
const setTriFlags = (tris: number[], nhull: number, hull: number[]): void => {
    for (let i = 0; i < tris.length; i += 4) {
        const a = tris[i];
        const b = tris[i + 1];
        const c = tris[i + 2];
        let flags = 0;
        flags |= (onHull(a, b, nhull, hull) ? DETAIL_EDGE_BOUNDARY : 0) << 0;
        flags |= (onHull(b, c, nhull, hull) ? DETAIL_EDGE_BOUNDARY : 0) << 2;
        flags |= (onHull(c, a, nhull, hull) ? DETAIL_EDGE_BOUNDARY : 0) << 4;
        tris[i + 3] = flags;
    }
};

const SEED_ARRAY_WITH_POLY_CENTER_OFFSET = [
    [0, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
];

// Seed array with polygon center for height data collection
const seedArrayWithPolyCenter = (
    ctx: BuildContextState,
    chf: CompactHeightfield,
    poly: number[],
    polyStart: number,
    nPolys: number,
    verts: number[],
    bs: number,
    hp: HeightPatch,
    array: number[],
): void => {
    // Note: Reads to the compact heightfield are offset by border size (bs)
    // since border size offset is already removed from the polymesh vertices.

    const offset = SEED_ARRAY_WITH_POLY_CENTER_OFFSET;

    // Find cell closest to a poly vertex
    let startCellX = 0;
    let startCellY = 0;
    let startSpanIndex = -1;
    let dmin = UNSET_HEIGHT;

    for (let j = 0; j < nPolys && dmin > 0; ++j) {
        for (let k = 0; k < 9 && dmin > 0; ++k) {
            const ax = verts[poly[polyStart + j] * 3] + offset[k][0];
            const ay = verts[poly[polyStart + j] * 3 + 1];
            const az = verts[poly[polyStart + j] * 3 + 2] + offset[k][1];
            if (ax < hp.xmin || ax >= hp.xmin + hp.width || az < hp.ymin || az >= hp.ymin + hp.height) continue;

            const c = chf.cells[ax + bs + (az + bs) * chf.width];
            for (let i = c.index, ni = c.index + c.count; i < ni && dmin > 0; ++i) {
                const s = chf.spans[i];
                const d = Math.abs(ay - s.y);
                if (d < dmin) {
                    startCellX = ax;
                    startCellY = az;
                    startSpanIndex = i;
                    dmin = d;
                }
            }
        }
    }

    // Find center of the polygon
    let pcx = 0;
    let pcy = 0;
    for (let j = 0; j < nPolys; ++j) {
        pcx += verts[poly[polyStart + j] * 3];
        pcy += verts[poly[polyStart + j] * 3 + 2];
    }
    pcx = Math.floor(pcx / nPolys);
    pcy = Math.floor(pcy / nPolys);

    // Use seeds array as a stack for DFS
    array.length = 0;
    array.push(startCellX, startCellY, startSpanIndex);

    const dirs = [0, 1, 2, 3];
    hp.data.fill(0);

    // DFS to move to the center. Note that we need a DFS here and can not just move
    // directly towards the center without recording intermediate nodes, even though the polygons
    // are convex. In very rare we can get stuck due to contour simplification if we do not
    // record nodes.
    let cx = -1;
    let cy = -1;
    let ci = -1;
    while (true) {
        if (array.length < 3) {
            BuildContext.warn(ctx, 'Walk towards polygon center failed to reach center');
            break;
        }

        ci = array.pop()!;
        cy = array.pop()!;
        cx = array.pop()!;

        if (cx === pcx && cy === pcy) break;

        // If we are already at the correct X-position, prefer direction
        // directly towards the center in the Y-axis; otherwise prefer
        // direction in the X-axis
        let directDir: number;
        if (cx === pcx) {
            directDir = getDirForOffset(0, pcy > cy ? 1 : -1);
        } else {
            directDir = getDirForOffset(pcx > cx ? 1 : -1, 0);
        }

        // Push the direct dir last so we start with this on next iteration
        const temp = dirs[directDir];
        dirs[directDir] = dirs[3];
        dirs[3] = temp;

        const cs = chf.spans[ci];
        for (let i = 0; i < 4; i++) {
            const dir = dirs[i];
            if (getCon(cs, dir) === NOT_CONNECTED) continue;

            const newX = cx + getDirOffsetX(dir);
            const newY = cy + getDirOffsetY(dir);

            const hpx = newX - hp.xmin;
            const hpy = newY - hp.ymin;
            if (hpx < 0 || hpx >= hp.width || hpy < 0 || hpy >= hp.height) continue;

            if (hp.data[hpx + hpy * hp.width] !== 0) continue;

            hp.data[hpx + hpy * hp.width] = 1;
            array.push(newX, newY, chf.cells[newX + bs + (newY + bs) * chf.width].index + getCon(cs, dir));
        }

        // Restore dirs array
        dirs[directDir] = dirs[3];
        dirs[3] = temp;
    }

    array.length = 0;
    // getHeightData seeds are given in coordinates with borders
    array.push(cx + bs, cy + bs, ci);

    hp.data.fill(UNSET_HEIGHT);
    const cs = chf.spans[ci];
    hp.data[cx - hp.xmin + (cy - hp.ymin) * hp.width] = cs.y;
};

// Get height data for a polygon
const getHeightData = (
    ctx: BuildContextState,
    chf: CompactHeightfield,
    poly: number[],
    polyStart: number,
    nPolys: number,
    verts: number[],
    bs: number,
    hp: HeightPatch,
    queue: number[],
    region: number,
): void => {
    // Note: Reads to the compact heightfield are offset by border size (bs)
    // since border size offset is already removed from the polymesh vertices.

    queue.length = 0;
    // Set all heights to RC_UNSET_HEIGHT.
    hp.data.fill(UNSET_HEIGHT);

    let empty = true;

    // We cannot sample from this poly if it was created from polys of different regions.
    if (region !== MULTIPLE_REGS) {
        // Copy the height from the same region, and mark region borders as seed points to fill the rest.
        for (let hy = 0; hy < hp.height; hy++) {
            const y = hp.ymin + hy + bs;
            for (let hx = 0; hx < hp.width; hx++) {
                const x = hp.xmin + hx + bs;
                const c = chf.cells[x + y * chf.width];
                for (let i = c.index, ni = c.index + c.count; i < ni; ++i) {
                    const s = chf.spans[i];
                    if (s.region === region) {
                        // Store height
                        hp.data[hx + hy * hp.width] = s.y;
                        empty = false;

                        // If any of the neighbours is not in same region, add the current location as flood fill start
                        let border = false;
                        for (let dir = 0; dir < 4; ++dir) {
                            if (getCon(s, dir) !== NOT_CONNECTED) {
                                const ax = x + getDirOffsetX(dir);
                                const ay = y + getDirOffsetY(dir);
                                const ai = chf.cells[ax + ay * chf.width].index + getCon(s, dir);
                                const as = chf.spans[ai];
                                if (as.region !== region) {
                                    border = true;
                                    break;
                                }
                            }
                        }
                        if (border) queue.push(x, y, i);
                        break;
                    }
                }
            }
        }
    }

    // if the polygon does not contain any points from the current region or if it could potentially be overlapping polygons
    if (empty) {
        seedArrayWithPolyCenter(ctx, chf, poly, polyStart, nPolys, verts, bs, hp, queue);
    }

    let head = 0;

    // BFS to collect height data
    while (head * 3 < queue.length) {
        const cx = queue[head * 3];
        const cy = queue[head * 3 + 1];
        const ci = queue[head * 3 + 2];
        head++;

        if (head >= RETRACT_SIZE) {
            head = 0;
            queue.splice(0, RETRACT_SIZE * 3);
        }

        const cs = chf.spans[ci];
        for (let dir = 0; dir < 4; ++dir) {
            if (getCon(cs, dir) === NOT_CONNECTED) continue;

            const ax = cx + getDirOffsetX(dir);
            const ay = cy + getDirOffsetY(dir);
            const hx = ax - hp.xmin - bs;
            const hy = ay - hp.ymin - bs;

            if (hx < 0 || hx >= hp.width || hy < 0 || hy >= hp.height) continue;

            if (hp.data[hx + hy * hp.width] !== UNSET_HEIGHT) continue;

            const ai = chf.cells[ax + ay * chf.width].index + getCon(cs, dir);
            const as = chf.spans[ai];

            hp.data[hx + hy * hp.width] = as.y;

            queue.push(ax, ay, ai);
        }
    }
};

// Pre-allocated Vec3 objects for buildPolyDetail function
const _buildPolyDetail_vj: Vec3 = vec3.create();
const _buildPolyDetail_vi: Vec3 = vec3.create();
const _buildPolyDetail_pt: Vec3 = vec3.create();
const _buildPolyDetail_va: Vec3 = vec3.create();
const _buildPolyDetail_vb: Vec3 = vec3.create();
const _buildPolyDetailSamplePt: Vec3 = vec3.create();
const _buildPolyDetailGridPt: Vec3 = vec3.create();

const _bmin = vec3.create();
const _bmax = vec3.create();

const buildPolyDetail = (
    ctx: BuildContextState,
    inVerts: number[],
    nin: number,
    sampleDist: number,
    sampleMaxError: number,
    heightSearchRadius: number,
    chf: CompactHeightfield,
    hp: HeightPatch,
    verts: number[],
    tris: number[],
    edges: number[],
    samples: number[],
): boolean => {
    const edge = new Array((MAX_VERTS_PER_EDGE + 1) * 3);
    const hull = new Array(MAX_VERTS);
    let nhull = 0;

    let nverts = nin;

    // Copy input vertices
    for (let i = 0; i < nin; ++i) {
        verts[i * 3] = inVerts[i * 3];
        verts[i * 3 + 1] = inVerts[i * 3 + 1];
        verts[i * 3 + 2] = inVerts[i * 3 + 2];
    }

    // Clear arrays
    edges.length = 0;
    tris.length = 0;

    const cs = chf.cellSize;
    const ics = 1.0 / cs;

    // Calculate minimum extents of the polygon based on input data.
    const minExtent = polyMinExtent(verts, nverts);

    // Tessellate outlines.
    // This is done in separate pass in order to ensure
    // seamless height values across the ply boundaries.
    if (sampleDist > 0) {
        for (let i = 0, j = nin - 1; i < nin; j = i++) {
            let vjStart = j * 3;
            let viStart = i * 3;
            let swapped = false;

            // Make sure the segments are always handled in same order
            // using lexological sort or else there will be seams.
            if (Math.abs(inVerts[vjStart] - inVerts[viStart]) < 1e-6) {
                if (inVerts[vjStart + 2] > inVerts[viStart + 2]) {
                    const tmp = viStart;
                    viStart = vjStart;
                    vjStart = tmp;

                    swapped = true;
                }
            } else {
                if (inVerts[vjStart] > inVerts[viStart]) {
                    const tmp = viStart;
                    viStart = vjStart;
                    vjStart = tmp;

                    swapped = true;
                }
            }

            const vj = vec3.fromBuffer(_buildPolyDetail_vj, inVerts, vjStart);
            const vi = vec3.fromBuffer(_buildPolyDetail_vi, inVerts, viStart);

            // Create samples along the edge.
            const dx = vi[0] - vj[0];
            const dy = vi[1] - vj[1];
            const dz = vi[2] - vj[2];
            const d = Math.sqrt(dx * dx + dz * dz);
            let nn = 1 + Math.floor(d / sampleDist);
            if (nn >= MAX_VERTS_PER_EDGE) nn = MAX_VERTS_PER_EDGE - 1;
            if (nverts + nn >= MAX_VERTS) nn = MAX_VERTS - 1 - nverts;

            for (let k = 0; k <= nn; ++k) {
                const u = k / nn;
                const pos = k * 3;
                edge[pos] = vj[0] + dx * u;
                edge[pos + 1] = vj[1] + dy * u;
                edge[pos + 2] = vj[2] + dz * u;
                edge[pos + 1] =
                    getHeight(edge[pos], edge[pos + 1], edge[pos + 2], cs, ics, chf.cellHeight, heightSearchRadius, hp) *
                    chf.cellHeight;
            }

            // Simplify samples.
            const idx = new Array(MAX_VERTS_PER_EDGE).fill(0);
            idx[0] = 0;
            idx[1] = nn;
            let nidx = 2;

            for (let k = 0; k < nidx - 1; ) {
                const a = idx[k];
                const b = idx[k + 1];
                const vaStart = a * 3;
                const vbStart = b * 3;

                // Find maximum deviation along the segment.
                let maxd = 0;
                let maxi = -1;
                for (let m = a + 1; m < b; ++m) {
                    const pt = vec3.fromBuffer(_buildPolyDetail_pt, edge, m * 3);
                    const va = vec3.fromBuffer(_buildPolyDetail_va, edge, vaStart);
                    const vb = vec3.fromBuffer(_buildPolyDetail_vb, edge, vbStart);

                    const dev = distancePtSeg(pt, va, vb);

                    if (dev > maxd) {
                        maxd = dev;
                        maxi = m;
                    }
                }

                // If the max deviation is larger than accepted error,
                // add new point, else continue to next segment.
                if (maxi !== -1 && maxd > sampleMaxError * sampleMaxError) {
                    for (let m = nidx; m > k; --m) {
                        idx[m] = idx[m - 1];
                    }
                    idx[k + 1] = maxi;
                    nidx++;
                } else {
                    ++k;
                }
            }

            hull[nhull++] = j;
            // Add new vertices.
            if (swapped) {
                for (let k = nidx - 2; k > 0; --k) {
                    verts[nverts * 3] = edge[idx[k] * 3];
                    verts[nverts * 3 + 1] = edge[idx[k] * 3 + 1];
                    verts[nverts * 3 + 2] = edge[idx[k] * 3 + 2];

                    hull[nhull++] = nverts;
                    nverts++;
                }
            } else {
                for (let k = 1; k < nidx - 1; ++k) {
                    verts[nverts * 3] = edge[idx[k] * 3];
                    verts[nverts * 3 + 1] = edge[idx[k] * 3 + 1];
                    verts[nverts * 3 + 2] = edge[idx[k] * 3 + 2];

                    hull[nhull++] = nverts;
                    nverts++;
                }
            }
        }
    }

    // If the polygon minimum extent is small, do not try to add internal points.
    if (minExtent < sampleDist * 2) {
        triangulateHull(verts, nhull, hull, nin, tris);
        setTriFlags(tris, nhull, hull);
        return true;
    }

    // Tessellate the base mesh using triangulateHull
    triangulateHull(verts, nhull, hull, nin, tris);

    if (tris.length === 0) {
        BuildContext.warn(ctx, `buildPolyDetail: Could not triangulate polygon (${nverts} verts).`);
        return true;
    }

    if (sampleDist > 0) {
        // Create sample locations in a grid.
        const bmin = vec3.set(_bmin, inVerts[0], inVerts[1], inVerts[2]);
        const bmax = vec3.set(_bmax, inVerts[0], inVerts[1], inVerts[2]);
        for (let i = 1; i < nin; ++i) {
            bmin[0] = Math.min(bmin[0], inVerts[i * 3]);
            bmin[1] = Math.min(bmin[1], inVerts[i * 3 + 1]);
            bmin[2] = Math.min(bmin[2], inVerts[i * 3 + 2]);
            bmax[0] = Math.max(bmax[0], inVerts[i * 3]);
            bmax[1] = Math.max(bmax[1], inVerts[i * 3 + 1]);
            bmax[2] = Math.max(bmax[2], inVerts[i * 3 + 2]);
        }
        const x0 = Math.floor(bmin[0] / sampleDist);
        const x1 = Math.ceil(bmax[0] / sampleDist);
        const z0 = Math.floor(bmin[2] / sampleDist);
        const z1 = Math.ceil(bmax[2] / sampleDist);
        samples.length = 0;
        for (let z = z0; z < z1; ++z) {
            for (let x = x0; x < x1; ++x) {
                const pt = [x * sampleDist, (bmax[1] + bmin[1]) * 0.5, z * sampleDist];
                // Make sure the samples are not too close to the edges.
                vec3.set(_buildPolyDetailGridPt, pt[0], pt[1], pt[2]);
                if (distToPoly(nin, inVerts, _buildPolyDetailGridPt) > -sampleDist / 2) continue;
                samples.push(x);
                samples.push(getHeight(pt[0], pt[1], pt[2], cs, ics, chf.cellHeight, heightSearchRadius, hp));
                samples.push(z);
                samples.push(0); // Not added
            }
        }

        // Add the samples starting from the one that has the most error.
        const nsamples = samples.length / 4;
        for (let iter = 0; iter < nsamples; ++iter) {
            if (nverts >= MAX_VERTS) break;

            // Find sample with most error.
            const bestpt = [0, 0, 0];
            let bestd = 0;
            let besti = -1;
            for (let i = 0; i < nsamples; ++i) {
                const s = i * 4;
                if (samples[s + 3]) continue; // skip added.
                const pt = [
                    samples[s] * sampleDist + getJitterX(i) * cs * 0.1,
                    samples[s + 1] * chf.cellHeight,
                    samples[s + 2] * sampleDist + getJitterY(i) * cs * 0.1,
                ];
                vec3.set(_buildPolyDetailSamplePt, pt[0], pt[1], pt[2]);
                const d = distToTriMesh(_buildPolyDetailSamplePt, verts, tris, tris.length / 4);
                if (d < 0) continue; // did not hit the mesh.
                if (d > bestd) {
                    bestd = d;
                    besti = i;
                    bestpt[0] = pt[0];
                    bestpt[1] = pt[1];
                    bestpt[2] = pt[2];
                }
            }
            // If the max error is within accepted threshold, stop tesselating.
            if (bestd <= sampleMaxError || besti === -1) break;
            // Mark sample as added.
            samples[besti * 4 + 3] = 1;
            // Add the new sample point.
            verts.push(bestpt[0], bestpt[1], bestpt[2]);
            nverts++;

            // Create new triangulation.
            // TODO: Incremental add instead of full rebuild.
            edges.length = 0;
            tris.length = 0;
            delaunayHull(ctx, nverts, verts, nhull, hull, tris, edges);
        }
    }

    const ntris = tris.length / 4;
    if (ntris > MAX_TRIS) {
        tris.length = MAX_TRIS * 4;
        BuildContext.warn(ctx, `buildPolyMeshDetail: Shrinking triangle count from ${ntris} to max ${MAX_TRIS}.`);
    }

    setTriFlags(tris, nhull, hull);

    return true;
};

const _triangulateHullPrev: Vec2 = vec2.create();
const _triangulateHullCurrent: Vec2 = vec2.create();
const _triangulateHullNext: Vec2 = vec2.create();
const _triangulateHullRight: Vec2 = vec2.create();

export const buildPolyMeshDetail = (
    ctx: BuildContextState,
    polyMesh: PolyMesh,
    compactHeightfield: CompactHeightfield,
    sampleDist: number,
    sampleMaxError: number,
): PolyMeshDetail => {
    if (polyMesh.nVertices === 0 || polyMesh.nPolys === 0) {
        return {
            meshes: [],
            vertices: [],
            triangles: [],
            nMeshes: 0,
            nVertices: 0,
            nTriangles: 0,
        };
    }

    const nvp = polyMesh.maxVerticesPerPoly;
    const cs = polyMesh.cellSize;
    const ch = polyMesh.cellHeight;
    const orig = [polyMesh.bounds[0][0], polyMesh.bounds[0][1], polyMesh.bounds[0][2]];
    const borderSize = polyMesh.borderSize;
    const heightSearchRadius = Math.max(1, Math.ceil(polyMesh.maxEdgeError));

    const hp: HeightPatch = {
        data: [],
        xmin: 0,
        ymin: 0,
        width: 0,
        height: 0,
    };

    let maxhw = 0;
    let maxhh = 0;

    // Calculate bounds for each polygon
    const bounds = new Array(polyMesh.nPolys * 4);
    const poly = new Array(nvp * 3);

    // Find max size for a polygon area.
    for (let i = 0; i < polyMesh.nPolys; ++i) {
        const p = i * nvp;
        let xmin = compactHeightfield.width;
        let xmax = 0;
        let ymin = compactHeightfield.height;
        let ymax = 0;
        for (let j = 0; j < nvp; ++j) {
            if (polyMesh.polys[p + j] === MESH_NULL_IDX) break;
            const v = polyMesh.polys[p + j] * 3;
            xmin = Math.min(xmin, polyMesh.vertices[v]);
            xmax = Math.max(xmax, polyMesh.vertices[v]);
            ymin = Math.min(ymin, polyMesh.vertices[v + 2]);
            ymax = Math.max(ymax, polyMesh.vertices[v + 2]);
        }
        bounds[i * 4] = Math.max(0, xmin - 1);
        bounds[i * 4 + 1] = Math.min(compactHeightfield.width, xmax + 1);
        bounds[i * 4 + 2] = Math.max(0, ymin - 1);
        bounds[i * 4 + 3] = Math.min(compactHeightfield.height, ymax + 1);
        if (bounds[i * 4] >= bounds[i * 4 + 1] || bounds[i * 4 + 2] >= bounds[i * 4 + 3]) continue;
        maxhw = Math.max(maxhw, bounds[i * 4 + 1] - bounds[i * 4]);
        maxhh = Math.max(maxhh, bounds[i * 4 + 3] - bounds[i * 4 + 2]);
    }

    hp.data = new Array(maxhw * maxhh);

    const dmesh: PolyMeshDetail = {
        meshes: new Array(polyMesh.nPolys * 4),
        vertices: [],
        triangles: [],
        nMeshes: polyMesh.nPolys,
        nVertices: 0,
        nTriangles: 0,
    };

    for (let i = 0; i < polyMesh.nPolys; ++i) {
        const p = i * nvp;

        const edges: number[] = [];
        const tris: number[] = [];
        const arr: number[] = [];
        const samples: number[] = [];
        const verts: number[] = [];

        // Store polygon vertices for processing.
        let npoly = 0;
        for (let j = 0; j < nvp; ++j) {
            if (polyMesh.polys[p + j] === MESH_NULL_IDX) break;
            const v = polyMesh.polys[p + j] * 3;
            poly[j * 3] = polyMesh.vertices[v] * cs;
            poly[j * 3 + 1] = polyMesh.vertices[v + 1] * ch;
            poly[j * 3 + 2] = polyMesh.vertices[v + 2] * cs;
            npoly++;
        }

        // Get the height data from the area of the polygon.
        hp.xmin = bounds[i * 4];
        hp.ymin = bounds[i * 4 + 2];
        hp.width = bounds[i * 4 + 1] - bounds[i * 4];
        hp.height = bounds[i * 4 + 3] - bounds[i * 4 + 2];
        getHeightData(
            ctx,
            compactHeightfield,
            polyMesh.polys,
            p,
            npoly,
            polyMesh.vertices,
            borderSize,
            hp,
            arr,
            polyMesh.regions[i],
        );

        // Build detail mesh.
        if (
            !buildPolyDetail(
                ctx,
                poly,
                npoly,
                sampleDist,
                sampleMaxError,
                heightSearchRadius,
                compactHeightfield,
                hp,
                verts,
                tris,
                edges,
                samples,
            )
        ) {
            BuildContext.error(ctx, `buildPolyMeshDetail: Failed to build detail mesh for poly ${i}.`);
            continue;
        }

        // Move detail verts to world space.
        for (let i = 0; i < verts.length; i += 3) {
            verts[i] += orig[0];
            verts[i + 1] += orig[1] + compactHeightfield.cellHeight; // Is this offset necessary?
            verts[i + 2] += orig[2];
        }

        // Offset poly too, will be used to flag checking.
        for (let j = 0; j < npoly; ++j) {
            poly[j * 3] += orig[0];
            poly[j * 3 + 1] += orig[1];
            poly[j * 3 + 2] += orig[2];
        }

        // Store detail submesh.
        const ntris = tris.length / 4;

        dmesh.meshes[i * 4] = dmesh.nVertices;
        dmesh.meshes[i * 4 + 1] = verts.length / 3;
        dmesh.meshes[i * 4 + 2] = dmesh.nTriangles;
        dmesh.meshes[i * 4 + 3] = ntris;

        // Store vertices
        for (let i = 0; i < verts.length; i += 3) {
            dmesh.vertices.push(verts[i], verts[i + 1], verts[i + 2]);
            dmesh.nVertices++;
        }

        // Store triangles
        for (let i = 0; i < tris.length; i += 4) {
            dmesh.triangles.push(tris[i], tris[i + 1], tris[i + 2], tris[i + 3]);
            dmesh.nTriangles++;
        }
    }

    return dmesh;
};
