import { readFileSync } from 'node:fs';
import type { Vec3 } from 'math';
import { mulberry32 } from 'math/random';
import { beforeAll, describe, expect, test } from 'vitest';
import { generateTiledNavMesh, type TiledNavMeshOptions } from '../blocks';
import type { Box3 } from 'math/shapes';
import {
    addOffMeshConnection,
    addTile,
    buildTile,
    createFindNearestPolyResult,
    createNavMesh,
    createGetClosestPointOnPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findNodePath,
    findPath,
    findRandomPoint,
    FindStraightPathOptions,
    findStraightPath,
    getClosestPointOnPoly,
    getClosestPointOnPolyBoundary,
    getPortalPoints,
    moveAlongSurface,
    type ExternalPolygon,
    type NavMesh,
    type NodeRef,
    OffMeshConnectionDirection,
    polygonsToNavMeshTilePolys,
    polysToTileDetailMesh,
    queryPolygons,
    raycast,
    raycastWithCosts,
} from '../src';

// Seeded queries over a tiled nav-test navmesh with an off-mesh connection, digested and compared against
// a snapshot recorded before the query hot paths were optimized: those changes must not alter any output.

const fixture = JSON.parse(readFileSync(new URL('../bench/fixtures/nav-test.json', import.meta.url), 'utf8'));

const cellSize = 0.15;
const cellHeight = 0.15;
const tileSizeVoxels = 32;

const options: TiledNavMeshOptions = {
    cellSize,
    cellHeight,
    tileSizeVoxels,
    tileSizeWorld: tileSizeVoxels * cellSize,
    walkableRadiusWorld: 0.1,
    walkableRadiusVoxels: Math.ceil(0.1 / cellSize),
    walkableClimbWorld: 0.5,
    walkableClimbVoxels: Math.ceil(0.5 / cellHeight),
    walkableHeightWorld: 0.25,
    walkableHeightVoxels: Math.ceil(0.25 / cellHeight),
    walkableSlopeAngleDegrees: 45,
    borderSize: 4,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxSimplificationError: 1.3,
    maxEdgeLength: 12,
    maxVerticesPerPoly: 5,
    detailSampleDistance: cellSize * 6,
    detailSampleMaxError: cellHeight,
};

const createDigest = () => {
    const f64 = new Float64Array(1);
    const u32 = new Uint32Array(f64.buffer);
    let hash = 0x811c9dc5;
    let count = 0;
    const add = (value: number | boolean | null | undefined) => {
        f64[0] = value === null ? -1e300 : value === undefined ? -2e300 : typeof value === 'boolean' ? Number(value) : value;
        hash = Math.imul(hash ^ u32[0], 16777619);
        hash = Math.imul(hash ^ u32[1], 16777619);
        count++;
    };
    const addAll = (values: ArrayLike<number>) => {
        for (let i = 0; i < values.length; i++) add(values[i]);
    };
    return { add, addAll, value: () => `${(hash >>> 0).toString(16)}/${count}` };
};

const QUERIES = 250;
const he: Vec3 = [1, 1, 1];
const filter = DEFAULT_QUERY_FILTER;

let navMesh: NavMesh;
let points: Vec3[];
let rand: () => number;

beforeAll(() => {
    const input = { positions: new Float32Array(fixture.positions), indices: new Uint32Array(fixture.indices) };
    navMesh = generateTiledNavMesh(input, options).navMesh;

    const state = mulberry32.create(1234);
    rand = () => mulberry32.sample(state);

    const randomPoint = (): Vec3 => {
        const result = findRandomPoint(navMesh, filter, rand);
        return [result.position[0], result.position[1], result.position[2]];
    };

    addOffMeshConnection(navMesh, {
        start: randomPoint(),
        end: randomPoint(),
        radius: 0.5,
        direction: OffMeshConnectionDirection.BIDIRECTIONAL,
        flags: 1,
        area: 0,
    });

    points = [];
    for (let i = 0; i < QUERIES * 2; i++) {
        const p = randomPoint();
        // half on the mesh, half nudged off it
        if (i % 2) {
            p[2] += (rand() - 0.5) * 3;
            p[0] += (rand() - 0.5) * 3;
            p[1] += (rand() - 0.5) * 1;
        }
        points.push(p);
    }
});

