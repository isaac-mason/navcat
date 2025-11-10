import GUI from 'lil-gui';
import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findNodePath,
    findStraightPath,
    getEdgeMidPoint,
    getNodeRefType,
    type NavMesh,
    type NodeRef,
    NodeType,
    type QueryFilter,
} from 'navcat';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { createNavMeshHelper, createNavMeshPolyHelper, getPositionsAndIndices } from 'navcat/three';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
import { createExample } from './common/example-base';
import { createFlag } from './common/flag';
import { loadGLTF } from './common/load-gltf';

/**
 * This example demonstrates Yen's k-shortest paths algorithm for finding multiple
 * alternative paths between two points on a navigation mesh.
 *
 * Yen's Algorithm (1971):
 * 1. Find the shortest path using A*
 * 2. For each k-th iteration:
 *    - For each node in the (k-1)-th path:
 *      a. Create a "spur node" at position i
 *      b. Remove edges from previous paths that share the same root path [0...i]
 *      c. Remove nodes in the root path [0...i-1] to prevent loops
 *      d. Find shortest path from spur node to end with modified graph
 *      e. Combine root path + spur path
 *    - Add the shortest candidate path to results
 * 3. Repeat until k paths found or no more candidates
 */

type NodePath = {
    path: NodeRef[];
    cost: number;
};

type PathCandidate = {
    nodePath: NodeRef[];
    cost: number;
    rootLength: number; // for deduplication
};

function findShortestPaths(
    navMesh: NavMesh,
    start: Vec3,
    end: Vec3,
    halfExtents: Vec3,
    baseFilter: QueryFilter,
    k: number = 3,
): NodePath[] {
    // calculate the actual cost of a path by computing straight line distances
    const calculatePathCost = (path: NodeRef[], startPos: Vec3, endPos: Vec3): number => {
        if (path.length === 0) return Number.POSITIVE_INFINITY;
        if (path.length === 1) {
            // single node: distance from start to end
            return vec3.distance(startPos, endPos);
        }

        let totalCost = 0;
        let prevPos = startPos;

        for (let i = 0; i < path.length; i++) {
            const currentNode = path[i];
            const nextNode = i < path.length - 1 ? path[i + 1] : null;

            let currentPos: Vec3;
            if (i === path.length - 1) {
                // last node: use end position
                currentPos = endPos;
            } else if (nextNode) {
                // intermediate node: use edge midpoint to next node
                const midpoint = vec3.create();
                if (getEdgeMidPoint(navMesh, currentNode, nextNode, midpoint)) {
                    currentPos = midpoint;
                } else {
                    // fallback if edge midpoint fails
                    currentPos = prevPos;
                }
            } else {
                currentPos = prevPos;
            }

            totalCost += vec3.distance(prevPos, currentPos);
            prevPos = currentPos;
        }

        return totalCost;
    };

    const edgeKey = (from: NodeRef, to: NodeRef): string => `${from},${to}`;

    const createBlockingFilter = (blockedNodes: Set<NodeRef>, blockedEdges: Set<string>): QueryFilter => ({
        passFilter: (ref, nm) => {
            if (blockedNodes.has(ref)) return false;
            return baseFilter.passFilter(ref, nm);
        },
        getCost: (pa, pb, nm, prevRef, curRef, nextRef) => {
            if (curRef && nextRef) {
                if (blockedEdges.has(edgeKey(curRef, nextRef))) {
                    return Number.POSITIVE_INFINITY;
                }
            }
            return baseFilter.getCost(pa, pb, nm, prevRef, curRef, nextRef);
        },
    });

    const pathsEqual = (a: NodeRef[], b: NodeRef[]): boolean => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    };

    const A: NodePath[] = []; // accepted k-shortest paths
    const B: PathCandidate[] = []; // candidate paths (will be sorted by cost)

    // find start and end node refs once
    const startNearestPolyResult = findNearestPoly(createFindNearestPolyResult(), navMesh, start, halfExtents, baseFilter);
    if (!startNearestPolyResult.success) return [];

    const endNearestPolyResult = findNearestPoly(createFindNearestPolyResult(), navMesh, end, halfExtents, baseFilter);
    if (!endNearestPolyResult.success) return [];

    const startNodeRef = startNearestPolyResult.nodeRef;
    const endNodeRef = endNearestPolyResult.nodeRef;

    // step 1: Find the shortest path using findNodePath directly
    const firstPath = findNodePath(navMesh, startNodeRef, endNodeRef, start, end, baseFilter);
    if (!firstPath.success) {
        return [];
    }

    const firstCost = calculatePathCost(firstPath.path, start, end);
    A.push({ path: firstPath.path, cost: firstCost });

    // step 2: Find k-1 more paths
    for (let k_iter = 1; k_iter < k; k_iter++) {
        const prevRoute = A[k_iter - 1];
        const prevPath = prevRoute.path;

        // for each node in the previous path (except last)
        for (let i = 0; i < prevPath.length - 1; i++) {
            const spurNode = prevPath[i];
            const rootPath = prevPath.slice(0, i + 1);

            // collect edges and nodes to block
            const blockedEdges = new Set<string>();
            const blockedNodes = new Set<NodeRef>();

            // block nodes in root path (except spur node)
            for (let j = 0; j < i; j++) {
                blockedNodes.add(rootPath[j]);
            }

            // block edges used by previous paths that share the same root
            for (const route of A) {
                const p = route.path;
                // check if this path shares the root [0...i]
                let sharesRoot = true;
                for (let j = 0; j <= i && j < p.length; j++) {
                    if (p[j] !== rootPath[j]) {
                        sharesRoot = false;
                        break;
                    }
                }

                if (sharesRoot && i + 1 < p.length) {
                    // block the edge from node i to i+1
                    blockedEdges.add(edgeKey(p[i], p[i + 1]));
                }
            }

            // find spur path from spurNode to end using findNodePath directly
            const spurFilter = createBlockingFilter(blockedNodes, blockedEdges);
            const nextNode = prevPath[i + 1];
            const spurNodePos = i === 0 ? start : (() => {
                const midpoint = vec3.create();
                getEdgeMidPoint(navMesh, spurNode, nextNode, midpoint);
                return midpoint;
            })();

            const spurPathResult = findNodePath(navMesh, spurNode, endNodeRef, spurNodePos, end, spurFilter);

            if (spurPathResult.success) {
                const spurPath = spurPathResult.path;

                // combine root + spur paths
                // spurPath starts from spurNode, so we skip the first element to avoid duplication
                const totalPath = [...rootPath, ...spurPath.slice(1)];

                // check for duplicates
                const isDuplicate =
                    A.some((route) => pathsEqual(route.path, totalPath)) ||
                    B.some((candidate) => pathsEqual(candidate.nodePath, totalPath));
                if (isDuplicate) continue;

                // calculate the total cost of the combined path
                const totalCost = calculatePathCost(totalPath, start, end);

                B.push({ nodePath: totalPath, cost: totalCost, rootLength: i });
            }
        }

        if (B.length === 0) break; // no more paths available

        // sort candidates by cost and take the cheapest
        B.sort((a, b) => a.cost - b.cost);
        const nextCandidate = B.shift()!;

        A.push({ path: nextCandidate.nodePath, cost: nextCandidate.cost });
    }

    return A;
}

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const navTestModel = await loadGLTF('./models/nav-test.glb');
scene.add(navTestModel.scene);

