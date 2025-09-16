import GUI from 'lil-gui';
import { type Box3, box3, createMulberry32Generator, createSimplex2D, type Vec3 } from 'maaths';
import {
    addTile,
    buildNavMeshBvTree,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    type ExternalPolygon,
    findPath,
    FindStraightPathResultFlags,
    getNodeRefType,
    type NavMeshTile,
    NodeType,
    polygonsToNavMeshTilePolys,
    polysToTileDetailMesh,
    three as threeUtils,
} from 'navcat';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import * as THREE from 'three/webgpu';
import { Line2NodeMaterial } from 'three/webgpu';

/* setup three-mesh-bvh for faster raycasting */
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/* setup example scene */
const container = document.getElementById('root')!;

// scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

// camera
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 0, 20);

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

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

/* generate hilly terrain with scattered houses */
const levelMeshes: THREE.Object3D[] = [];

const simplexNoise = createSimplex2D(42);
const maxHeight = 2;

const terrainSize = 50;
const terrainSegments = 128;
const terrainGeometry = new THREE.PlaneGeometry(terrainSize, terrainSize, terrainSegments, terrainSegments);
terrainGeometry.rotateX(-Math.PI / 2);
const positionAttribute = terrainGeometry.getAttribute('position');

for (let i = 0; i < positionAttribute.count; i++) {
    const x = positionAttribute.getX(i);
    const z = positionAttribute.getZ(i);

    let y = 0;

    y += simplexNoise(x * 0.05, z * 0.05) * maxHeight * 0.5;
    y += simplexNoise(x * 0.1, z * 0.1) * maxHeight * 0.25;
    y += simplexNoise(x * 0.2, z * 0.2) * maxHeight * 0.125;
    y += simplexNoise(x * 0.4, z * 0.4) * maxHeight * 0.0625;
    y += simplexNoise(x * 0.8, z * 0.8) * maxHeight * 0.03125;

    positionAttribute.setY(i, y);
}
positionAttribute.needsUpdate = true;
terrainGeometry.computeVertexNormals();
const terrainMaterial = new THREE.MeshStandardMaterial({ color: 0x228822 });
const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
terrainMesh.userData.type = 'walkable';
scene.add(terrainMesh);
levelMeshes.push(terrainMesh);

const houseGeometry = new THREE.BoxGeometry(1, 1, 1);
houseGeometry.translate(0, 0.5, 0);
houseGeometry.computeBoundingBox();
houseGeometry.computeBoundingSphere();

const houseMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 });

const random = createMulberry32Generator(42);
for (let i = 0; i < 30; i++) {
    const houseMesh = new THREE.Mesh(houseGeometry, houseMaterial);
    houseMesh.userData.type = 'obstacle';
    houseMesh.position.set((random() - 0.5) * terrainSize * 0.9, 0, (random() - 0.5) * terrainSize * 0.9);

    const terrainHeight = (() => {
        const raycaster = new THREE.Raycaster(
            new THREE.Vector3(houseMesh.position.x, 100, houseMesh.position.z),
            new THREE.Vector3(0, -1, 0),
        );
        const intersects = raycaster.intersectObject(terrainMesh);
        if (intersects.length > 0) {
            return intersects[0].point.y;
        }
        return 0;
    })();

    houseMesh.position.y = terrainHeight - 0.2;
    houseMesh.scale.setScalar(1 + random() * 2);
    houseMesh.updateMatrixWorld();
    houseMesh.updateMatrix();

    scene.add(houseMesh);
    levelMeshes.push(houseMesh);

    console.log(houseMesh.raycast);
}

/* compute three-mesh-bvh bounds trees for faster raycasting */
terrainGeometry.computeBoundsTree();
houseGeometry.computeBoundsTree();

/* generate navmesh */
console.time('generate navmesh');

// raycast down and build a grid with shared vertices
const gridSize = 2;

const walkablePoints: Vec3[] = [];

const gridRaycastBounds: Box3 = [
    [-terrainSize / 2, -5, -terrainSize / 2],
    [terrainSize / 2, 5, terrainSize / 2],
];
const rayDirection = new THREE.Vector3(0, -1, 0);
const gridRaycaster = new THREE.Raycaster();
gridRaycaster.far = 100;

// grid dimensions
const nx = Math.ceil((gridRaycastBounds[1][0] - gridRaycastBounds[0][0]) / gridSize) + 1;
const nz = Math.ceil((gridRaycastBounds[1][2] - gridRaycastBounds[0][2]) / gridSize) + 1;

// grid of points
const grid: (Vec3 | null)[][] = Array.from({ length: nx }, () => Array(nz).fill(null));

// vertex index grid (shared vertex indices)
const vertexIndexGrid: (number | null)[][] = Array.from({ length: nx }, () => Array(nz).fill(null));

for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
        const x = gridRaycastBounds[0][0] + ix * gridSize;
        const z = gridRaycastBounds[0][2] + iz * gridSize;

        gridRaycaster.set(new THREE.Vector3(x, 50, z), rayDirection);

        const intersects = gridRaycaster.intersectObjects(scene.children, true);
        let foundPoint: Vec3 | null = null;

        for (const intersect of intersects) {
            if (intersect.object.userData.type === 'walkable') {
                foundPoint = [intersect.point.x, intersect.point.y, intersect.point.z];
                break;
            }
            if (intersect.object.userData.type === 'obstacle') break;
        }

        grid[ix][iz] = foundPoint;
        if (foundPoint) {
            const idx = walkablePoints.length;
            vertexIndexGrid[ix][iz] = idx;
            walkablePoints.push(foundPoint);
        }
    }
}

