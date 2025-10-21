import type { Vec2, Vec3 } from 'maaths';
import { vec2, vec3 } from 'maaths';

const EPS = 1e-6;

/**
 * Calculates the closest point on a line segment to a given point in 2D (XZ plane)
 * @param out Output parameter for the closest point
 * @param pt The point
 * @param p First endpoint of the segment
 * @param q Second endpoint of the segment
 */
export const closestPtSeg2d = (out: Vec3, pt: Vec3, p: Vec3, q: Vec3): void => {
    const pqx = q[0] - p[0];
    const pqz = q[2] - p[2];
    const dx = pt[0] - p[0];
    const dz = pt[2] - p[2];

    const d = pqx * pqx + pqz * pqz;
    let t = pqx * dx + pqz * dz;
    if (d > 0) t /= d;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    out[0] = p[0] + t * pqx;
    out[1] = p[1]; // keep original Y value from p
    out[2] = p[2] + t * pqz;
};

/**
 * Tests if a point is inside a polygon in 2D (XZ plane)
 */
export const pointInPoly = (point: Vec3, vertices: number[], nVertices: number): boolean => {
    let inside = false;
    const x = point[0];
    const z = point[2];
    for (let l = nVertices, i = 0, j = l - 1; i < l; j = i++) {
        const xj = vertices[j * 3],
            zj = vertices[j * 3 + 2],
            xi = vertices[i * 3],
            zi = vertices[i * 3 + 2];
        const where = (zi - zj) * (x - xi) - (xi - xj) * (z - zi);
        if (zj < zi) {
            if (z >= zj && z < zi) {
                if (where === 0) {
                    // point on the line
                    return true;
                }
                if (where > 0) {
                    if (z === zj) {
                        // ray intersects vertex
                        if (z > vertices[(j === 0 ? l - 1 : j - 1) * 3 + 2]) {
                            inside = !inside;
                        }
                    } else {
                        inside = !inside;
                    }
                }
            }
        } else if (zi < zj) {
            if (z > zi && z <= zj) {
                if (where === 0) {
                    // point on the line
                    return true;
                }
                if (where < 0) {
                    if (z === zj) {
                        // ray intersects vertex
                        if (z < vertices[(j === 0 ? l - 1 : j - 1) * 3 + 2]) {
                            inside = !inside;
                        }
                    } else {
                        inside = !inside;
                    }
                }
            }
        } else if (z === zi && ((x >= xj && x <= xi) || (x >= xi && x <= xj))) {
            // point on horizontal edge
            return true;
        }
    }
    return inside;
};

const _distPtTriV0: Vec3 = vec3.create();
const _distPtTriV1: Vec3 = vec3.create();
const _distPtTriV2: Vec3 = vec3.create();

const _distPtTriVec0: Vec2 = vec2.create();
const _distPtTriVec1: Vec2 = vec2.create();
const _distPtTriVec2: Vec2 = vec2.create();

export const distPtTri = (p: Vec3, a: Vec3, b: Vec3, c: Vec3): number => {
    const v0 = _distPtTriV0;
    const v1 = _distPtTriV1;
    const v2 = _distPtTriV2;

    vec3.subtract(v0, c, a);
    vec3.subtract(v1, b, a);
    vec3.subtract(v2, p, a);

    _distPtTriVec0[0] = v0[0];
    _distPtTriVec0[1] = v0[2];

    _distPtTriVec1[0] = v1[0];
    _distPtTriVec1[1] = v1[2];

    _distPtTriVec2[0] = v2[0];
    _distPtTriVec2[1] = v2[2];

    const dot00 = vec2.dot(_distPtTriVec0, _distPtTriVec0);
    const dot01 = vec2.dot(_distPtTriVec0, _distPtTriVec1);
    const dot02 = vec2.dot(_distPtTriVec0, _distPtTriVec2);
    const dot11 = vec2.dot(_distPtTriVec1, _distPtTriVec1);
    const dot12 = vec2.dot(_distPtTriVec1, _distPtTriVec2);

    // Compute barycentric coordinates
    const invDenom = 1.0 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    // If point lies inside the triangle, return interpolated y-coord.
    const EPS_TRI = 1e-4;
    if (u >= -EPS_TRI && v >= -EPS_TRI && u + v <= 1 + EPS_TRI) {
        const y = a[1] + v0[1] * u + v1[1] * v;
        return Math.abs(y - p[1]);
    }
    return Number.MAX_VALUE;
};