describe('query regression', () => {
    test('navmesh under test', () => {
        expect({
            tiles: Object.keys(navMesh.tiles).length,
            nodes: navMesh.nodes.length,
            links: navMesh.links.length,
            crossTileLinks: navMesh.links.filter((link) => link.allocated && link.side !== 0xff).length,
        }).toMatchSnapshot();
    });

    test('findPath', () => {
        const digest = createDigest();
        let complete = 0;
        for (let i = 0; i < QUERIES; i++) {
            for (const raycastDistance of [undefined, 3]) {
                const result = findPath(navMesh, points[i * 2], points[i * 2 + 1], he, filter, { raycastDistance });
                if (result.success && result.path.length > 2) complete++;
                digest.add(result.success);
                digest.add(result.flags);
                digest.add(result.nodePathFlags);
                digest.add(result.straightPathFlags);
                digest.add(result.startNodeRef);
                digest.add(result.endNodeRef);
                digest.addAll(result.startPosition);
                digest.addAll(result.endPosition);
                if (result.nodePath) digest.addAll(result.nodePath.path);
                for (const point of result.path) {
                    digest.addAll(point.position);
                    digest.add(point.nodeRef);
                    digest.add(point.type);
                    digest.add(point.flags);
                }
            }
        }
        expect({ digest: digest.value(), pathsWithCorners: complete }).toMatchSnapshot();
    });

    test('findNodePath search state', () => {
        const digest = createDigest();
        const start = createFindNearestPolyResult();
        const end = createFindNearestPolyResult();
        for (let i = 0; i < QUERIES; i++) {
            findNearestPoly(start, navMesh, points[i * 2], he, filter);
            findNearestPoly(end, navMesh, points[i * 2 + 1], he, filter);
            if (!start.success || !end.success) continue;

            for (const raycastDistance of [undefined, 3]) {
                const result = findNodePath(navMesh, start.nodeRef, end.nodeRef, start.position, end.position, filter, {
                    raycastDistance,
                });
                digest.add(result.success);
                digest.add(result.flags);
                digest.addAll(result.path);
                for (const key of Object.keys(result.nodes)) {
                    digest.add(Number(key));
                    for (const node of result.nodes[key as unknown as NodeRef]) {
                        digest.add(node.nodeRef);
                        digest.add(node.state);
                        digest.add(node.flags);
                        digest.add(node.cost);
                        digest.add(node.total);
                        digest.add(node.parentNodeRef);
                        digest.add(node.parentState);
                        digest.addAll(node.position);
                    }
                }
                for (const node of result.openList) {
                    digest.add(node.nodeRef);
                    digest.add(node.state);
                    digest.add(node.total);
                }
            }
        }
        expect(digest.value()).toMatchSnapshot();
    });

    test('findStraightPath options and portals', () => {
        const digest = createDigest();
        const start = createFindNearestPolyResult();
        const end = createFindNearestPolyResult();
        const left: Vec3 = [0, 0, 0];
        const right: Vec3 = [0, 0, 0];
        for (let i = 0; i < QUERIES; i++) {
            findNearestPoly(start, navMesh, points[i * 2], he, filter);
            findNearestPoly(end, navMesh, points[i * 2 + 1], he, filter);
            if (!start.success || !end.success) continue;

            const nodePath = findNodePath(navMesh, start.nodeRef, end.nodeRef, start.position, end.position, filter).path;

            for (let j = 0; j + 1 < nodePath.length; j++) {
                digest.add(getPortalPoints(navMesh, nodePath[j], nodePath[j + 1], left, right));
                digest.addAll(left);
                digest.addAll(right);
            }

            for (const [maxPoints, pathOptions] of [
                [null, 0],
                [null, FindStraightPathOptions.ALL_CROSSINGS],
                [null, FindStraightPathOptions.AREA_CROSSINGS],
                [3, FindStraightPathOptions.ALL_CROSSINGS],
            ] as const) {
                const result = findStraightPath(navMesh, start.position, end.position, nodePath, maxPoints, pathOptions);
                digest.add(result.success);
                digest.add(result.flags);
                for (const point of result.path) {
                    digest.addAll(point.position);
                    digest.add(point.nodeRef);
                    digest.add(point.type);
                    digest.add(point.flags);
                }
            }
        }
        expect(digest.value()).toMatchSnapshot();
    });

    test('nearest poly, closest points and queryPolygons', () => {
        const digest = createDigest();
        const nearest = createFindNearestPolyResult();
        const closest = createGetClosestPointOnPolyResult();
        const boundary: Vec3 = [0, 0, 0];
        for (let i = 0; i < QUERIES * 2; i++) {
            const p = points[i];
            for (const halfExtents of [[0.5, 0.5, 0.5], he, [3, 3, 3]] as Vec3[]) {
                findNearestPoly(nearest, navMesh, p, halfExtents, filter);
                digest.add(nearest.success);
                digest.add(nearest.nodeRef);
                digest.addAll(nearest.position);

                const bounds = [
                    p[0] - halfExtents[0],
                    p[1] - halfExtents[1],
                    p[2] - halfExtents[2],
                    p[0] + halfExtents[0],
                    p[1] + halfExtents[1],
                    p[2] + halfExtents[2],
                ] as [number, number, number, number, number, number];
                digest.addAll(queryPolygons(navMesh, bounds, filter));
            }

            const ref = navMesh.nodes[Math.floor(rand() * navMesh.nodes.length)].ref;
            getClosestPointOnPoly(closest, navMesh, ref, p);
            digest.add(closest.success);
            digest.add(closest.isOverPoly);
            digest.addAll(closest.position);
            digest.add(getClosestPointOnPolyBoundary(boundary, navMesh, ref, p));
            digest.addAll(boundary);
        }
        expect(digest.value()).toMatchSnapshot();
    });

    test('raycast and moveAlongSurface', () => {
        const digest = createDigest();
        const start = createFindNearestPolyResult();
        for (let i = 0; i < QUERIES; i++) {
            findNearestPoly(start, navMesh, points[i * 2], he, filter);
            if (!start.success) continue;
            const end = points[i * 2 + 1];

            for (const result of [
                raycast(navMesh, start.nodeRef, start.position, end, filter),
                raycastWithCosts(navMesh, start.nodeRef, start.position, end, filter, 0),
            ]) {
                digest.add(result.t);
                digest.add(result.hitEdgeIndex);
                digest.add(result.pathCost);
                digest.addAll(result.hitNormal);
                digest.addAll(result.path);
            }

            const target: Vec3 = [
                start.position[0] + (end[0] - start.position[0]) * 0.2,
                start.position[1],
                start.position[2] + (end[2] - start.position[2]) * 0.2,
            ];
            const moved = moveAlongSurface(navMesh, start.nodeRef, start.position, target, filter);
            digest.add(moved.success);
            digest.add(moved.nodeRef);
            digest.addAll(moved.position);
            digest.addAll(moved.visited);
        }
        expect(digest.value()).toMatchSnapshot();
    });
});

