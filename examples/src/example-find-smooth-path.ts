import GUI from 'lil-gui';
import type { Vec3 } from 'maaths';
import { DEFAULT_QUERY_FILTER, findSmoothPath, getNodeRefType, NodeType } from 'navcat';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
import { createNavMeshHelper, createNavMeshPolyHelper, createSearchNodesHelper } from './common/debug';
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

/* find smooth path */
let start: Vec3 = [-3.94, 0.26, 4.71];
let end: Vec3 = [1.01, 2.38, -1.93];
const halfExtents: Vec3 = [1, 1, 1];
let stepSize = 1;
let slop = 0.01;

/* controls */
const gui = new GUI();
const guiParams = { stepSize, slop };
const pathFolder = gui.addFolder('Smooth Path');
pathFolder
    .add(guiParams, 'stepSize', 0.1, 2, 0.1)
    .name('Step Size')
    .onChange((v: number) => {
        stepSize = v;
        updatePath();
    });
pathFolder
    .add(guiParams, 'slop', 0.01, 0.2, 0.02)
    .name('Slop')
    .onChange((v: number) => {
        slop = v;
        updatePath();
    });
pathFolder.open();

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

function updatePath() {
    clearVisuals();

    const startFlag = createFlag(0x2196f3);
    startFlag.position.set(...start);
    addVisual({
        object: startFlag,
        dispose: () => {
            startFlag.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry?.dispose();
                    child.material?.dispose?.();
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
                    child.material?.dispose?.();
                }
            });
        },
    });

    console.time('findSmoothPath');
    const pathResult = findSmoothPath(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER, stepSize, slop, 1024);
    console.timeEnd('findSmoothPath');

    console.log('pathResult', pathResult);

    if (pathResult.success) {
        const { path, nodePath } = pathResult;
        if (nodePath) {
            const searchNodesHelper = createSearchNodesHelper(nodePath.nodes);
            addVisual(searchNodesHelper);

            for (let i = 0; i < nodePath.path.length; i++) {
                const node = nodePath.path[i];
                if (getNodeRefType(node) === NodeType.POLY) {
                    const polyHelper = createNavMeshPolyHelper(navMesh, node);
                    polyHelper.object.position.y += 0.15;
                    addVisual(polyHelper);
                }
            }
        }
        if (path) {
            for (let i = 0; i < path.length; i++) {
                const point = path[i];

                const hue = (i / path.length) * 360;
                const colorHSL = `hsl(${hue}, 90%, 50%)`;
                const colorThree = new THREE.Color(colorHSL);

                const sphereGeom = new THREE.SphereGeometry(0.1, 12, 12);
                const sphereMat = new THREE.MeshBasicMaterial({ color: colorThree });
                const sphere = new THREE.Mesh(sphereGeom, sphereMat);
                sphere.position.set(...point.position);
                sphere.position.y += 0.2;

                addVisual({
                    object: sphere,
                    dispose: () => {
                        sphere.geometry?.dispose();
                        sphere.material?.dispose?.();
                    },
                });

                if (i > 0) {
                    const prevPoint = path[i - 1];

                    const geometry = new LineGeometry();
                    const start = new THREE.Vector3(...prevPoint.position);
                    const end = new THREE.Vector3(...point.position);

                    start.y += 0.2;
                    end.y += 0.2;

                    geometry.setFromPoints([start, end]);

                    const material = new Line2NodeMaterial({
                        color: colorThree,
                        linewidth: 0.1,
                        worldUnits: true,
                    });

                    const line = new Line2(geometry, material);

                    addVisual({
                        object: line,
                        dispose: () => {
                            line.geometry?.dispose();
                            line.material?.dispose?.();
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

/* initial update */
updatePath();

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