const _distPtSegP: Vec3 = vec3.create();
const _distPtSegQ: Vec3 = vec3.create();

export const distancePtSeg = (pt: Vec3, p: Vec3, q: Vec3): number => {
    const pq = _distPtSegP;
    const d_vec = _distPtSegQ;

    vec3.subtract(pq, q, p); // pq = q - p
    vec3.subtract(d_vec, pt, p); // d_vec = pt - p

    const d = vec3.dot(pq, pq);
    let t = vec3.dot(pq, d_vec);
    if (d > 0) t /= d;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    // calculate closest point on segment: p + t * pq
    vec3.scale(pq, pq, t);
    vec3.add(pq, p, pq);

    // calculate distance vector: closest_point - pt
    vec3.subtract(pq, pq, pt);

    return vec3.dot(pq, pq); // return squared distance
};

export type DistPtSeg2dResult = { dist: number; t: number };

export const createDistPtSeg2dResult = (): DistPtSeg2dResult => ({
    dist: 0,
    t: 0,
});

export const distancePtSeg2d = (out: DistPtSeg2dResult, pt: Vec3, p: Vec3, q: Vec3) => {
    const pqx = q[0] - p[0];
    const pqz = q[2] - p[2];
    const dx = pt[0] - p[0];
    const dz = pt[2] - p[2];

    const d = pqx * pqx + pqz * pqz;
    let t = pqx * dx + pqz * dz;
    if (d > 0) t /= d;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const closeDx = p[0] + t * pqx - pt[0];
    const closeDz = p[2] + t * pqz - pt[2];

    const dist = closeDx * closeDx + closeDz * closeDz;

    out.dist = dist;
    out.t = t;
    return out;
};

export type DistancePtSegSqr2dResult = { distSqr: number; t: number };

export const createDistancePtSegSqr2dResult = (): DistancePtSegSqr2dResult => ({
    distSqr: 0,
    t: 0,
});

export const distancePtSegSqr2d = (out: DistancePtSegSqr2dResult, pt: Vec3, p: Vec3, q: Vec3) => {
    const pqx = q[0] - p[0];
    const pqz = q[2] - p[2];
    const dx = pt[0] - p[0];
    const dz = pt[2] - p[2];

    const d = pqx * pqx + pqz * pqz;
    let t = pqx * dx + pqz * dz;
    if (d > 0) t /= d;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const closestX = p[0] + t * pqx;
    const closestZ = p[2] + t * pqz;

    const distX = closestX - pt[0];
    const distZ = closestZ - pt[2];

    const distSqr = distX * distX + distZ * distZ;

    out.distSqr = distSqr;
    out.t = t;

    return out;
};

const _distPtTriA: Vec3 = vec3.create();
const _distPtTriB: Vec3 = vec3.create();
const _distPtTriC: Vec3 = vec3.create();

export const distToTriMesh = (p: Vec3, verts: number[], tris: number[], ntris: number): number => {
    let dmin = Number.MAX_VALUE;
    for (let i = 0; i < ntris; ++i) {
        const va = tris[i * 4 + 0] * 3;
        const vb = tris[i * 4 + 1] * 3;
        const vc = tris[i * 4 + 2] * 3;

        vec3.fromBuffer(_distPtTriA, verts, va);
        vec3.fromBuffer(_distPtTriB, verts, vb);
        vec3.fromBuffer(_distPtTriC, verts, vc);

        const d = distPtTri(p, _distPtTriA, _distPtTriB, _distPtTriC);
        if (d < dmin) dmin = d;
    }
    if (dmin === Number.MAX_VALUE) return -1;
    return dmin;
};

const _distToPolyVj: Vec3 = vec3.create();
const _distToPolyVi: Vec3 = vec3.create();
const _distToPoly_distPtSeg2dResult = createDistPtSeg2dResult();