/** Tile A (x 0-2, z 0-2) is one quad; its neighbours split the shared borders, so A's links are partial portals. */
const createPartialPortalNavMesh = (): NavMesh => {
    const navMesh = createNavMesh();
    navMesh.origin = [0, 0, 0];
    navMesh.tileWidth = 2;
    navMesh.tileHeight = 2;

    const addQuadTile = (tileX: number, tileY: number, bounds: Box3, quads: [number, number, number, number][]) => {
        const vertices: number[] = [];
        const polygons: ExternalPolygon[] = [];
        for (const [z0, x0, z1, x1] of quads) {
            const base = vertices.length / 3;
            vertices.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0);
            polygons.push({ vertices: [base, base + 1, base + 2, base + 3], area: 0, flags: 1 });
        }
        const tilePolys = polygonsToNavMeshTilePolys(polygons, vertices, 1, bounds);
        const detail = polysToTileDetailMesh(tilePolys.polys);
        addTile(
            navMesh,
            buildTile({
                bounds,
                vertices: tilePolys.vertices,
                polys: tilePolys.polys,
                detailMeshes: detail.detailMeshes,
                detailVertices: detail.detailVertices,
                detailTriangles: detail.detailTriangles,
                tileX,
                tileY,
                tileLayer: 0,
                cellSize: 0.2,
                cellHeight: 0.2,
                walkableHeight: 0.5,
                walkableRadius: 0.5,
                walkableClimb: 0.5,
            }),
        );
    };

    addQuadTile(0, 0, [0, 0, 0, 2, 1, 2], [[0, 0, 2, 2]]);
    addQuadTile(
        1,
        0,
        [2, 0, 0, 4, 1, 2],
        [
            [0, 2, 1, 4],
            [1, 2, 2, 4],
        ],
    );
    addQuadTile(
        0,
        1,
        [0, 0, 2, 2, 1, 4],
        [
            [2, 0, 4, 0.7],
            [2, 0.7, 4, 1.3],
            [2, 1.3, 4, 2],
        ],
    );

    return navMesh;
};

