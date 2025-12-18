import GUI from 'lil-gui';
import type { Vec3 } from 'mathcat';
import { createFindNearestPolyResult, DEFAULT_QUERY_FILTER, findNearestPoly, findRandomPointAroundCircle } from 'navcat';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { createNavMeshHelper, getPositionsAndIndices } from 'navcat/three';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createExample } from './common/example-base';
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

/* find random point logic */
const pointsMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const pointGeometry = new THREE.SphereGeometry(0.05, 8, 8);
const pointMeshes: THREE.Mesh[] = [];

const MAX_POINTS = 500;
for (let i = 0; i < MAX_POINTS; i++) {
    const pointMesh = new THREE.Mesh(pointGeometry, pointsMaterial);
    pointMesh.visible = false;
    scene.add(pointMesh);
    pointMeshes.push(pointMesh);
}

const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 1, 0xffff00, 0.2);
scene.add(arrow);

const params = {
    radius: 1.0,
    numPoints: 100,
};

const updateRandomPoints = (point: Vec3) => {
    const nearestPoly = findNearestPoly(createFindNearestPolyResult(), navMesh, point, [0.5, 0.5, 0.5], DEFAULT_QUERY_FILTER);

    if (!nearestPoly.success) return;

    const startRef = nearestPoly.nodeRef;
    const startPosition = nearestPoly.position;

    arrow.setDirection(new THREE.Vector3(0, -1, 0));
    arrow.position.fromArray(startPosition);
    arrow.position.y += 1.5;

    // Hide all points first
    for (let i = 0; i < pointMeshes.length; i++) {
        pointMeshes[i].visible = false;
    }

    // Generate only the requested number of points
    for (let i = 0; i < params.numPoints; i++) {
        const result = findRandomPointAroundCircle(
            navMesh,
            startRef,
            startPosition,
            params.radius,
            DEFAULT_QUERY_FILTER,
            Math.random,
        );

        if (result.success) {
            pointMeshes[i].position.fromArray(result.position);
            pointMeshes[i].visible = true;
        }
    }
};

updateRandomPoints([-3.94, 0.26, 4.71]);

/* gui */
const gui = new GUI();

const randomPointFolder = gui.addFolder('Random Points');
randomPointFolder
    .add(params, 'radius', 0.1, 10.0)
    .name('Radius')
    .onChange((value: number) => {
        params.radius = value;
    });
randomPointFolder
    .add(params, 'numPoints', 1, MAX_POINTS, 1)
    .name('Number of Points')
    .onChange((value: number) => {
        params.numPoints = Math.floor(value);
    });

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
        updateRandomPoints([point.x, point.y, point.z]);
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
