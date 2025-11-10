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
    getNodeByRef,
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
 * This example demonstrates a penalty-based heuristic for finding multiple diverse paths
 * between two points on a navigation mesh. This is not a formal k-shortest paths algorithm,
 * but rather a practical technique for finding visually distinct routes.
 *
 * APPROACH:
 * 1. Find a path using standard A*
 * 2. Apply penalties to nodes used in the path (and their neighbors)
 * 3. Re-run A* with the penalized cost function to find alternative paths
 * 4. Filter candidates by:
 *    - Cost stretch: reject paths significantly longer than optimal
 *    - Path dissimilarity: reject paths too similar to existing ones (using Jaccard index)
 * 5. Repeat until k paths are found or max attempts reached
 */

type FindDiversePathsOptions = {
    k?: number; // number of alternatives including the fastest
    maxStretch?: number; // e.g. 0.08 => ≤ +8% cost vs best
    maxShared?: number; // max allowed overlap (Jaccard on node sets), e.g. 0.5
    basePenalty?: number; // cost bump per used node
    neighborDepth?: number; // how many hops to spread penalty (0..2)
    neighborDecay?: number; // penalty decay per hop, e.g. 0.5
    maxTries?: number; // safety bound
};

type NodePath = {
    path: NodeRef[];
    nodeSet: Set<NodeRef>;
    cost: number;
};

