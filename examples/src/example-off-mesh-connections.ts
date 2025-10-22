import { type Vec3, vec3 } from 'mathcat';
import {
    addOffMeshConnection,
    findPath,
    getNodeByRef,
    getNodeRefType,
    NodeType,
    OffMeshConnectionDirection,
    type OffMeshConnectionParams,
    type QueryFilter,
} from 'navcat';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import {
    createNavMeshHelper,
    createNavMeshOffMeshConnectionsHelper,
    createNavMeshPolyHelper,
    createSearchNodesHelper,
    getPositionsAndIndices,
} from 'navcat/three';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
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

/* off mesh connection types */
enum OffMeshConnectionAreaType {
    TELEPORTER = 1,
    JUMP = 2,
    CLIMB = 3,
}

/* query filter */
const queryFilter: QueryFilter = {
    passFilter: (_nodeRef, _navMesh) => {
        return true;
    },
    getCost: (pa, pb, navMesh, _prevRef, curRef, _nextRef) => {
        // define the costs for traversing an off mesh connection
        if (curRef !== undefined && getNodeRefType(curRef) === NodeType.OFFMESH) {
            const { area } = getNodeByRef(navMesh, curRef);

            if (area === OffMeshConnectionAreaType.JUMP) {
                // regular distance
                return vec3.distance(pa, pb);
            } else if (area === OffMeshConnectionAreaType.CLIMB) {
                // distance * 4, big penalty
                return vec3.distance(pa, pb) * 4;
            } else if (area === OffMeshConnectionAreaType.TELEPORTER) {
                // low flat cost
                return 1;
            }
        }

        return vec3.distance(pa, pb);
    },
};

/* add off mesh connections */
const offMeshConnections: OffMeshConnectionParams[] = [
    {
        start: [-2.4799404316645157, 0.26716880587122915, 4.039628947351325],
        end: [-2.735661224133032, 2.3264200687408447, 0.9084349415865054],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        area: OffMeshConnectionAreaType.TELEPORTER,
        flags: 0xffffff,
    },
    {
        start: [0.43153271761444056, 3.788429404449852, 2.549912418335899],
        end: [1.6203363597139502, 2.7055995008052136, 3.3892644209191634],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        area: OffMeshConnectionAreaType.JUMP,
        flags: 0xffffff,
    },
    {
        start: [0.5997826320925559, 0.2668087168256541, 4.967287730406272],
        end: [1.580858144475107, 3.112976869830365, 4.670723413649996],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        area: OffMeshConnectionAreaType.CLIMB,
        flags: 0xffffff,
    },
    {
        start: [3.54, 0.27, -3.89],
        end: [6.09, 0.69, -3.59],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        area: 0,
        flags: 0xffffff,
    },
    {
        start: [6.09, 0.69, -3.59],
        end: [6.55, 0.39, -0.68],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        area: 0,
        flags: 0xffffff,
    },
];

for (const connection of offMeshConnections) {
    addOffMeshConnection(navMesh, connection);
}

/* create debug helpers */
const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

const offMeshConnectionsHelper = createNavMeshOffMeshConnectionsHelper(navMesh);
scene.add(offMeshConnectionsHelper.object);

