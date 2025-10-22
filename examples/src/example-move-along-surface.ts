import { type Vec3, vec3 } from 'mathcat';
import { createFindNearestPolyResult, DEFAULT_QUERY_FILTER, findNearestPoly, moveAlongSurface } from 'navcat';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { createNavMeshHelper, createNavMeshLinksHelper, getPositionsAndIndices } from 'navcat/three';
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

const cellSize = 0.1;
const cellHeight = 0.1;

const tileSizeVoxels = 64;
const tileSizeWorld = tileSizeVoxels * cellSize;

const walkableRadiusWorld = 0.2;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 1;
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

const navMeshLinksHelper = createNavMeshLinksHelper(navMesh);
scene.add(navMeshLinksHelper.object);

/* create agent state */
const agentState: {
    position: Vec3;
    input: {
        left: boolean;
        right: boolean;
        up: boolean;
        down: boolean;
    };
} = {
    position: [-3.5, 0.26, 4.71],
    input: {
        left: false,
        right: false,
        up: false,
        down: false,
    },
};

/* create agent mesh */
const agentMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.6), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
agentMesh.geometry.translate(0, 0.3, 0);

scene.add(agentMesh);

/* create keyboard input listeners */
window.addEventListener('keydown', (e) => {
    switch (e.key) {
        case 'a':
            agentState.input.left = true;
            break;
        case 'd':
            agentState.input.right = true;
            break;
        case 'w':
            agentState.input.up = true;
            break;
        case 's':
            agentState.input.down = true;
            break;
    }
});

window.addEventListener('keyup', (e) => {
    switch (e.key) {
        case 'a':
            agentState.input.left = false;
            break;
        case 'd':
            agentState.input.right = false;
            break;
        case 'w':
            agentState.input.up = false;
            break;
        case 's':
            agentState.input.down = false;
            break;
    }
});

/* loop */
let time = performance.now();

function updateAgentMovement(deltaTime: number) {
    // get move request from input
    const moveRequest: Vec3 = [0, 0, 0];

    if (agentState.input.up) {
        moveRequest[2] -= 1;
    }
    if (agentState.input.down) {
        moveRequest[2] += 1;
    }
    if (agentState.input.left) {
        moveRequest[0] -= 1;
    }
    if (agentState.input.right) {
        moveRequest[0] += 1;
    }

    vec3.normalize(moveRequest, moveRequest);
    vec3.scale(moveRequest, moveRequest, deltaTime * 5);

    // find start node
    const nearestPolyResult = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        agentState.position,
        [0.5, 0.5, 0.5],
        DEFAULT_QUERY_FILTER,
    );

    if (!nearestPolyResult.success) return;

    // get move target position
    const moveRequestTarget = vec3.add(vec3.create(), nearestPolyResult.point, moveRequest);

    if (vec3.length(moveRequest) <= 0) return;

    // move along surface
    const moveAlongSurfaceResult = moveAlongSurface(
        navMesh,
        nearestPolyResult.ref,
        nearestPolyResult.point,
        moveRequestTarget,
        DEFAULT_QUERY_FILTER,
    );

    if (!moveAlongSurfaceResult.success) return;

    vec3.copy(agentState.position, moveAlongSurfaceResult.resultPosition);
}

const MAX_DT = 0.1;

function update() {
    requestAnimationFrame(update);

    const now = performance.now();
    const deltaTime = Math.min((now - time) / 1000, MAX_DT);
    time = now;

    updateAgentMovement(deltaTime);

    agentMesh.position.fromArray(agentState.position);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