// triangulate quads using shared vertex indices
const indices: number[] = [];
for (let ix = 0; ix < nx - 1; ix++) {
    for (let iz = 0; iz < nz - 1; iz++) {
        const a = vertexIndexGrid[ix][iz];
        const b = vertexIndexGrid[ix + 1][iz];
        const c = vertexIndexGrid[ix][iz + 1];
        const d = vertexIndexGrid[ix + 1][iz + 1];

        if (a == null || b == null || c == null || d == null) continue;

        const pa = walkablePoints[a];
        const pb = walkablePoints[b];
        const pc = walkablePoints[d];

        const ab: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const ac: Vec3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];

        const normal: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];

        if (normal[1] < 0) {
            // flip triangles
            indices.push(a, d, b);
            indices.push(a, c, d);
        } else {
            indices.push(a, b, d);
            indices.push(a, d, c);
        }
    }
}

console.timeEnd('generate navmesh');

// visualise walkable points
const walkablePointsGroup = new THREE.Group();
for (const point of walkablePoints) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshBasicMaterial({ color: 0x0000ff }));
    mesh.position.set(...point);
    walkablePointsGroup.add(mesh);
}
scene.add(walkablePointsGroup);

// visualise the triangulation
const triangulationMaterial = new THREE.MeshBasicMaterial({
    color: 0x0000ff,
});

const triangulationGeometry = new THREE.BufferGeometry();
triangulationGeometry.setAttribute('position', new THREE.Float32BufferAttribute(walkablePoints.flat(), 3));
triangulationGeometry.setIndex(indices);
const triangulationMesh = new THREE.Mesh(triangulationGeometry, triangulationMaterial);
triangulationMesh.position.y += 0.2;

const triangulationWireframe = new THREE.LineSegments(
    new THREE.WireframeGeometry(triangulationGeometry),
    new THREE.LineBasicMaterial({ color: 0x000000 }),
);
triangulationWireframe.position.y += 0.2;

const triangulationGroup = new THREE.Group();
triangulationGroup.add(triangulationMesh);
triangulationGroup.add(triangulationWireframe);
scene.add(triangulationGroup);

// create navmesh polys
const bounds = box3.create();
const externalPolygonVertices: number[] = [];

for (const point of walkablePoints) {
    box3.expandByPoint(bounds, bounds, point);
    externalPolygonVertices.push(...point);
}

const polys: ExternalPolygon[] = [];

for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    polys.push({
        vertices: [a, b, c],
        area: 0,
        flags: 1,
    });
}

const tilePolys = polygonsToNavMeshTilePolys(polys, externalPolygonVertices, 0, bounds);

const tileDetailMesh = polysToTileDetailMesh(tilePolys.polys);

/* create nav mesh tile */
const tile: NavMeshTile = {
    id: -1,
    bounds,
    vertices: tilePolys.vertices,
    polys: tilePolys.polys,
    detailMeshes: tileDetailMesh.detailMeshes,
    detailVertices: tileDetailMesh.detailVertices,
    detailTriangles: tileDetailMesh.detailTriangles,
    tileX: 0,
    tileY: 0,
    tileLayer: 0,
    bvTree: null,
    // values chosen to match approximate level of detail to match terrain generation
    cellSize: 0.2,
    cellHeight: 0.2,
    walkableHeight: 0.5,
    walkableRadius: 0.5,
    walkableClimb: 0.5,
};

buildNavMeshBvTree(tile);

/* assemble navmesh */
const navMesh = createNavMesh();

navMesh.tileWidth = bounds[1][0] - bounds[0][0];
navMesh.tileHeight = bounds[1][2] - bounds[0][2];
navMesh.origin[0] = bounds[0][0];
navMesh.origin[1] = bounds[0][1];
navMesh.origin[2] = bounds[0][2];

addTile(navMesh, tile);

const navMeshHelper = threeUtils.createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.4;
scene.add(navMeshHelper.object);

const gui = new GUI();

const debugFolder = gui.addFolder('Debug Views');

const debugConfig = {
    navMesh: true,
    walkablePoints: false,
    triangulation: false,
};

const updateDebugViews = () => {
    navMeshHelper.object.visible = debugConfig.navMesh;
    walkablePointsGroup.visible = debugConfig.walkablePoints;
    triangulationGroup.visible = debugConfig.triangulation;
};

updateDebugViews();

debugFolder.add(debugConfig, 'navMesh').onChange(updateDebugViews);
debugFolder.add(debugConfig, 'walkablePoints').onChange(updateDebugViews);
debugFolder.add(debugConfig, 'triangulation').onChange(updateDebugViews);
debugFolder.open();

/* find path */
let start: Vec3 = [-6.1, 0.3, 5];
let end: Vec3 = [8.6, -0.4, -3.7];
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

    console.log('pathResult', pathResult);
    console.log('partial?', (pathResult.straightPathFlags & FindStraightPathResultFlags.PARTIAL_PATH) !== 0);

    const { path, nodePath } = pathResult;

    if (nodePath) {
        const searchNodesHelper = threeUtils.createSearchNodesHelper(nodePath.nodes);
        addVisual(searchNodesHelper);

        for (let i = 0; i < nodePath.path.length; i++) {
            const node = nodePath.path[i];
            if (getNodeRefType(node) === NodeType.GROUND_POLY) {
                const polyHelper = threeUtils.createNavMeshPolyHelper(navMesh, node);
                polyHelper.object.position.y += 0.15;
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
            mesh.position.y += 0.2;
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
                start.y += 0.2;
                const end = new THREE.Vector3(...point.position);
                end.y += 0.2;
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
    const intersects = raycaster.intersectObjects(levelMeshes, true);
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
