import { type Vec3, vec3 } from 'maaths';
import { createFindNearestPolyResult, DEFAULT_QUERY_FILTER, findNearestPoly, raycast } from 'navcat';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
import { createNavMeshHelper, createNavMeshPolyHelper } from './common/debug';
import { createExample } from './common/example-base';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from './common/generate-tiled-nav-mesh';
import { getPositionsAndIndices } from './common/get-positions-and-indices';
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

// state for raycast start/end (with defaults)
let raycastStart: Vec3 | null = [-0.8, 0.27, 5.1];
let raycastEnd: Vec3 | null = [0.53, 0.26, 3.59];
type Visual = { object: THREE.Object3D; dispose: () => void };
let visuals: Visual[] = [];

// initial raycast with defaults
performRaycast();

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

function performRaycast() {
    clearVisuals();
    if (!raycastStart || !raycastEnd) return;

    const raycastStartNearestPoly = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        raycastStart,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER,
    );

    if (!raycastStartNearestPoly.success) return;

    const raycastResult = raycast(
        navMesh,
        raycastStartNearestPoly.nearestPolyRef,
        raycastStart,
        raycastEnd,
        DEFAULT_QUERY_FILTER,
    );

    const reachedEnd = raycastResult.t > 0.99;

    // visualize the raycast start position (green, larger)
    const rayStartMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 20, 20),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('green') }),
    );
    rayStartMesh.position.fromArray(raycastStart);
    rayStartMesh.position.y += 0.5;
    addVisual({
        object: rayStartMesh,
        dispose: () => {
            rayStartMesh.geometry?.dispose();
            rayStartMesh.material?.dispose?.();
        },
    });

    // visualize the raycast end position (blue, smaller)
    const rayEndMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('blue') }),
    );
    rayEndMesh.position.fromArray(raycastEnd);
    rayEndMesh.position.y += 0.5;
    addVisual({
        object: rayEndMesh,
        dispose: () => {
            rayEndMesh.geometry?.dispose();
            rayEndMesh.material?.dispose?.();
        },
    });

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
        new THREE.MeshBasicMaterial({ color: new THREE.Color(reachedEnd ? 'green' : 'red') }),
    );
    hitMesh.position.fromArray(hitPos);
    hitMesh.position.y += 0.5;
    addVisual({
        object: hitMesh,
        dispose: () => {
            hitMesh.geometry?.dispose();
            hitMesh.material?.dispose?.();
        },
    });

    // visualize the raycast as two arrows: green (start to hit), red (hit to end if hit occurs before end)
    const startVec = new THREE.Vector3(...raycastStart);
    const hitVec = new THREE.Vector3(...hitPos);
    const endVec = new THREE.Vector3(...raycastEnd);
    const toHit = new THREE.Vector3().subVectors(hitVec, startVec);
    const toEnd = new THREE.Vector3().subVectors(endVec, hitVec);
    const toHitLen = toHit.length();
    const toEndLen = toEnd.length();
    if (toHitLen > 0.01) {
        const arrowGreen = new THREE.ArrowHelper(
            toHit.clone().normalize(),
            startVec.clone().setY(startVec.y + 0.5),
            toHitLen,
            0x00ff00,
            0.18,
            0.09,
        );
        addVisual({
            object: arrowGreen,
            dispose: () => {
                arrowGreen.dispose();
            },
        });
    }

    // only draw the red arrow if the hit is before the end
    if (!reachedEnd && toEndLen > 0.01) {
        const arrowRed = new THREE.ArrowHelper(
            toEnd.clone().normalize(),
            hitVec.clone().setY(hitVec.y + 0.5),
            toEndLen,
            0xff0000,
            0.18,
            0.09,
        );
        addVisual({
            object: arrowRed,
            dispose: () => {
                arrowRed.dispose();
            },
        });
    }

    // visualize hit normal if we hit a wall
    if (raycastResult.t < Number.MAX_VALUE && vec3.length(raycastResult.hitNormal) > 0) {
        const normalEnd = vec3.create();
        vec3.scaleAndAdd(normalEnd, hitPos, raycastResult.hitNormal, 0.5);

        const normalLineGeometry = new LineGeometry();
        normalLineGeometry.setFromPoints([new THREE.Vector3(...hitPos), new THREE.Vector3(...normalEnd)]);
        const normalLineMaterial = new Line2NodeMaterial({
            color: 'yellow',
            linewidth: 0.08,
            worldUnits: true,
        });
        const normalLine = new Line2(normalLineGeometry, normalLineMaterial);
        normalLine.position.y += 0.5;
        addVisual({
            object: normalLine,
            dispose: () => {
                normalLine.geometry?.dispose();
                normalLine.material?.dispose?.();
            },
        });
    }

    // visualize the visited polygons from raycast
    for (let i = 0; i < raycastResult.path.length; i++) {
        const poly = raycastResult.path[i];
        const hslColor = new THREE.Color().setHSL(0.8, 0.9, 0.4 + (i / raycastResult.path.length) * 0.3);
        const polyHelper = createNavMeshPolyHelper(navMesh, poly, hslColor.toArray() as [number, number, number]);
        polyHelper.object.position.y += 0.35;
        addVisual(polyHelper);
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

renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    const point = getPointOnNavMesh(event);
    if (!point) return;
    if (event.button === 0) {
        // left click: set start
        raycastStart = point;
    } else if (event.button === 2) {
        // right click: set end
        raycastEnd = point;
    }
    performRaycast();
});

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