export const distToPoly = (nvert: number, verts: number[], p: Vec3): number => {
    let dmin = Number.MAX_VALUE;
    let c = 0;

    for (let i = 0, j = nvert - 1; i < nvert; j = i++) {
        const vi = i * 3;
        const vj = j * 3;
        if (
            verts[vi + 2] > p[2] !== verts[vj + 2] > p[2] &&
            p[0] < ((verts[vj] - verts[vi]) * (p[2] - verts[vi + 2])) / (verts[vj + 2] - verts[vi + 2]) + verts[vi]
        ) {
            c = c === 0 ? 1 : 0;
        }

        vec3.fromBuffer(_distToPolyVj, verts, vj);
        vec3.fromBuffer(_distToPolyVi, verts, vi);

        distancePtSeg2d(_distToPoly_distPtSeg2dResult, p, _distToPolyVj, _distToPolyVi);
        dmin = Math.min(dmin, _distToPoly_distPtSeg2dResult.dist);
    }
    return c ? -dmin : dmin;
};

/**
 * Calculates the closest height point on a triangle using barycentric coordinates.
 * @param p The point to project
 * @param a First triangle vertex
 * @param b Second triangle vertex
 * @param c Third triangle vertex
 * @returns Height at position, or NaN if point is not inside triangle
 */
export const closestHeightPointTriangle = (p: Vec3, a: Vec3, b: Vec3, c: Vec3): number => {
    const EPS = 1e-6;

    const v0x = c[0] - a[0];
    const v0y = c[1] - a[1];
    const v0z = c[2] - a[2];

    const v1x = b[0] - a[0];
    const v1y = b[1] - a[1];
    const v1z = b[2] - a[2];

    const v2x = p[0] - a[0];
    const v2z = p[2] - a[2];

    // Compute scaled barycentric coordinates
    let denom = v0x * v1z - v0z * v1x;
    if (Math.abs(denom) < EPS) {
        return NaN;
    }

    let u = v1z * v2x - v1x * v2z;
    let v = v0x * v2z - v0z * v2x;

    if (denom < 0) {
        denom = -denom;
        u = -u;
        v = -v;
    }

    // If point lies inside the triangle, return interpolated ycoord.
    if (u >= 0.0 && v >= 0.0 && u + v <= denom) {
        return a[1] + (v0y * u + v1y * v) / denom;
    }

    return NaN;
};

const _overlapSegAB: Vec2 = vec2.create();
const _overlapSegAD: Vec2 = vec2.create();
const _overlapSegAC: Vec2 = vec2.create();
const _overlapSegCD: Vec2 = vec2.create();
const _overlapSegCA: Vec2 = vec2.create();

export const overlapSegSeg2d = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
    // calculate cross products for line segment intersection test
    const ab = _overlapSegAB;
    const ad = _overlapSegAD;
    const ac = _overlapSegAC;

    vec2.subtract(ab, b, a); // b - a
    vec2.subtract(ad, d, a); // d - a
    const a1 = ab[0] * ad[1] - ab[1] * ad[0];

    vec2.subtract(ac, c, a); // c - a
    const a2 = ab[0] * ac[1] - ab[1] * ac[0];

    if (a1 * a2 < 0.0) {
        const cd = _overlapSegCD;
        const ca = _overlapSegCA;

        vec2.subtract(cd, d, c); // d - c
        vec2.subtract(ca, a, c); // a - c
        const a3 = cd[0] * ca[1] - cd[1] * ca[0];
        const a4 = a3 + a2 - a1;
        if (a3 * a4 < 0.0) return true;
    }
    return false;
};

/**
 * 2D signed area in XZ plane (positive if c is to the left of ab)
 */
export const triArea2D = (a: Vec3, b: Vec3, c: Vec3): number => {
    const abx = b[0] - a[0];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acz = c[2] - a[2];
    return acx * abz - abx * acz;
};

export type IntersectSegSeg2DResult = { hit: boolean; s: number; t: number };

export const createIntersectSegSeg2DResult = (): IntersectSegSeg2DResult => ({
    hit: false,
    s: 0,
    t: 0,
});

/**
 * Segment-segment intersection in XZ plane.
 * Returns { hit, s, t } where
 *  P = a + s*(b-a) and Q = c + t*(d-c). Hit only if both s and t are within [0,1].
 */