function findDiversePaths(
    navMesh: NavMesh,
    start: Vec3,
    end: Vec3,
    halfExtents: Vec3,
    baseFilter: QueryFilter,
    opts: FindDiversePathsOptions = {},
): NodePath[] {
    const {
        k = 3,
        maxStretch = 0.08,
        maxShared = 0.5,
        basePenalty = 80, // tune to your filter's scale; start large to force diversity
        neighborDepth = 1,
        neighborDecay = 0.5,
        maxTries = 10,
    } = opts;

    const accepted: NodePath[] = [];
    const penalty = new Map<NodeRef, number>();

    const computeUnpenalizedCost = (path: NodeRef[]): number => {
        if (path.length === 0) return Number.POSITIVE_INFINITY;

        const mids: Vec3[] = [];
        const tmp: Vec3 = vec3.create();
        mids.push(vec3.clone(start));

        for (let i = 0; i + 1 < path.length; i++) {
            if (getEdgeMidPoint(navMesh, path[i], path[i + 1], tmp)) {
                mids.push(vec3.clone(tmp));
            }
        }

        mids.push(vec3.clone(end));

        let total = 0;
        for (let j = 0; j + 1 < mids.length; j++) {
            const prevRef = j > 0 ? path[Math.min(j - 1, path.length - 1)] : undefined;
            const curRef = path[Math.min(j, path.length - 1)];
            const nextRef = j + 1 < path.length ? path[Math.min(j + 1, path.length - 1)] : undefined;
            total += baseFilter.getCost(mids[j], mids[j + 1], navMesh, prevRef, curRef, nextRef);
        }
        return total;
    };

    const nodeSetOf = (path: NodeRef[]) => new Set<NodeRef>(path);

    const jaccard = (a: Set<NodeRef>, b: Set<NodeRef>) => {
        let inter = 0;
        for (const x of a) if (b.has(x)) inter++;
        const union = a.size + b.size - inter;
        return union === 0 ? 0 : inter / union;
    };

    const spreadPenalty = (path: NodeRef[]) => {
        const used = path;
        const seen = new Set<NodeRef>();

        const add = (ref: NodeRef, amount: number) => {
            penalty.set(ref, (penalty.get(ref) ?? 0) + amount);
        };

        for (const ref of used) {
            add(ref, basePenalty);
            seen.add(ref);
        }

        // spread to neighbors up to depth
        for (let d = 1; d <= neighborDepth; d++) {
            const amount = basePenalty * neighborDecay ** d;
            const frontier: NodeRef[] = [];
            for (const ref of Array.from(seen)) {
                const node = getNodeByRef(navMesh, ref);
                if (!node) continue;
                for (const li of node.links) {
                    const link = navMesh.links[li];
                    if (!link) continue;
                    const nbr = link.toNodeRef;
                    if (!seen.has(nbr)) frontier.push(nbr);
                }
            }
            for (const ref of frontier) {
                add(ref, amount);
                seen.add(ref);
            }
        }
    };

    const makePenalized = (base: QueryFilter): QueryFilter => ({
        passFilter: (ref, nm) => base.passFilter(ref, nm),
        getCost: (pa, pb, nm, prevRef, curRef, nextRef) => {
            const baseCost = base.getCost(pa, pb, nm, prevRef, curRef, nextRef);
            const pCur = curRef ? (penalty.get(curRef) ?? 0) : 0;
            const pNext = nextRef ? (penalty.get(nextRef) ?? 0) : 0;
            return baseCost + pCur + 0.5 * pNext;
        },
    });

    // find start and end node refs
    const startNearestPolyResult = findNearestPoly(createFindNearestPolyResult(), navMesh, start, halfExtents, baseFilter);
    if (!startNearestPolyResult.success) return [];

    const endNearestPolyResult = findNearestPoly(createFindNearestPolyResult(), navMesh, end, halfExtents, baseFilter);
    if (!endNearestPolyResult.success) return [];

    const startNodeRef = startNearestPolyResult.nodeRef;
    const endNodeRef = endNearestPolyResult.nodeRef;

    // 1) best path
    const best = findNodePath(navMesh, startNodeRef, endNodeRef, start, end, baseFilter);
    if (!best.success) return [];
    const bestCost = computeUnpenalizedCost(best.path);
    const bestNodeSet = nodeSetOf(best.path);
    accepted.push({ path: best.path, cost: bestCost, nodeSet: bestNodeSet });
    spreadPenalty(best.path);

    // 2) alternatives
    let tries = 0;
    while (accepted.length < k && tries < maxTries) {
        tries++;
        const cand = findNodePath(navMesh, startNodeRef, endNodeRef, start, end, makePenalized(baseFilter));
        if (!cand.success) continue;

        const cost = computeUnpenalizedCost(cand.path);
        if (cost > (1 + maxStretch) * bestCost) continue;

        const nodes = nodeSetOf(cand.path);
        const tooSimilar = accepted.some((a) => jaccard(a.nodeSet, nodes) > maxShared);
        if (tooSimilar) continue;

        accepted.push({ path: cand.path, cost, nodeSet: nodes });
        spreadPenalty(cand.path);
    }

    accepted.sort((a, b) => a.cost - b.cost);

    return accepted.slice(0, k);
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

// Configuration for alternative path options
const altPathConfig = {
    k: 3,
    maxStretch: 0.2,
    maxShared: 0.65,
    basePenalty: 120,
    neighborDepth: 2,
    neighborDecay: 0.5,
    maxTries: 20,
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

    console.time('findDiversePaths');

    const nodePaths = findDiversePaths(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER, altPathConfig);

    console.timeEnd('findDiversePaths');

    console.log(`Found ${nodePaths.length} routes`);

    // Route colors: fastest = yellow, alt1 = orange, alt2 = cyan
    const routeColors = ['yellow', 'orange', 'cyan'];

    for (let pathIdx = 0; pathIdx < nodePaths.length; pathIdx++) {
        const nodePath = nodePaths[pathIdx];
        const routeColor = routeColors[pathIdx] || 'white';

        // Show poly helpers only for the fastest route
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

        // Generate straight path for visualization
        const straightPathResult = findStraightPath(navMesh, start, end, nodePath.path);

        if (straightPathResult.success && straightPathResult.path.length > 0) {
            const path = straightPathResult.path;

            for (let i = 0; i < path.length; i++) {
                const point = path[i];
                // point (smaller for alternatives)
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
                    const prevPoint = path[i - 1];
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
gui.title('Find Diverse Paths Controls');

const pathsFolder = gui.addFolder('Path Finding');
pathsFolder
    .add(altPathConfig, 'k', 1, 10, 1)
    .name('Number of Paths')
    .onChange(() => updatePath());
pathsFolder
    .add(altPathConfig, 'maxStretch', 0.0, 1.0, 0.05)
    .name('Max Stretch (%)')
    .onChange(() => updatePath());
pathsFolder
    .add(altPathConfig, 'maxShared', 0.0, 1.0, 0.05)
    .name('Max Shared (overlap)')
    .onChange(() => updatePath());
pathsFolder.open();

const penaltyFolder = gui.addFolder('Penalty Settings');
penaltyFolder
    .add(altPathConfig, 'basePenalty', 0, 500, 10)
    .name('Base Penalty')
    .onChange(() => updatePath());
penaltyFolder
    .add(altPathConfig, 'neighborDepth', 0, 5, 1)
    .name('Neighbor Depth')
    .onChange(() => updatePath());
penaltyFolder
    .add(altPathConfig, 'neighborDecay', 0.0, 1.0, 0.05)
    .name('Neighbor Decay')
    .onChange(() => updatePath());
penaltyFolder.open();

const advancedFolder = gui.addFolder('Advanced');
advancedFolder
    .add(altPathConfig, 'maxTries', 1, 50, 1)
    .name('Max Tries')
    .onChange(() => updatePath());
advancedFolder.open();

/* initial update */
updatePath();

/* start loop */
function update() {
    requestAnimationFrame(update);
    orbitControls.update();
    renderer.render(scene, camera);
}

update();