/* find path */
let start: Vec3 = [-2.2, 0.26, 4.71];
let end: Vec3 = [3.4, 2.8, 3.6];
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
                    if (Array.isArray(child.material)) {
                        child.material.forEach((mat) => {
                            if (mat.dispose) {
                                mat.dispose();
                            }
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
                            if (mat.dispose) {
                                mat.dispose();
                            }
                        });
                    } else {
                        child.material?.dispose?.();
                    }
                }
            });
        },
    });

    const pathResult = findPath(navMesh, start, end, halfExtents, queryFilter);

    if (pathResult.success) {
        const { path, nodePath } = pathResult;

        if (nodePath) {
            const searchNodesHelper = createSearchNodesHelper(nodePath.nodes);
            addVisual({
                object: searchNodesHelper.object,
                dispose: () => {
                    // searchNodesHelper has its own disposal handled elsewhere; remove only
                },
            });

            for (let i = 0; i < nodePath.path.length; i++) {
                const node = nodePath.path[i];

                if (getNodeRefType(node) === NodeType.POLY) {
                    const polyHelper = createNavMeshPolyHelper(navMesh, node);
                    polyHelper.object.position.y += 0.15;
                    addVisual({
                        object: polyHelper.object,
                        dispose: () => {
                            polyHelper.object.traverse((child) => {
                                if ((child as any).geometry) (child as any).geometry.dispose?.();
                                if ((child as any).material) {
                                    const mat = (child as any).material;
                                    if (Array.isArray(mat)) {
                                        mat.forEach((m: any) => {
                                            m?.dispose?.();
                                        });
                                    } else {
                                        mat.dispose?.();
                                    }
                                }
                            });
                        },
                    });
                }
            }
        }

        if (path) {
            for (let i = 0; i < path.length; i++) {
                const point = path[i];

                // point
                const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
                mesh.position.set(...point.position);
                addVisual({
                    object: mesh,
                    dispose: () => {
                        mesh.geometry?.dispose();
                        (mesh.material as any)?.dispose?.();
                    },
                });

                // line
                if (i > 0) {
                    const prevPoint = path[i - 1];

                    const geometry = new LineGeometry();
                    geometry.setFromPoints([new THREE.Vector3(...prevPoint.position), new THREE.Vector3(...point.position)]);

                    const material = new Line2NodeMaterial({
                        color: 'yellow',
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

    updateStats();
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

/* path stats */
const statsDiv = document.createElement('div');
statsDiv.style.position = 'absolute';
statsDiv.style.top = '10px';
statsDiv.style.left = '10px';
statsDiv.style.color = 'white';
statsDiv.style.fontFamily = 'monospace';
statsDiv.style.fontSize = '11px';
statsDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
statsDiv.style.padding = '10px';
statsDiv.style.borderRadius = '4px';
statsDiv.style.minWidth = '200px';
container.appendChild(statsDiv);

function updateStats() {
    let html = `<div style="margin-bottom: 8px; font-weight: bold; color: #00aaff;">Path Stats</div>`;

    // Start position
    html += `<div style="margin-bottom: 4px;">`;
    html += `<div style="color: #2196f3; font-weight: bold;">Start Position</div>`;
    html += `<div style="color: #ccc; padding-left: 8px;">X: ${start[0].toFixed(2)}</div>`;
    html += `<div style="color: #ccc; padding-left: 8px;">Y: ${start[1].toFixed(2)}</div>`;
    html += `<div style="color: #ccc; padding-left: 8px;">Z: ${start[2].toFixed(2)}</div>`;
    html += `</div>`;

    // End position
    html += `<div style="margin-bottom: 4px;">`;
    html += `<div style="color: #00ff00; font-weight: bold;">End Position</div>`;
    html += `<div style="color: #ccc; padding-left: 8px;">X: ${end[0].toFixed(2)}</div>`;
    html += `<div style="color: #ccc; padding-left: 8px;">Y: ${end[1].toFixed(2)}</div>`;
    html += `<div style="color: #ccc; padding-left: 8px;">Z: ${end[2].toFixed(2)}</div>`;
    html += `</div>`;

    // Path stats
    const pathResult = findPath(navMesh, start, end, halfExtents, queryFilter);

    html += `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.2);">`;
    html += `<div style="color: #ffff00; font-weight: bold; margin-bottom: 4px;">Path Info</div>`;
    html += `<pre style="color: #ccc; font-size: 10px; margin: 0; overflow-x: auto; max-height: 400px; overflow-y: auto;">${JSON.stringify(pathResult, null, 2)}</pre>`;
    html += `</div>`;

    statsDiv.innerHTML = html;
}

/* initial update */
updateStats();
updatePath();

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