export const intersectSegSeg2D = (out: IntersectSegSeg2DResult, a: Vec3, b: Vec3, c: Vec3, d: Vec3): IntersectSegSeg2DResult => {
    const bax = b[0] - a[0];
    const baz = b[2] - a[2];
    const dcx = d[0] - c[0];
    const dcz = d[2] - c[2];
    const acx = a[0] - c[0];
    const acz = a[2] - c[2];
    const denom = dcz * bax - dcx * baz;
    if (Math.abs(denom) < 1e-12) {
        out.hit = false;
        out.s = 0;
        out.t = 0;
        return out;
    }
    const s = (dcx * acz - dcz * acx) / denom;
    const t = (bax * acz - baz * acx) / denom;
    const hit = !(s < 0 || s > 1 || t < 0 || t > 1);
    out.hit = hit;
    out.s = s;
    out.t = t;
    return out;
};

const _polyMinExtentPt: Vec3 = vec3.create();
const _polyMinExtentP1: Vec3 = vec3.create();
const _polyMinExtentP2: Vec3 = vec3.create();
const _polyMinExtent_distPtSeg2dResult = createDistPtSeg2dResult();

// calculate minimum extend of the polygon.
export const polyMinExtent = (verts: number[], nverts: number): number => {
    let minDist = Number.MAX_VALUE;

    for (let i = 0; i < nverts; i++) {
        const ni = (i + 1) % nverts;
        const p1 = i * 3;
        const p2 = ni * 3;
        let maxEdgeDist = 0;
        for (let j = 0; j < nverts; j++) {
            if (j === i || j === ni) continue;

            const ptIdx = j * 3;
            vec3.fromBuffer(_polyMinExtentPt, verts, ptIdx);
            vec3.fromBuffer(_polyMinExtentP1, verts, p1);
            vec3.fromBuffer(_polyMinExtentP2, verts, p2);

            distancePtSeg2d(_polyMinExtent_distPtSeg2dResult, _polyMinExtentPt, _polyMinExtentP1, _polyMinExtentP2);
            maxEdgeDist = Math.max(maxEdgeDist, _polyMinExtent_distPtSeg2dResult.dist);
        }
        minDist = Math.min(minDist, maxEdgeDist);
    }

    return Math.sqrt(minDist);
};

/**
 * Derives the xz-plane 2D perp product of the two vectors. (uz*vx - ux*vz)
 * The vectors are projected onto the xz-plane, so the y-values are ignored.
 * @param u The LHV vector [(x, y, z)]
 * @param v The RHV vector [(x, y, z)]
 * @returns The perp dot product on the xz-plane.
 */
const vperp2D = (u: Vec3, v: Vec3): number => {
    return u[2] * v[0] - u[0] * v[2];
};

export type IntersectSegmentPoly2DResult = {
    intersects: boolean;
    tmin: number;
    tmax: number;
    segMin: number;
    segMax: number;
};

export const createIntersectSegmentPoly2DResult = (): IntersectSegmentPoly2DResult => ({
    intersects: false,
    tmin: 0,
    tmax: 0,
    segMin: -1,
    segMax: -1,
});

const _intersectSegmentPoly2DVi = vec3.create();
const _intersectSegmentPoly2DVj = vec3.create();
const _intersectSegmentPoly2DDir = vec3.create();
const _intersectSegmentPoly2DToStart = vec3.create();
const _intersectSegmentPoly2DEdge = vec3.create();

/**
 * Intersects a segment with a polygon in 2D (ignoring Y).
 * Uses the Sutherland-Hodgman clipping algorithm approach.
 *
 * @param result - The result object to store intersection data
 * @param startPos - Start position of the segment
 * @param endPos - End position of the segment
 * @param verts - Polygon vertices as flat array [x,y,z,x,y,z,...]
 * @param nv - Number of vertices in the polygon
 */
