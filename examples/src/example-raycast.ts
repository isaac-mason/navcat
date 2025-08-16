import { type Vec3, vec3 } from 'maaths';
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    raycast,
    three as threeUtils,
} from 'nav3d';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
import { createExample } from './common/example-boilerplate';
import {
    generateTiledNavMesh,
    type TiledNavMeshInput,
    type TiledNavMeshOptions,
} from './common/generate-tiled-nav-mesh';
import { loadGLTF } from './common/load-gltf';

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

orbitControls.target.set(0, 0, 4);
camera.position.set(0, 5, 8);

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
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

/* raycast */
const raycastStart: Vec3 = [-0.63, 0.27, 4.9];
const raycastEnd: Vec3 = [0.53, 0.26, 3.59];

const raycastStartNearestPoly = findNearestPoly(
    createFindNearestPolyResult(),
    navMesh,
    raycastStart,
    [1, 1, 1],
    DEFAULT_QUERY_FILTER,
);

if (raycastStartNearestPoly.success) {
    const raycastResult = raycast(
        navMesh,
        raycastStartNearestPoly.nearestPolyRef,
        raycastStart,
        raycastEnd,
        DEFAULT_QUERY_FILTER,
    );

    // visualize the raycast start position
    const rayStartMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('orange') }),
    );
    rayStartMesh.position.fromArray(raycastStart);
    rayStartMesh.position.y += 0.5;
    scene.add(rayStartMesh);

    // visualize the raycast target end position
    const rayTargetMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('purple') }),
    );
    rayTargetMesh.position.fromArray(raycastEnd);
    rayTargetMesh.position.y += 0.5;
    scene.add(rayTargetMesh);

    // calculate hit position
    let hitPos: Vec3;
    if (raycastResult.t === Number.MAX_VALUE) {
        // ray reached the end without hitting a wall
        hitPos = raycastEnd;
    } else {
        // ray hit a wall at parameter t
        hitPos = vec3.create();
        vec3.lerp(hitPos, raycastStart, raycastEnd, raycastResult.t);
    }

    // visualize the hit position
    const hitMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('blue') }),
    );
    hitMesh.position.fromArray(hitPos);
    hitMesh.position.y += 0.5;
    scene.add(hitMesh);

    // visualize the raycast path
    const rayLineGeometry = new LineGeometry();
    rayLineGeometry.setFromPoints([
        new THREE.Vector3(...raycastStart),
        new THREE.Vector3(...hitPos),
    ]);
    const rayLineMaterial = new Line2NodeMaterial({
        color: 'magenta',
        linewidth: 0.12,
        worldUnits: true,
    });
    const rayLine = new Line2(rayLineGeometry, rayLineMaterial);
    rayLine.position.y += 0.5;
    scene.add(rayLine);

    // visualize the intended ray direction (dashed line if hit a wall)
    if (raycastResult.t < Number.MAX_VALUE) {
        const intendedRayLineGeometry = new LineGeometry();
        intendedRayLineGeometry.setFromPoints([
            new THREE.Vector3(...raycastStart),
            new THREE.Vector3(...raycastEnd),
        ]);
        const intendedRayLineMaterial = new Line2NodeMaterial({
            color: 'purple',
            linewidth: 0.08,
            worldUnits: true,
            dashed: true,
            dashSize: 0.1,
            gapSize: 0.05,
        });
        const intendedRayLine = new Line2(
            intendedRayLineGeometry,
            intendedRayLineMaterial,
        );
        intendedRayLine.position.y += 0.5;
        scene.add(intendedRayLine);
    }

    // visualize hit normal if we hit a wall
    if (
        raycastResult.t < Number.MAX_VALUE &&
        vec3.length(raycastResult.hitNormal) > 0
    ) {
        const normalEnd = vec3.create();
        vec3.scaleAndAdd(normalEnd, hitPos, raycastResult.hitNormal, 0.5);

        const normalLineGeometry = new LineGeometry();
        normalLineGeometry.setFromPoints([
            new THREE.Vector3(...hitPos),
            new THREE.Vector3(...normalEnd),
        ]);
        const normalLineMaterial = new Line2NodeMaterial({
            color: 'yellow',
            linewidth: 0.08,
            worldUnits: true,
        });
        const normalLine = new Line2(normalLineGeometry, normalLineMaterial);
        normalLine.position.y += 0.5;
        scene.add(normalLine);
    }

    // visualize the visited polygons from raycast
    for (let i = 0; i < raycastResult.path.length; i++) {
        const poly = raycastResult.path[i];
        const hslColor = new THREE.Color().setHSL(
            0.8,
            0.9,
            0.4 + (i / raycastResult.path.length) * 0.3,
        );
        const polyHelper = threeUtils.createNavMeshPolyHelper(
            navMesh,
            poly,
            hslColor.toArray() as [number, number, number],
        );
        polyHelper.object.position.y += 0.35;
        scene.add(polyHelper.object);
    }
}

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
