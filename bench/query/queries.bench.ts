import { bench, group } from '@pmndrs/labs';
import type { Vec3 } from 'math';
import { mulberry32 } from 'math/random';
import type { Box3 } from 'math/shapes';
import { generateSoloNavMesh } from '../../blocks/generators/generate-solo-nav-mesh';
import {
    createFindNearestPolyResult,
    createGetClosestPointOnPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findNodePath,
    findPath,
    findRandomPoint,
    findStraightPath,
    getClosestPointOnPoly,
    moveAlongSurface,
    type NodeRef,
    queryPolygons,
    raycast,
} from '../../src';
import { defaultOptions, loadNavTestInput } from '../fixtures/nav-test';

// Per-tick agent queries over the nav-test navmesh: each sample runs a batch of
// seeded queries so the measured time sits well above the timer noise floor.
const navMesh = generateSoloNavMesh(loadNavTestInput(), defaultOptions).navMesh;

const filter = DEFAULT_QUERY_FILTER;
const halfExtents: Vec3 = [1, 1, 1];
const BATCH = 64;

const state = mulberry32.create(1234);
const rand = () => mulberry32.sample(state);

const randomPoint = (): Vec3 => {
    const { position } = findRandomPoint(navMesh, filter, rand);
    return [position[0], position[1], position[2]];
};

// on-mesh start / end pairs anywhere on the mesh
const farPairs: [Vec3, Vec3][] = [];
for (let i = 0; i < BATCH; i++) farPairs.push([randomPoint(), randomPoint()]);

// short hops: end within ~2m of start, like a companion following its leader
const nearPairs: [Vec3, Vec3][] = [];
for (let i = 0; i < BATCH; i++) {
    const start = randomPoint();
    const end: Vec3 = [start[0] + (rand() - 0.5) * 4, start[1], start[2] + (rand() - 0.5) * 4];
    nearPairs.push([start, end]);
}

// snapped start / end polys for the lower-level queries
type Snapped = { startRef: NodeRef; startPos: Vec3; endRef: NodeRef; endPos: Vec3 };
const snap = (pairs: [Vec3, Vec3][]): Snapped[] => {
    const out: Snapped[] = [];
    const nearest = createFindNearestPolyResult();
    for (const [a, b] of pairs) {
        findNearestPoly(nearest, navMesh, a, halfExtents, filter);
        if (!nearest.success) continue;
        const startRef = nearest.nodeRef;
        const startPos: Vec3 = [nearest.position[0], nearest.position[1], nearest.position[2]];
        findNearestPoly(nearest, navMesh, b, halfExtents, filter);
        if (!nearest.success) continue;
        out.push({
            startRef,
            startPos,
            endRef: nearest.nodeRef,
            endPos: [nearest.position[0], nearest.position[1], nearest.position[2]],
        });
    }
    return out;
};
const farSnapped = snap(farPairs);
const nearSnapped = snap(nearPairs);

const farNodePaths = farSnapped.map((s) => ({
    ...s,
    path: findNodePath(navMesh, s.startRef, s.endRef, s.startPos, s.endPos, filter).path,
}));

// query points: half on the mesh, half nudged off it
const points: Vec3[] = [];
for (let i = 0; i < BATCH; i++) {
    const p = randomPoint();
    if (i % 2) {
        p[0] += (rand() - 0.5) * 3;
        p[1] += (rand() - 0.5) * 1;
        p[2] += (rand() - 0.5) * 3;
    }
    points.push(p);
}

group('navmesh query — per-tick agent workloads (nav-test) @query', () => {
    bench(`findPath across the mesh x${BATCH}`, function* () {
        yield () => {
            let n = 0;
            for (const [a, b] of farPairs) n += findPath(navMesh, a, b, halfExtents, filter).path.length;
            return n;
        };
    }).gc(true);

    bench(`findPath short hops x${BATCH}`, function* () {
        yield () => {
            let n = 0;
            for (const [a, b] of nearPairs) n += findPath(navMesh, a, b, halfExtents, filter).path.length;
            return n;
        };
    }).gc(true);

    bench(`findNodePath across the mesh x${farSnapped.length}`, function* () {
        yield () => {
            let n = 0;
            for (const s of farSnapped)
                n += findNodePath(navMesh, s.startRef, s.endRef, s.startPos, s.endPos, filter).path.length;
            return n;
        };
    }).gc(true);

    bench(`findStraightPath across the mesh x${farNodePaths.length}`, function* () {
        yield () => {
            let n = 0;
            for (const s of farNodePaths) n += findStraightPath(navMesh, s.startPos, s.endPos, s.path).path.length;
            return n;
        };
    }).gc(true);

    bench(`findNearestPoly x${BATCH}`, function* () {
        const result = createFindNearestPolyResult();
        yield () => {
            let n = 0;
            for (const p of points) n += findNearestPoly(result, navMesh, p, halfExtents, filter).nodeRef;
            return n;
        };
    }).gc(true);

    bench(`findNearestPoly 5m half extents x${BATCH}`, function* () {
        const result = createFindNearestPolyResult();
        const wide: Vec3 = [5, 5, 5];
        yield () => {
            let n = 0;
            for (const p of points) n += findNearestPoly(result, navMesh, p, wide, filter).nodeRef;
            return n;
        };
    }).gc(true);

    bench(`queryPolygons x${BATCH}`, function* () {
        const bounds: Box3 = [0, 0, 0, 0, 0, 0];
        yield () => {
            let n = 0;
            for (const p of points) {
                bounds[0] = p[0] - 2;
                bounds[1] = p[1] - 2;
                bounds[2] = p[2] - 2;
                bounds[3] = p[0] + 2;
                bounds[4] = p[1] + 2;
                bounds[5] = p[2] + 2;
                n += queryPolygons(navMesh, bounds, filter).length;
            }
            return n;
        };
    }).gc(true);

    bench(`getClosestPointOnPoly x${nearSnapped.length}`, function* () {
        const result = createGetClosestPointOnPolyResult();
        yield () => {
            let n = 0;
            for (const s of nearSnapped) n += getClosestPointOnPoly(result, navMesh, s.startRef, s.endPos).position[1];
            return n;
        };
    }).gc(true);

    bench(`raycast (line of sight) x${nearSnapped.length}`, function* () {
        yield () => {
            let n = 0;
            for (const s of nearSnapped) n += raycast(navMesh, s.startRef, s.startPos, s.endPos, filter).t;
            return n;
        };
    }).gc(true);

    bench(`moveAlongSurface x${nearSnapped.length}`, function* () {
        yield () => {
            let n = 0;
            for (const s of nearSnapped) n += moveAlongSurface(navMesh, s.startRef, s.startPos, s.endPos, filter).position[0];
            return n;
        };
    }).gc(true);
});
