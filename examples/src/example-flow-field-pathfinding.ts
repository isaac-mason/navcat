import type { Vec3 } from 'maaths';
import type { NavMesh, NodeRef } from 'navcat';
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findStraightPath,
    getNodeByRef,
    getNodeRefType,
    NodeType,
} from 'navcat';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
import { createNavMeshHelper, createNavMeshPolyHelper, type DebugObject } from './common/debug';
import { createExample } from './common/example-base';
import { computeUniformCostFlowField, type FlowField, getNodePathFromFlowField } from './common/flow-field';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { getPositionsAndIndices } from './common/get-positions-and-indices';
import { loadGLTF } from './common/load-gltf';

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const navTestModel = await loadGLTF('/models/nav-test.glb');
scene.add(navTestModel.scene);

/* navmesh generation */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = getPositionsAndIndices(walkableMeshes);

const cellSize = 0.15;
const cellHeight = 0.15;
const tileSizeVoxels = 32;
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


const navMeshInput: TiledNavMeshInput = {
    positions,
    indices,
};

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

/* flow field structures */
let flowField: FlowField | null = null;
let flowFieldTargetPosition: Vec3 | null = null;
let pathfindingStartPosition: Vec3 | null = null;
const maxIterations = 1000;

/* initial positions */
const initialFlowFieldOrigin: Vec3 = [-3.94, 0.26, 4.71];
const initialPathfindingStart: Vec3 = [2.52, 2.39, -2.2];

/* interaction */
let interactionMode: 'idle' | 'moving-flow-field' | 'moving-path' = 'idle';

const getMousePosition = (event: PointerEvent): Vec3 | null => {
    const mouse = new THREE.Vector2();
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObject(navTestModel.scene, true);
    if (intersects.length === 0) return null;

    const point = intersects[0].point;
    return [point.x, point.y, point.z];
}

const updateFlowField = (position: Vec3) => {
    if (!navMesh) return;

    const result = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        position,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER,
    );

    if (!result.success) return;

    flowFieldTargetPosition = result.point;

    showFlagAt(result.point);

    console.time('computeFlowField');
    flowField = computeUniformCostFlowField(navMesh, result.ref, DEFAULT_QUERY_FILTER, maxIterations);
    console.timeEnd('computeFlowField');

    showFlowFieldArrows(navMesh, flowField);

    // Recompute path if we have a pathfinding start position
    if (pathfindingStartPosition) {
        updatePath(pathfindingStartPosition);
    } else {
        clearPathHelpers();
    }
}

// Helper: Update pathfinding target
function updatePath(position: Vec3) {
    if (!navMesh || !flowField || !flowFieldTargetPosition) return;

    const result = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        position,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER,
    );

    if (!result.success) return;

    // Save pathfinding start position
    pathfindingStartPosition = result.point;

    const endResult = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        flowFieldTargetPosition,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER,
    );
    const endPt = endResult?.success ? endResult.point : null;

    console.time('getNodePathFromFlowField');
    const polyPath = getNodePathFromFlowField(flowField, result.ref);
    console.timeEnd('getNodePathFromFlowField');

    if (polyPath && endPt) {
        const straightPathResult = findStraightPath(navMesh, result.point, endPt, polyPath);

        showPath(
            polyPath,
            straightPathResult.path.map((p) => p.position),
        );
    } else {
        clearPathHelpers();
    }
}

renderer.domElement.addEventListener('pointerdown', (event) => {
    event.preventDefault();

    const position = getMousePosition(event);
    if (!position) return;

    if (event.button === 0) {
        if (interactionMode === 'moving-flow-field') {
            interactionMode = 'idle';
        } else {
            interactionMode = 'moving-flow-field';
        }
    } else if (event.button === 2) {
        if (interactionMode === 'moving-path') {
            interactionMode = 'idle';
        } else {
            interactionMode = 'moving-path';
        }
    }
});

renderer.domElement.addEventListener('pointermove', (event) => {
    if (interactionMode === 'moving-flow-field') {
        const position = getMousePosition(event);
        if (position) {
            updateFlowField(position);
        }
    } else if (interactionMode === 'moving-path') {
        const position = getMousePosition(event);
        if (position) {
            updatePath(position);
        }
    }
});

const flagGroup = (() => {
    // pole
    const poleGeom = new THREE.BoxGeometry(0.12, 1.2, 0.12);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const pole = new THREE.Mesh(poleGeom, poleMat);
    pole.position.set(0, 0.6, 0);

    // Bigger flag
    const flagGeom = new THREE.BoxGeometry(0.32, 0.22, 0.04);
    const flagMat = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const flag = new THREE.Mesh(flagGeom, flagMat);
    flag.position.set(0.23, 1.0, 0);

    // group
    const group = new THREE.Group();
    group.add(pole);
    group.add(flag);
    group.visible = false;

    return group;
})();

scene.add(flagGroup);

function showFlagAt(position: [number, number, number] | null) {
    if (position) {
        flagGroup.position.set(position[0], position[1], position[2]);
        flagGroup.visible = true;
    } else {
        flagGroup.visible = false;
    }
}