/* generate navmesh */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = getPositionsAndIndices(walkableMeshes);

const navMeshInput: TiledNavMeshInput = {
    positions,
    indices,
};

const cellSize = 0.15;
const cellHeight = 0.15;

const tileSizeVoxels = 64;
const tileSizeWorld = tileSizeVoxels * cellSize;

const walkableRadiusWorld = 0.1;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 0.25;
const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);
const walkableSlopeAngleDegrees = 45;

const borderSize = 4;
const minRegionArea = 8;
const mergeRegionArea = 20;

const maxSimplificationError = 1.3;
const maxEdgeLength = 12;

const maxVerticesPerPoly = 5;

const detailSampleDistanceVoxels = 6;
const detailSampleDistance = detailSampleDistanceVoxels < 0.9 ? 0 : cellSize * detailSampleDistanceVoxels;

const detailSampleMaxErrorVoxels = 1;
const detailSampleMaxError = cellHeight * detailSampleMaxErrorVoxels;

const navMeshConfig: TiledNavMeshOptions = {
    cellSize,
    cellHeight,
    tileSizeVoxels,
    tileSizeWorld,
    walkableRadiusWorld,
    walkableRadiusVoxels,
    walkableClimbWorld,
    walkableClimbVoxels,
    walkableHeightWorld,
    walkableHeightVoxels,
    walkableSlopeAngleDegrees,
    borderSize,
    minRegionArea,
    mergeRegionArea,
    maxSimplificationError,
    maxEdgeLength,
    maxVerticesPerPoly,
    detailSampleDistance,
    detailSampleMaxError,
};

const navMeshResult = generateTiledNavMesh(navMeshInput, navMeshConfig);
const navMesh = navMeshResult.navMesh;

const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

/* find path */
let start: Vec3 = [-3.94, 0.26, 4.71];
let end: Vec3 = [2.52, 2.39, -2.2];
const halfExtents: Vec3 = [1, 1, 1];

const kShortestConfig = {
    k: 3,
};

type Visual = { object: THREE.Object3D; dispose: () => void };
let visuals: Visual[] = [];

