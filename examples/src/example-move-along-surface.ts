import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import { DEFAULT_QUERY_FILTER, findNearestPoly, createFindNearestPolyResult, moveAlongSurface } from 'navcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createNavMeshHelper, createNavMeshPolyHelper } from 'navcat/three';
import { createExample } from './common/example-base';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { getPositionsAndIndices } from 'navcat/three';
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

/* move along surface */
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

function createFlag(color: number): THREE.Group {
    const poleGeom = new THREE.BoxGeometry(0.12, 1.2, 0.12);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const pole = new THREE.Mesh(poleGeom, poleMat);
    pole.position.set(0, 0.6, 0);
    const flagGeom = new THREE.BoxGeometry(0.32, 0.22, 0.04);
    const flagMat = new THREE.MeshStandardMaterial({ color });
    const flag = new THREE.Mesh(flagGeom, flagMat);
    flag.position.set(0.23, 1.0, 0);
    const group = new THREE.Group();
    group.add(pole);
    group.add(flag);
    return group;
}

function updateMoveAlongSurface() {
    clearVisuals();

    const startFlag = createFlag(0x2196f3);
    startFlag.position.set(...start);
    addVisual({
        object: startFlag,
        dispose: () => {
            startFlag.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry?.dispose();
                    if (Array.isArray(child.material)) {
                        child.material.forEach((mat) => {
                            if (mat.dispose) mat.dispose();
                        });
                    } else {
                        child.material?.dispose?.();
                    }
                }
            });
        },
    });

    const endFlag = createFlag(0x00ff00);
    endFlag.position.set(...end);
    addVisual({
        object: endFlag,
        dispose: () => {
            endFlag.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry?.dispose();
                    if (Array.isArray(child.material)) {
                        child.material.forEach((mat) => {
                            if (mat.dispose) mat.dispose();
                        });
                    } else {
                        child.material?.dispose?.();
                    }
                }
            });
        },
    });

    // find nearest polygon to start position
    const startPolyResult = createFindNearestPolyResult();
    findNearestPoly(startPolyResult, navMesh, start, halfExtents, DEFAULT_QUERY_FILTER);

    if (!startPolyResult.success) {
        console.error('Start position not on navmesh');
        return;
    }

    console.time('moveAlongSurface');

    // move along surface
    const result = moveAlongSurface(
        navMesh,
        startPolyResult.nodeRef,
        start,
        end,
        DEFAULT_QUERY_FILTER
    );

    console.timeEnd('moveAlongSurface');

    console.log('moveAlongSurface result:', {
        success: result.success,
        start,
        end,
        resultPos: result.position,
        startNodeRef: startPolyResult.nodeRef,
        resultNodeRef: result.nodeRef,
        visited: result.visited,
        requestedDistance: vec3.distance(start, end),
        actualDistance: vec3.distance(start, result.position),
    });

    // result marker (blue sphere)
    const resultMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.2),
        new THREE.MeshBasicMaterial({ color: 0xff0000 })
    );
    resultMesh.position.set(...result.position);
    addVisual({
        object: resultMesh,
        dispose: () => {
            resultMesh.geometry?.dispose();
            resultMesh.material?.dispose?.();
        },
    });

    // line from start to end (requested - yellow)
    const requestedLineGeom = new THREE.BufferGeometry();
    requestedLineGeom.setFromPoints([
        new THREE.Vector3(...start),
        new THREE.Vector3(...end),
    ]);
    const requestedLine = new THREE.Line(
        requestedLineGeom,
        new THREE.LineBasicMaterial({ color: 0xffff00 })
    );
    addVisual({
        object: requestedLine,
        dispose: () => {
            requestedLine.geometry?.dispose();
            requestedLine.material?.dispose?.();
        },
    });

    // line from start to result (actual - cyan)
    const actualLineGeom = new THREE.BufferGeometry();
    actualLineGeom.setFromPoints([
        new THREE.Vector3(...start),
        new THREE.Vector3(...result.position),
    ]);
    const actualLine = new THREE.Line(
        actualLineGeom,
        new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2 })
    );
    addVisual({
        object: actualLine,
        dispose: () => {
            actualLine.geometry?.dispose();
            actualLine.material?.dispose?.();
        },
    });

    // visualize visited polygons
    for (const polyRef of result.visited) {
        const polyHelper = createNavMeshPolyHelper(navMesh, polyRef);
        polyHelper.object.position.y += 0.3;
        addVisual({
            object: polyHelper.object,
            dispose: () => polyHelper.dispose(),
        });
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
    updateMoveAlongSurface();
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
    updateMoveAlongSurface();
});

renderer.domElement.addEventListener('contextmenu', (event) => {
    event.preventDefault();
});

// Add instructions
const instructions = document.createElement('div');
instructions.style.position = 'absolute';
instructions.style.top = '10px';
instructions.style.left = '10px';
instructions.style.color = 'white';
instructions.style.backgroundColor = 'rgba(0,0,0,0.7)';
instructions.style.padding = '10px';
instructions.style.fontFamily = 'monospace';
instructions.innerHTML = `
<b>Move Along Surface Example</b><br/>
<br/>
<span style="color: #2196f3">Blue flag</span>: Start position (LEFT click to move)<br/>
<span style="color: #00ff00">Green flag</span>: End position (RIGHT click to move)<br/>
<span style="color: #ff0000">Red sphere</span>: Result position<br/>
<br/>
<span style="color: #ffff00">Yellow line</span>: Requested movement<br/>
<span style="color: #00ffff">Cyan line</span>: Actual constrained movement<br/>
`;
container.appendChild(instructions);

// Initial update
updateMoveAlongSurface();

// Render loop
function animate() {
    requestAnimationFrame(animate);
    orbitControls.update();
    renderer.render(scene, camera);
}

animate();
