import type { Vec3 } from 'maaths';
import {
    DEFAULT_QUERY_FILTER,
    findSmoothPath,
    getNodeRefType,
    NodeType,
    three as threeUtils,
} from 'navcat';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
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
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

/* find smooth path */
let start: Vec3 = [-3.94, 0.26, 4.71];
let end: Vec3 = [1.01, 2.38, -1.93];
const halfExtents: Vec3 = [1, 1, 1];
const stepSize = 1;
const slop = 0.01;

let visuals: THREE.Object3D[] = [];

function clearVisuals() {
    for (const obj of visuals) scene.remove(obj);
    // obj.
    visuals = [];
}

function addVisual(obj: THREE.Object3D) {
    visuals.push(obj);
    scene.add(obj);
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
    addVisual(startFlag);

    const endFlag = createFlag(0x00ff00);
    endFlag.position.set(...end);
    addVisual(endFlag);

    console.time('findSmoothPath');
    const pathResult = findSmoothPath(
        navMesh,
        start,
        end,
        halfExtents,
        DEFAULT_QUERY_FILTER,
        stepSize,
        slop,
        1024,
    );
    console.timeEnd('findSmoothPath');

    console.log('pathResult', pathResult);

    if (pathResult.success) {
        const { path, nodePath } = pathResult;
        if (nodePath) {
            if (nodePath.intermediates?.nodes) {
                const searchNodesHelper = threeUtils.createSearchNodesHelper(
                    nodePath.intermediates.nodes,
                );
                addVisual(searchNodesHelper.object);
            }
            for (let i = 0; i < nodePath.path.length; i++) {
                const node = nodePath.path[i];
                if (getNodeRefType(node) === NodeType.GROUND_POLY) {
                    const polyHelper = threeUtils.createNavMeshPolyHelper(
                        navMesh,
                        node,
                    );
                    polyHelper.object.position.y += 0.15;
                    addVisual(polyHelper.object);
                }
            }
        }
        if (path) {
            for (let i = 0; i < path.length; i++) {
                const point = path[i];
                // Assign a unique HSL color for this point
                const hue = (i / path.length) * 360;
                const colorHSL = `hsl(${hue}, 90%, 50%)`;
                const colorThree = new THREE.Color(colorHSL);

                // Draw green dot and line for END type
                if (point.pointType === 3 /* SmoothPathPointType.END */) {
                    // Green dot
                    const mesh = new THREE.Mesh(
                        new THREE.SphereGeometry(0.22),
                        new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
                    );
                    mesh.position.set(...point.position);
                    addVisual(mesh);
                    // Green line from previous point (always draw if there is a previous point)
                    if (i > 0) {
                        const prevPoint = path[i - 1];
                        const geometry = new LineGeometry();
                        const start = new THREE.Vector3(...prevPoint.position);
                        start.y += 0.2;
                        const end = new THREE.Vector3(...point.position);
                        end.y += 0.2;
                        geometry.setFromPoints([start, end]);
                        const material = new Line2NodeMaterial({
                            color: 'green',
                            linewidth: 0.13,
                            worldUnits: true,
                        });
                        const line = new Line2(geometry, material);
                        addVisual(line);
                    }
                } else {
                    // HSL colored dot
                    const mesh = new THREE.Mesh(
                        new THREE.SphereGeometry(0.2),
                        new THREE.MeshBasicMaterial({ color: colorThree }),
                    );
                    mesh.position.set(...point.position);
                    addVisual(mesh);
                }

                // Visualize moveAlongSurfaceTarget if present
                if (point.moveAlongSurfaceTarget) {
                    // Draw a line from position to moveAlongSurfaceTarget in this point's color
                    const moveTargetGeometry = new LineGeometry();
                    const start = new THREE.Vector3(...point.position);
                    start.y += 0.2;
                    const end = new THREE.Vector3(...point.moveAlongSurfaceTarget);
                    end.y += 0.2;
                    moveTargetGeometry.setFromPoints([start, end]);
                    const moveTargetMaterial = new Line2NodeMaterial({
                        color: colorThree,
                        linewidth: 0.08,
                        worldUnits: true,
                    });
                    const moveTargetLine = new Line2(moveTargetGeometry, moveTargetMaterial);
                    addVisual(moveTargetLine);

                    // Draw a small sphere at the moveAlongSurfaceTarget in this point's color
                    const targetMesh = new THREE.Mesh(
                        new THREE.SphereGeometry(0.12),
                        new THREE.MeshBasicMaterial({ color: colorThree }),
                    );
                    targetMesh.position.set(...point.moveAlongSurfaceTarget);
                    targetMesh.position.y += 0.2;
                    addVisual(targetMesh);
                }

                // Visualize steerTarget as an ArrowHelper with y += 2 offset
                if (point.steerTarget) {
                    const from = new THREE.Vector3(...point.position);
                    from.y += 0.5;
                    const to = new THREE.Vector3(...point.steerTarget);
                    to.y += 0.5;
                    const dir = new THREE.Vector3().subVectors(to, from).normalize();
                    const length = from.distanceTo(to);
                    const arrowColor = colorThree;
                    const arrowHelper = new THREE.ArrowHelper(dir, from, length, arrowColor.getHex(), 0.35, 0.18);
                    addVisual(arrowHelper);
                }

                // line between path points (except for END type, which already draws green)
                if (i > 0 && point.pointType !== 3 /* SmoothPathPointType.END */) {
                    const prevPoint = path[i - 1];
                    const geometry = new LineGeometry();
                    geometry.setFromPoints([
                        new THREE.Vector3(...prevPoint.position),
                        new THREE.Vector3(...point.position),
                    ]);
                    const material = new Line2NodeMaterial({
                        color: colorThree,
                        linewidth: 0.1,
                        worldUnits: true,
                    });
                    const line = new Line2(geometry, material);
                    addVisual(line);
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

renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    const point = getPointOnNavMesh(event);
    if (!point) return;
    if (event.button === 0) {
        start = point;
    } else if (event.button === 2) {
        end = point;
    }
    updatePath();
});

/* initial update */
updatePath();

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