export const intersectSegmentPoly2D = (
    result: IntersectSegmentPoly2DResult,
    startPos: Vec3,
    endPos: Vec3,
    nv: number,
    verts: number[],
): IntersectSegmentPoly2DResult => {
    result.intersects = false;
    result.tmin = 0;
    result.tmax = 1;
    result.segMin = -1;
    result.segMax = -1;

    const dir = vec3.subtract(_intersectSegmentPoly2DDir, endPos, startPos);

    const vi = _intersectSegmentPoly2DVi;
    const vj = _intersectSegmentPoly2DVj;
    const edge = _intersectSegmentPoly2DEdge;
    const diff = _intersectSegmentPoly2DToStart;

    for (let i = 0, j = nv - 1; i < nv; j = i, i++) {
        vec3.fromBuffer(vi, verts, i * 3);
        vec3.fromBuffer(vj, verts, j * 3);

        vec3.subtract(edge, vi, vj);
        vec3.subtract(diff, startPos, vj);

        const n = vperp2D(edge, diff);
        const d = vperp2D(dir, edge);

        if (Math.abs(d) < EPS) {
            // S is nearly parallel to this edge
            if (n < 0) {
                return result;
            }

            continue;
        }

        const t = n / d;

        if (d < 0) {
            // segment S is entering across this edge
            if (t > result.tmin) {
                result.tmin = t;
                result.segMin = j;
                // S enters after leaving polygon
                if (result.tmin > result.tmax) {
                    return result;
                }
            }
        } else {
            // segment S is leaving across this edge
            if (t < result.tmax) {
                result.tmax = t;
                result.segMax = j;
                // S leaves before entering polygon
                if (result.tmax < result.tmin) {
                    return result;
                }
            }
        }
    }

    result.intersects = true;

    return result;
};

const _randomPointInConvexPolyVa = vec3.create();
const _randomPointInConvexPolyVb = vec3.create();
const _randomPointInConvexPolyVc = vec3.create();

/**
 * Generates a random point inside a convex polygon using barycentric coordinates.
 *
 * @param verts - Polygon vertices as flat array [x,y,z,x,y,z,...]
 * @param areas - Temporary array for triangle areas (will be modified)
 * @param s - Random value [0,1] for triangle selection
 * @param t - Random value [0,1] for point within triangle
 * @param out - Output point [x,y,z]
 */
export const randomPointInConvexPoly = (out: Vec3, nv: number, verts: number[], areas: number[], s: number, t: number): Vec3 => {
    // calculate cumulative triangle areas for weighted selection
    let areaSum = 0;
    for (let i = 2; i < nv; i++) {
        const va = [verts[0], verts[1], verts[2]] as Vec3;
        const vb = [verts[(i - 1) * 3], verts[(i - 1) * 3 + 1], verts[(i - 1) * 3 + 2]] as Vec3;
        const vc = [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]] as Vec3;
        areas[i] = triArea2D(va, vb, vc);
        areaSum += Math.max(0.001, areas[i]);
    }

    // choose triangle based on area-weighted random selection
    const thr = s * areaSum;
    let acc = 0;
    let tri = nv - 1;
    for (let i = 2; i < nv; i++) {
        acc += Math.max(0.001, areas[i]);
        if (thr <= acc) {
            tri = i;
            break;
        }
    }

    // generate random point in triangle using barycentric coordinates
    // standard method: use square root for uniform distribution
    let u = Math.sqrt(t);
    let v = 1 - t;

    // ensure the point is inside the triangle
    if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
    }

    const w = 1 - u - v;

    const va = vec3.fromBuffer(_randomPointInConvexPolyVa, verts, 0);
    const vb = vec3.fromBuffer(_randomPointInConvexPolyVb, verts, (tri - 1) * 3);
    const vc = vec3.fromBuffer(_randomPointInConvexPolyVc, verts, tri * 3);

    out[0] = u * va[0] + v * vb[0] + w * vc[0];
    out[1] = u * va[1] + v * vb[1] + w * vc[1];
    out[2] = u * va[2] + v * vb[2] + w * vc[2];

    return out;
};

/**
 * Projects a polygon onto an axis and returns the min/max projection values.
 * @param out Output tuple [min, max]
 * @param axis The axis to project onto [x, z]
 * @param verts Polygon vertices [x,y,z,x,y,z,...]
 * @param nverts Number of vertices
 */