const flowFieldHelpers: DebugObject[] = [];
const arrowHelpers: THREE.ArrowHelper[] = [];
const pathHelpers: DebugObject[] = [];

function getPolyCenter(navMesh: NavMesh, nodeRef: NodeRef): [number, number, number] | null {
    const type = getNodeRefType(nodeRef);
    if (type !== NodeType.POLY) return null;

    const { tileId, polyIndex } = getNodeByRef(navMesh, nodeRef);

    const tile = navMesh.tiles[tileId];
    if (!tile) return null;

    const poly = tile.polys[polyIndex];
    if (!poly) return null;

    const sum = [0, 0, 0];
    for (let i = 0; i < poly.vertices.length; i++) {
        const vi = poly.vertices[i] * 3;
        sum[0] += tile.vertices[vi];
        sum[1] += tile.vertices[vi + 1];
        sum[2] += tile.vertices[vi + 2];
    }

    const n = poly.vertices.length;

    return [sum[0] / n, sum[1] / n, sum[2] / n];
}

function clearPolyHelpers() {
    for (const helper of flowFieldHelpers) {
        scene.remove(helper.object);
        helper.dispose();
    }
    flowFieldHelpers.length = 0;
}

function clearArrowHelpers() {
    for (const obj of arrowHelpers) {
        scene.remove(obj);
        obj.dispose();
    }
    arrowHelpers.length = 0;
}

function clearPathHelpers() {
    for (const helper of pathHelpers) {
        helper.dispose();
    }
    pathHelpers.length = 0;
}

function showFlowFieldArrows(navMesh: NavMesh, flowField: FlowField) {
    clearArrowHelpers();
    clearPolyHelpers();

    // Compute min/max cost for color mapping
    let minCost = Infinity,
        maxCost = -Infinity;
    for (const cost of flowField.cost.values()) {
        if (cost < minCost) minCost = cost;
        if (cost > maxCost) maxCost = cost;
    }
    // Avoid division by zero
    if (minCost === maxCost) maxCost = minCost + 1;

    // Add colored poly helpers
    for (const [polyRef, cost] of flowField.cost.entries()) {
        const t = (cost - minCost) / (maxCost - minCost);
        // Red (far) to Blue (close): interpolate from (1,0,0) to (0,0,1)
        const r = 1 - t;
        const g = 0;
        const b = t;
        const color = new THREE.Color(r, g, b);
        const polyHelper = createNavMeshPolyHelper(navMesh, polyRef, [color.r, color.g, color.b]);
        polyHelper.object.position.y += 0.15;
        flowFieldHelpers.push(polyHelper);
        scene.add(polyHelper.object);
    }

    // Show arrows for direction
    for (const [polyRef, nextRef] of flowField.next.entries()) {
        if (!nextRef) continue;
        const centerA = getPolyCenter(navMesh, polyRef);
        const centerB = getPolyCenter(navMesh, nextRef);
        if (!centerA || !centerB) continue;
        const dir = new THREE.Vector3(centerB[0] - centerA[0], centerB[1] - centerA[1], centerB[2] - centerA[2]);
        const length = dir.length();
        if (length < 0.01) continue;
        dir.normalize();
        const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(...centerA), Math.max(length * 0.7, 0.3), 0xffffff, 0.2, 0.1);
        arrow.position.y += 0.3;
        arrowHelpers.push(arrow);
        scene.add(arrow);
    }
}

function showPath(pathPolys: NodeRef[], pathPoints: number[][]) {
    clearPathHelpers();

    // poly helpers
    for (const polyRef of pathPolys) {
        const polyHelper = createNavMeshPolyHelper(navMesh!, polyRef, [1, 0.7, 0.2]);
        polyHelper.object.position.y += 0.15;
        pathHelpers.push({
            object: polyHelper.object,
            dispose: () => {
                polyHelper.object.removeFromParent();
                polyHelper.dispose();
            },
        });

        scene.add(polyHelper.object);
    }

    // spheres and lines
    for (let i = 0; i < pathPoints.length; i++) {
        const pt = pathPoints[i];
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.15), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
        mesh.position.set(pt[0], pt[1] + 0.3, pt[2]);

        pathHelpers.push({
            object: mesh,
            dispose: () => {
                mesh.removeFromParent();
                mesh.geometry.dispose();
                mesh.material.dispose();
            },
        });

        scene.add(mesh);

        if (i > 0) {
            const prev = pathPoints[i - 1];

            const start = new THREE.Vector3(prev[0], prev[1] + 0.3, prev[2]);
            const end = new THREE.Vector3(pt[0], pt[1] + 0.3, pt[2]);

            const geometry = new LineGeometry();
            geometry.setFromPoints([start, end]);

            const material = new Line2NodeMaterial({
                color: 'yellow',
                linewidth: 0.1,
                worldUnits: true,
            });

            const line = new Line2(geometry, material);

            pathHelpers.push({
                object: line,
                dispose: () => {
                    line.removeFromParent();
                    geometry.dispose();
                    material.dispose();
                },
            });

            scene.add(line);
        }
    }
}

/* initialize with default positions */
updateFlowField(initialFlowFieldOrigin);
updatePath(initialPathfindingStart);

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