describe('query regression, partial tile portals', () => {
    test('paths, portals and rays across partial portals', () => {
        const partial = createPartialPortalNavMesh();
        const links = partial.links.filter((link) => link.allocated && link.side !== 0xff);
        const partialLinks = links.filter((link) => link.bmin !== 0 || link.bmax !== 255).length;

        const digest = createDigest();
        const start = createFindNearestPolyResult();
        const end = createFindNearestPolyResult();
        const left: Vec3 = [0, 0, 0];
        const right: Vec3 = [0, 0, 0];
        const samples: Vec3[] = [];
        for (let z = 0.15; z < 4; z += 0.45) {
            for (let x = 0.15; x < 4; x += 0.45) {
                samples.push([x, 0, z]);
            }
        }

        for (let i = 0; i < samples.length; i++) {
            for (let j = 0; j < samples.length; j += 7) {
                const a = samples[i];
                const b = samples[j];
                findNearestPoly(start, partial, a, he, filter);
                findNearestPoly(end, partial, b, he, filter);
                digest.add(start.success);
                digest.add(end.success);
                if (!start.success || !end.success) continue;

                const nodePath = findNodePath(partial, start.nodeRef, end.nodeRef, start.position, end.position, filter);
                digest.addAll(nodePath.path);
                for (const key of Object.keys(nodePath.nodes)) {
                    for (const node of nodePath.nodes[key as unknown as NodeRef]) {
                        digest.add(node.cost);
                        digest.add(node.total);
                        digest.addAll(node.position);
                    }
                }
                for (let k = 0; k + 1 < nodePath.path.length; k++) {
                    digest.add(getPortalPoints(partial, nodePath.path[k], nodePath.path[k + 1], left, right));
                    digest.addAll(left);
                    digest.addAll(right);
                }

                const path = findPath(partial, a, b, he, filter);
                for (const point of path.path) digest.addAll(point.position);

                const ray = raycast(partial, start.nodeRef, start.position, b, filter);
                digest.add(ray.t);
                digest.add(ray.hitEdgeIndex);
                digest.addAll(ray.hitNormal);
                digest.addAll(ray.path);
            }
        }

        expect({ externalLinks: links.length, partialLinks, digest: digest.value() }).toMatchSnapshot();
    });
});
