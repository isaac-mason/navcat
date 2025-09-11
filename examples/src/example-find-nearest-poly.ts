import type { Vec3 } from 'maaths';
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    three as threeUtils,
} from 'navcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createExample } from './common/example-base';
import {
    generateTiledNavMesh,
    type TiledNavMeshInput,
    type TiledNavMeshOptions,
} from './common/generate-tiled-nav-mesh';
import { loadGLTF } from './common/load-gltf';

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const navTestModel = await loadGLTF('/models/nav-test.glb');
scene.add(navTestModel.scene);

/* generate navmesh */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = threeUtils.getPositionsAndIndices(walkableMeshes);

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
const detailSampleDistance = 6;
const detailSampleMaxError = 1;

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

const navMeshHelper = threeUtils.createNavMeshHelper(navMesh);
scene.add(navMeshHelper.object);

/* find nearest poly logic */
const queryMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x0000ff }),
);
scene.add(queryMesh);

const pointMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xff0000 }),
);
scene.add(pointMesh);

const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    pointMesh.position,
    1,
    0xffff00,
    0.2,
);
scene.add(arrow);

const updateNearestPoly = (point: Vec3) => {
    queryMesh.position.fromArray(point);

    const nearestPoly = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        point,
        [0.5, 0.5, 0.5],
        DEFAULT_QUERY_FILTER,
    );

    if (!nearestPoly.success) return;

    pointMesh.position.fromArray(nearestPoly.nearestPoint);

    arrow.setDirection(new THREE.Vector3(0, -1, 0));
    arrow.position.copy(pointMesh.position);
    arrow.position.y += 1.5;

    const nearestPolyElement = document.getElementById('nearest-poly')!;
    nearestPolyElement.textContent = nearestPoly.nearestPolyRef;
};

updateNearestPoly([-3.94, 0.26, 4.71]);

/* handle pointer down events */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const onPointerDown = (event: PointerEvent) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    const intersects = raycaster.intersectObjects(walkableMeshes);
    if (intersects.length > 0) {
        const point = intersects[0].point;
        updateNearestPoly([point.x, point.y, point.z]);
    }
};

window.addEventListener('pointerdown', onPointerDown);

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
