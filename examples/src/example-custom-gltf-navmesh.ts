import GUI from 'lil-gui';
import { box3, type Vec3 } from 'mathcat';
import {
    addTile,
    buildTile,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    type ExternalPolygon,
    findPath,
    getNodeRefType,
    getTileAndPolyByRef,
    type NavMeshTileParams,
    NodeType,
    polygonsToNavMeshTilePolys,
    polysToTileDetailMesh,
} from 'navcat';
import { createNavMeshHelper, createNavMeshLinksHelper, createNavMeshPolyHelper, createSearchNodesHelper, getPositionsAndIndices } from 'navcat/three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import * as THREE from 'three/webgpu';
import { Line2NodeMaterial } from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';

/* setup example scene */
const container = document.getElementById('root')!;

// scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

// camera
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);

// renderer
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

container.appendChild(renderer.domElement);

// lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 1);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
directionalLight.position.set(5, 5, 5);
scene.add(directionalLight);

// resize handling
function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}
window.addEventListener('resize', onWindowResize);

await renderer.init();

camera.position.set(-2, 15, 20);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.target.set(0, 6, 0);

/* load model and navmesh */
const level = await loadGLTF('/models/tower-big.glb');

console.log('level', level);

const levelVisuals = level.scene.getObjectByName('level') as THREE.Object3D;
const levelNavMesh = level.scene.getObjectByName('navmesh') as THREE.Mesh;

scene.add(levelVisuals);
scene.add(levelNavMesh);

// create navmesh polys
const bounds = box3.create();
const boundsPoint: Vec3 = [0, 0, 0];

const [navMeshPositions, navMeshIndices] = getPositionsAndIndices([levelNavMesh]);

console.log(navMeshPositions);

for (let i = 0; i < navMeshPositions.length / 3; i++) {
    boundsPoint[0] = navMeshPositions[i * 3];
    boundsPoint[1] = navMeshPositions[i * 3 + 1];
    boundsPoint[2] = navMeshPositions[i * 3 + 2];
    box3.expandByPoint(bounds, bounds, boundsPoint);
}

const polys: ExternalPolygon[] = [];

for (let i = 0; i < navMeshIndices.length; i += 3) {
    const a = navMeshIndices[i];
    const b = navMeshIndices[i + 1];
    const c = navMeshIndices[i + 2];

    polys.push({
        vertices: [a, b, c],
        area: 0,
        flags: 1,
    });
}

const tilePolys = polygonsToNavMeshTilePolys(polys, navMeshPositions, 0, bounds);

const tileDetailMesh = polysToTileDetailMesh(tilePolys.polys);

/* create nav mesh tile */
const tileParams: NavMeshTileParams = {
    bounds,
    vertices: tilePolys.vertices,
    polys: tilePolys.polys,
    detailMeshes: tileDetailMesh.detailMeshes,
    detailVertices: tileDetailMesh.detailVertices,
    detailTriangles: tileDetailMesh.detailTriangles,
    tileX: 0,
    tileY: 0,
    tileLayer: 0,
    // values chosen to match approximate level of detail to match terrain generation
    cellSize: 0.2,
    cellHeight: 0.2,
    walkableHeight: 0.5,
    walkableRadius: 0.5,
    walkableClimb: 0.5,
};

const tile = buildTile(tileParams);

/* assemble navmesh */
const navMesh = createNavMesh();

navMesh.tileWidth = bounds[1][0] - bounds[0][0];
navMesh.tileHeight = bounds[1][2] - bounds[0][2];
navMesh.origin[0] = bounds[0][0];
navMesh.origin[1] = bounds[0][1];
navMesh.origin[2] = bounds[0][2];

addTile(navMesh, tile);

console.log('navMesh', navMesh);

const navMeshHelper = createNavMeshHelper(navMesh);
scene.add(navMeshHelper.object);

const navMeshLinksHelper = createNavMeshLinksHelper(navMesh);
scene.add(navMeshLinksHelper.object);

const gui = new GUI();

const debugFolder = gui.addFolder('Debug Views');

const debugConfig = {
    level: true,
    navMeshGeom: false,
    navMesh: true,
    navMeshLinks: false,
};

const updateDebugViews = () => {
    levelVisuals.visible = debugConfig.level;
    levelNavMesh.visible = debugConfig.navMeshGeom;
    navMeshHelper.object.visible = debugConfig.navMesh;
    navMeshLinksHelper.object.visible = debugConfig.navMeshLinks;
};

updateDebugViews();

debugFolder.add(debugConfig, 'level').onChange(updateDebugViews);
debugFolder.add(debugConfig, 'navMeshGeom').onChange(updateDebugViews);
debugFolder.add(debugConfig, 'navMesh').onChange(updateDebugViews);
debugFolder.add(debugConfig, 'navMeshLinks').onChange(updateDebugViews);

debugFolder.open();

/* find path */
let start: Vec3 = [-2.6, 1.1, 2.1];
let end: Vec3 = [0.5, 11.1, 0.5];
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

function createFlag(color: number) {
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

    return {
        object: group,
        dispose: () => {
            poleGeom.dispose();
            poleMat.dispose();
            flagGeom.dispose();
            flagMat.dispose();
        },
    };
}

function updatePath() {
    clearVisuals();

    const startFlag = createFlag(0x2196f3);
    startFlag.object.position.set(...start);
    addVisual(startFlag);

    const endFlag = createFlag(0x00ff00);
    endFlag.object.position.set(...end);
    addVisual(endFlag);

    const pathResult = findPath(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER);

    if (pathResult.success) {
        console.log(getTileAndPolyByRef(pathResult.startNodeRef!, navMesh).poly?.vertices);
    }

    const { path, nodePath } = pathResult;

    if (nodePath) {
        const searchNodesHelper = createSearchNodesHelper(nodePath.nodes);
        addVisual(searchNodesHelper);

        for (let i = 0; i < nodePath.path.length; i++) {
            const node = nodePath.path[i];
            if (getNodeRefType(node) === NodeType.POLY) {
                const polyHelper = createNavMeshPolyHelper(navMesh, node);
                addVisual(polyHelper);
            }
        }
    }

    if (path) {
        for (let i = 0; i < path.length; i++) {
            const point = path[i];
            // point
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
            mesh.position.set(point.position[0], point.position[1], point.position[2]);
            addVisual({
                object: mesh,
                dispose: () => {
                    mesh.geometry?.dispose();
                    mesh.material?.dispose?.();
                },
            });

            // line
            if (i > 0) {
                const prevPoint = path[i - 1];
                const geometry = new LineGeometry();

                const start = new THREE.Vector3(...prevPoint.position);
                const end = new THREE.Vector3(...point.position);
                geometry.setFromPoints([start, end]);

                const material = new Line2NodeMaterial({
                    color: 'yellow',
                    linewidth: 0.1,
                    worldUnits: true,
                    depthTest: false,
                    depthWrite: false,
                });

                const line = new Line2(geometry, material);
                line.renderOrder = 999;

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

/* interaction */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function getPointOnNavMesh(event: PointerEvent): Vec3 | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObject(levelNavMesh, true);
    if (intersects.length > 0) {
        const p = intersects[0].point;
        return [p.x, p.y, p.z];
    }
    return null;
}

renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    const point = getPointOnNavMesh(event);
    console.log('point', point);
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
