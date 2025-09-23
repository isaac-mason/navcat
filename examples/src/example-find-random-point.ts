import GUI from 'lil-gui';
import { DEFAULT_QUERY_FILTER, findRandomPoint } from 'navcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createNavMeshHelper } from './common/debug';
import { createExample } from './common/example-base';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from './common/generate-tiled-nav-mesh';
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

const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

/* find random point logic */
const pointMesh = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 16), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
scene.add(pointMesh);

const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), pointMesh.position, 1, 0xffff00, 0.2);
scene.add(arrow);

const updateRandomPoint = () => {
    const result = findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, Math.random);

    if (result.success) {
        pointMesh.position.fromArray(result.position);

        arrow.setDirection(new THREE.Vector3(0, -1, 0));
        arrow.position.copy(pointMesh.position);
        arrow.position.y += 1.5;
    }
};

updateRandomPoint();

/* gui */
const gui = new GUI();

const randomPointFolder = gui.addFolder('Random Point');
randomPointFolder.add({ run: updateRandomPoint }, 'run').name('Find Random Point');

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