function clearVisuals() {
    for (const visual of visuals) {
        scene.remove(visual.object);
        visual.dispose();
    }
    visuals = [];
}

function addVisual(visual: Visual) {
    visuals.push(visual);
    scene.add(visual.object);
}

function updatePath() {
    clearVisuals();

    const startFlag = createFlag(0x2196f3);
    startFlag.object.position.set(...start);
    addVisual(startFlag);

    const endFlag = createFlag(0x00ff00);
    endFlag.object.position.set(...end);
    addVisual(endFlag);

    console.time('findShortestPaths');

    const nodePaths = findShortestPaths(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER, kShortestConfig.k);

    console.timeEnd('findShortestPaths');

    console.log(`Found ${nodePaths.length} paths (Yen's k-shortest)`);
    console.log('nodePaths', nodePaths);

    const routeColors = ['yellow', 'orange', 'cyan', 'magenta', 'lime', 'aqua', 'pink', 'gold', 'salmon', 'violet'];

    for (let pathIdx = 0; pathIdx < nodePaths.length; pathIdx++) {
        const nodePath = nodePaths[pathIdx];
        const routeColor = routeColors[pathIdx] || 'white';

        // visualize polygon helpers for the shortest path
        if (pathIdx === 0) {
            for (let i = 0; i < nodePath.path.length; i++) {
                const node = nodePath.path[i];
                if (getNodeRefType(node) === NodeType.POLY) {
                    const polyHelper = createNavMeshPolyHelper(navMesh, node);
                    polyHelper.object.position.y += 0.15;
                    addVisual(polyHelper);
                }
            }
        }

        // generate straight path for visualization
        const straightPathResult = findStraightPath(navMesh, start, end, nodePath.path);

        if (straightPathResult.success && straightPathResult.path.length > 0) {
            const straightPath = straightPathResult.path;

            for (let i = 0; i < straightPath.length; i++) {
                const point = straightPath[i];
                // point (smaller for alternative paths)
                const pointSize = pathIdx === 0 ? 0.2 : 0.15;
                const mesh = new THREE.Mesh(
                    new THREE.SphereGeometry(pointSize),
                    new THREE.MeshBasicMaterial({ color: routeColor }),
                );
                mesh.position.set(...point.position);
                mesh.position.y += 0.1;
                addVisual({
                    object: mesh,
                    dispose: () => {
                        mesh.geometry?.dispose();
                        mesh.material?.dispose();
                    },
                });
                // line
                if (i > 0) {
                    const prevPoint = straightPath[i - 1];
                    const geometry = new LineGeometry();
                    geometry.setFromPoints([new THREE.Vector3(...prevPoint.position), new THREE.Vector3(...point.position)]);
                    const material = new Line2NodeMaterial({
                        color: routeColor,
                        linewidth: pathIdx === 0 ? 0.1 : 0.08,
                        worldUnits: true,
                    });
                    const line = new Line2(geometry, material);
                    line.position.y += 0.1;
                    addVisual({
                        object: line,
                        dispose: () => {
                            line.geometry?.dispose();
                            line.material?.dispose();
                        },
                    });
                }
            }
        }
    }
}

/* interaction */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function getPointOnNavMesh(event: PointerEvent): Vec3 | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(walkableMeshes, true);
    if (intersects.length > 0) {
        const p = intersects[0].point;
        return [p.x, p.y, p.z];
    }
    return null;
}

let moving: 'start' | 'end' | null = null;

renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    const point = getPointOnNavMesh(event);

    if (!point) return;

    if (event.button === 0) {
        if (moving === 'start') {
            moving = null;
            renderer.domElement.style.cursor = '';
            start = point;
        } else {
            moving = 'start';
            renderer.domElement.style.cursor = 'crosshair';
            start = point;
        }
    } else if (event.button === 2) {
        if (moving === 'end') {
            moving = null;
            renderer.domElement.style.cursor = '';
            end = point;
        } else {
            moving = 'end';
            renderer.domElement.style.cursor = 'crosshair';
            end = point;
        }
    }
    updatePath();
});

renderer.domElement.addEventListener('pointermove', (event: PointerEvent) => {
    if (!moving) return;

    const point = getPointOnNavMesh(event);
    if (!point) return;

    if (moving === 'start') {
        start = point;
    } else if (moving === 'end') {
        end = point;
    }

    updatePath();
});

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

/* GUI controls */
const gui = new GUI();
gui.title("Yen's k-Shortest Paths");

const pathsFolder = gui.addFolder('Algorithm Settings');
pathsFolder
    .add(kShortestConfig, 'k', 1, 10, 1)
    .name('k (Number of Paths)')
    .onChange(() => updatePath());
pathsFolder.open();

/* initial update */
updatePath();

/* start loop */
function update() {
    requestAnimationFrame(update);
    orbitControls.update();
    renderer.render(scene, camera);
}

update();
