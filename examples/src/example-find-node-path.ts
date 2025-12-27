import type { Vec3 } from 'mathcat';
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findNodePath,
    getNodeRefType,
    NodeType,
} from 'navcat';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { createNavMeshHelper, createNavMeshPolyHelper, createSearchNodesHelper, getPositionsAndIndices } from 'navcat/three';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createExample } from './common/example-base';
import { createFlag } from './common/flag';
import { loadGLTF } from './common/load-gltf';

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

/* find node path */
let start: Vec3 = [-3.94, 0.26, 4.71];
let end: Vec3 = [2.52, 2.39, -2.2];
const halfExtents: Vec3 = [1, 1, 1];

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

    /* find nearest polys for start and end */
    const startNearestPolyResult = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        start,
        halfExtents,
        DEFAULT_QUERY_FILTER,
    );
    if (!startNearestPolyResult.success) {
        console.error('Failed to find start poly');
        return;
    }

    const endNearestPolyResult = findNearestPoly(createFindNearestPolyResult(), navMesh, end, halfExtents, DEFAULT_QUERY_FILTER);
    if (!endNearestPolyResult.success) {
        console.error('Failed to find end poly');
        return;
    }

    console.time('findNodePath');

    const pathResult = findNodePath(
        navMesh,
        startNearestPolyResult.nodeRef,
        endNearestPolyResult.nodeRef,
        startNearestPolyResult.position,
        endNearestPolyResult.position,
        DEFAULT_QUERY_FILTER,
    );

    console.timeEnd('findNodePath');

    console.log('pathResult', pathResult);

    /* visualize search nodes */
    if (pathResult.nodes) {
        const searchNodesHelper = createSearchNodesHelper(pathResult.nodes);
        addVisual(searchNodesHelper);
    }

    /* visualize node path polygons */
    if (pathResult.path && pathResult.path.length > 0) {
        for (let i = 0; i < pathResult.path.length; i++) {
            const nodeRef = pathResult.path[i];
            if (getNodeRefType(nodeRef) === NodeType.POLY) {
                const polyHelper = createNavMeshPolyHelper(navMesh, nodeRef);
                polyHelper.object.position.y += 0.15;
                addVisual(polyHelper);
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

/* initial update */
updatePath();

/* start loop */
function update() {
    requestAnimationFrame(update);
    orbitControls.update();
    renderer.render(scene, camera);
}

update();