const projectPoly = (out: [number, number], axis: Vec2, verts: number[], nverts: number): void => {
    let min = axis[0] * verts[0] + axis[1] * verts[2]; // dot product with first vertex (x,z)
    let max = min;

    for (let i = 1; i < nverts; i++) {
        const dot = axis[0] * verts[i * 3] + axis[1] * verts[i * 3 + 2]; // dot product (x,z)
        min = Math.min(min, dot);
        max = Math.max(max, dot);
    }

    out[0] = min;
    out[1] = max;
};

/**
 * Checks if two ranges overlap with epsilon tolerance.
 * @param amin Min value of range A
 * @param amax Max value of range A
 * @param bmin Min value of range B
 * @param bmax Max value of range B
 * @param eps Epsilon tolerance
 * @returns True if ranges overlap
 */
const overlapRange = (amin: number, amax: number, bmin: number, bmax: number, eps: number): boolean => {
    return !(amin + eps > bmax || amax - eps < bmin);
};

const _overlapPolyPolyNormal: Vec2 = vec2.create();
const _overlapPolyPolyVa: Vec2 = vec2.create();
const _overlapPolyPolyVb: Vec2 = vec2.create();
const _overlapPolyPolyProjA: [number, number] = [0, 0];
const _overlapPolyPolyProjB: [number, number] = [0, 0];

/**
 * Tests if two convex polygons overlap in 2D (XZ plane).
 * Uses the separating axis theorem - matches the C++ dtOverlapPolyPoly2D implementation.
 * All vertices are projected onto the xz-plane, so the y-values are ignored.
 *
 * @param vertsA Vertices of the first polygon [x,y,z,x,y,z,...]
 * @param nvertsA Number of vertices in the first polygon
 * @param vertsB Vertices of the second polygon [x,y,z,x,y,z,...]
 * @param nvertsB Number of vertices in the second polygon
 * @returns True if the polygons overlap
 */
export const overlapPolyPoly2D = (vertsA: number[], nvertsA: number, vertsB: number[], nvertsB: number): boolean => {
    const eps = 1e-4;

    // Check separation along each edge normal of polygon A
    for (let i = 0, j = nvertsA - 1; i < nvertsA; j = i++) {
        const va = _overlapPolyPolyVa;
        const vb = _overlapPolyPolyVb;

        va[0] = vertsA[j * 3]; // x
        va[1] = vertsA[j * 3 + 2]; // z
        vb[0] = vertsA[i * 3]; // x
        vb[1] = vertsA[i * 3 + 2]; // z

        // Calculate edge normal: n = { vb[z]-va[z], -(vb[x]-va[x]) }
        const normal = _overlapPolyPolyNormal;
        normal[0] = vb[1] - va[1]; // z component
        normal[1] = -(vb[0] - va[0]); // negative x component

        // Project both polygons onto this normal
        const projA = _overlapPolyPolyProjA;
        const projB = _overlapPolyPolyProjB;
        projectPoly(projA, normal, vertsA, nvertsA);
        projectPoly(projB, normal, vertsB, nvertsB);

        // Check if projections are separated
        if (!overlapRange(projA[0], projA[1], projB[0], projB[1], eps)) {
            // Found separating axis
            return false;
        }
    }

    // Check separation along each edge normal of polygon B
    for (let i = 0, j = nvertsB - 1; i < nvertsB; j = i++) {
        const va = _overlapPolyPolyVa;
        const vb = _overlapPolyPolyVb;

        va[0] = vertsB[j * 3]; // x
        va[1] = vertsB[j * 3 + 2]; // z
        vb[0] = vertsB[i * 3]; // x
        vb[1] = vertsB[i * 3 + 2]; // z

        // Calculate edge normal: n = { vb[z]-va[z], -(vb[x]-va[x]) }
        const normal = _overlapPolyPolyNormal;
        normal[0] = vb[1] - va[1]; // z component
        normal[1] = -(vb[0] - va[0]); // negative x component

        // Project both polygons onto this normal
        const projA = _overlapPolyPolyProjA;
        const projB = _overlapPolyPolyProjB;
        projectPoly(projA, normal, vertsA, nvertsA);
        projectPoly(projB, normal, vertsB, nvertsB);

        // Check if projections are separated
        if (!overlapRange(projA[0], projA[1], projB[0], projB[1], eps)) {
            // Found separating axis
            return false;
        }
    }

    // No separating axis found, polygons overlap
    return true;
};
