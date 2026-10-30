import { bench, group } from '@pmndrs/labs';
import type { Vec3 } from 'math';
import { generateSoloNavMesh } from '../../blocks/generators/generate-solo-nav-mesh';
import { DEFAULT_QUERY_FILTER, findPath } from '../../src';
import { defaultOptions, loadNavTestInput } from '../fixtures/nav-test';

// Pathfinding queries over the nav-test navmesh. The navmesh is built once in
// setup; findPath is a read-only query, so it is measured directly.
const navMesh = generateSoloNavMesh(loadNavTestInput(), defaultOptions).navMesh;

const halfExtents: Vec3 = [1, 1, 1];

// start / end pairs taken from examples/src/example-find-path.ts
const start: Vec3 = [-3.94, 0.26, 4.71];
const end: Vec3 = [2.52, 2.39, -2.2];

group('navmesh query — findPath (nav-test) @query', () => {
    bench('findPath across the mesh', function* () {
        yield () => {
            return findPath(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER);
        };
    }).gc(true);
});
