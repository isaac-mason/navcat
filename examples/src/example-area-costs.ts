import GUI from 'lil-gui';
import type { Box3, Vec2, Vec3 } from 'mathcat';
import { box3, vec2, vec3 } from 'mathcat';
import {
    addTile,
    buildCompactHeightfield,
    BuildContext,
    buildContours,
    buildDistanceField,
    buildPolyMesh,
    buildPolyMeshDetail,
    buildRegions,
    buildTile,
    calculateGridSize,
    calculateMeshBounds,
    ContourBuildFlags,
    createHeightfield,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    findPath,
    getNodeByRef,
    markBoxArea,
    markWalkableTriangles,
    type NavMesh,
    type NavMeshTileParams,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    type QueryFilter,
    rasterizeTriangles,
    WALKABLE_AREA,
} from 'navcat';
import { createNavMeshHelper, getPositionsAndIndices } from 'navcat/three';
import * as THREE from 'three/webgpu';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
import { createExample } from './common/example-base';

enum NavMeshAreaType {
    GROUND = 1,
    RED = 2,
    GREEN = 3,
}

const RED_ZONE_BOUNDS: Box3 = [
    [-8, -2, -2],
    [2, 2, 12],
];

const GREEN_ENTRY_BOUNDS: Box3 = [
    [2, -2, -12],
    [14, 2, -2],
];

const GREEN_LANE_BOUNDS: Box3 = [
    [8, -2, -2],
    [14, 2, 12],
];

const GREEN_EXIT_BOUNDS: Box3 = [
    [-12, -2, 12],
    [14, 2, 20],
];

const RED_COLOR = 0xff3b30;
const GREEN_COLOR = 0x00ff6a;

const FLOOR_SIZE = 40;

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-18, 16, 22);
camera.lookAt(0, 0, 0);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

/* base floor */
const floorGeometry = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
floorGeometry.rotateX(-Math.PI / 2);
const floorMaterial = new THREE.MeshBasicMaterial({ color: 0x1d4ed8 });
const floorMesh = new THREE.Mesh(floorGeometry, floorMaterial);
floorMesh.receiveShadow = true;
scene.add(floorMesh);

/* zone overlays */
function createOverlay(bounds: Box3, color: number) {
    const [min, max] = bounds;
    const sizeX = max[0] - min[0];
    const sizeZ = max[2] - min[2];
    const geometry = new THREE.PlaneGeometry(sizeX, sizeZ);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
        color,
        transparent: false,
        side: THREE.FrontSide,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(min[0] + sizeX / 2, 0.01, min[2] + sizeZ / 2);
    mesh.renderOrder = 1;
    return mesh;
}

const redOverlay = createOverlay(RED_ZONE_BOUNDS, RED_COLOR);
const greenEntryOverlay = createOverlay(GREEN_ENTRY_BOUNDS, GREEN_COLOR);
const greenLaneOverlay = createOverlay(GREEN_LANE_BOUNDS, GREEN_COLOR);
const greenExitOverlay = createOverlay(GREEN_EXIT_BOUNDS, GREEN_COLOR);

scene.add(redOverlay, greenEntryOverlay, greenLaneOverlay, greenExitOverlay);

/* navmesh generation */
type NavMeshGenerationInput = {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
};

type NavMeshGenerationOptions = {
    cellSize: number;
    cellHeight: number;
    walkableRadiusWorld: number;
    walkableClimbWorld: number;
    walkableHeightWorld: number;
    walkableSlopeAngleDegrees: number;
    borderSize: number;
    minRegionArea: number;
    mergeRegionArea: number;
    maxSimplificationError: number;
    maxEdgeLength: number;
    maxVerticesPerPoly: number;
    detailSampleDistance: number;
    detailSampleMaxError: number;
};

type NavMeshGenerationResult = {
    navMesh: NavMesh;
};

function generateFlatNavMesh(input: NavMeshGenerationInput, options: NavMeshGenerationOptions): NavMeshGenerationResult {
    const ctx = BuildContext.create();
    BuildContext.start(ctx, 'navmesh generation');

    const {
        cellSize,
        cellHeight,
        walkableRadiusWorld,
        walkableClimbWorld,
        walkableHeightWorld,
        walkableSlopeAngleDegrees,
        borderSize,
        minRegionArea,
        mergeRegionArea,
        maxSimplificationError,
        maxEdgeLength,
        maxVerticesPerPoly,
        detailSampleDistance,
        detailSampleMaxError,
    } = options;

    const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
    const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);
    const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);

    const triAreaIds = new Uint8Array(input.indices.length / 3).fill(0);
    markWalkableTriangles(input.positions, input.indices, triAreaIds, walkableSlopeAngleDegrees);

    const bounds = calculateMeshBounds(box3.create(), input.positions, input.indices);
    const gridSize: Vec2 = calculateGridSize(vec2.create(), bounds, cellSize);

    const heightfield = createHeightfield(gridSize[0], gridSize[1], bounds, cellSize, cellHeight);

    rasterizeTriangles(ctx, heightfield, input.positions, input.indices, triAreaIds, walkableClimbVoxels);

    filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
    filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
    filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

    const compactHeightfield = buildCompactHeightfield(ctx, walkableHeightVoxels, walkableClimbVoxels, heightfield);

    markBoxArea(RED_ZONE_BOUNDS, NavMeshAreaType.RED, compactHeightfield);
    markBoxArea(GREEN_ENTRY_BOUNDS, NavMeshAreaType.GREEN, compactHeightfield);
    markBoxArea(GREEN_LANE_BOUNDS, NavMeshAreaType.GREEN, compactHeightfield);
    markBoxArea(GREEN_EXIT_BOUNDS, NavMeshAreaType.GREEN, compactHeightfield);

    erodeWalkableArea(walkableRadiusVoxels, compactHeightfield);

    buildDistanceField(compactHeightfield);
    buildRegions(ctx, compactHeightfield, borderSize, minRegionArea, mergeRegionArea);

    const contourSet = buildContours(
        ctx,
        compactHeightfield,
        maxSimplificationError,
        maxEdgeLength,
        ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
    );

    const polyMesh = buildPolyMesh(ctx, contourSet, maxVerticesPerPoly);

    for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
        if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
            polyMesh.areas[polyIndex] = NavMeshAreaType.GROUND;
            polyMesh.flags[polyIndex] = 0x01;
        } else if (polyMesh.areas[polyIndex] === NavMeshAreaType.RED) {
            polyMesh.flags[polyIndex] = 0x02;
        } else if (polyMesh.areas[polyIndex] === NavMeshAreaType.GREEN) {
            polyMesh.flags[polyIndex] = 0x04;
        }
    }

    const polyMeshDetail = buildPolyMeshDetail(
        ctx,
        polyMesh,
        compactHeightfield,
        detailSampleDistance,
        detailSampleMaxError,
    );

    const navMesh = createNavMesh();
    navMesh.tileWidth = polyMesh.bounds[1][0] - polyMesh.bounds[0][0];
    navMesh.tileHeight = polyMesh.bounds[1][2] - polyMesh.bounds[0][2];
    vec3.copy(navMesh.origin, polyMesh.bounds[0]);

    const tilePolys = polyMeshToTilePolys(polyMesh);
    const tileDetailMesh = polyMeshDetailToTileDetailMesh(tilePolys.polys, polyMeshDetail);

    const tileParams: NavMeshTileParams = {
        bounds: polyMesh.bounds,
        vertices: tilePolys.vertices,
        polys: tilePolys.polys,
        detailMeshes: tileDetailMesh.detailMeshes,
        detailVertices: tileDetailMesh.detailVertices,
        detailTriangles: tileDetailMesh.detailTriangles,
        tileX: 0,
        tileY: 0,
        tileLayer: 0,
        cellSize,
        cellHeight,
        walkableHeight: walkableHeightWorld,
        walkableRadius: walkableRadiusWorld,
        walkableClimb: walkableClimbWorld,
    };

    const tile = buildTile(tileParams);
    addTile(navMesh, tile);

    BuildContext.end(ctx, 'navmesh generation');

    return { navMesh };
}

const walkableMeshes: THREE.Mesh[] = [floorMesh];
const [positions, indices] = getPositionsAndIndices(walkableMeshes);

const navMeshOptions: NavMeshGenerationOptions = {
    cellSize: 0.5,
    cellHeight: 0.2,
    walkableRadiusWorld: 0.3,
    walkableClimbWorld: 0.4,
    walkableHeightWorld: 0.5,
    walkableSlopeAngleDegrees: 45,
    borderSize: 4,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxSimplificationError: 1.3,
    maxEdgeLength: 12,
    maxVerticesPerPoly: 6,
    detailSampleDistance: 0.6,
    detailSampleMaxError: 0.2,
};

const { navMesh } = generateFlatNavMesh({ positions, indices }, navMeshOptions);

const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.visible = false;
scene.add(navMeshHelper.object);

/* cost-aware query filter */
const areaCostConfig = {
    ground: 1.0,
    red: 3.0,
    green: 0.45,
};

const queryFilter: QueryFilter = {
    ...DEFAULT_QUERY_FILTER,
    getCost(pa, pb, navMeshInstance, _prevRef, curRef, _nextRef) {
        const base = vec3.distance(pa, pb);
        if (!curRef) return base;
        const node = getNodeByRef(navMeshInstance, curRef);
        const multiplier =
            node.area === NavMeshAreaType.RED
                ? areaCostConfig.red
                : node.area === NavMeshAreaType.GREEN
                  ? areaCostConfig.green
                  : areaCostConfig.ground;
        return base * multiplier;
    },
};

/* path interaction */
let start: Vec3 = [-6, 0, -10];
let end: Vec3 = [-6, 0, 18];
const halfExtents: Vec3 = [0.6, 1, 0.6];

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

function createFlag(color: number): Visual {
    const poleGeom = new THREE.BoxGeometry(0.12, 1.2, 0.12);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const pole = new THREE.Mesh(poleGeom, poleMat);
    pole.position.set(0, 0.6, 0);

    const flagGeom = new THREE.BoxGeometry(0.32, 0.22, 0.04);
    const flagMat = new THREE.MeshStandardMaterial({ color });
    const flag = new THREE.Mesh(flagGeom, flagMat);
    flag.position.set(0.23, 1.0, 0);

    const group = new THREE.Group();
    group.add(pole, flag);

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

function createPathPoint(position: Vec3): Visual {
    const geometry = new THREE.SphereGeometry(0.2);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    return {
        object: mesh,
        dispose: () => {
            geometry.dispose();
            material.dispose();
        },
    };
}

function createPathSegment(a: Vec3, b: Vec3): Visual {
    const geometry = new LineGeometry();
    geometry.setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
    const material = new Line2NodeMaterial({
        color: '#ffffff',
        linewidth: 0.12,
        worldUnits: true,
    });
    const line = new Line2(geometry, material);
    return {
        object: line,
        dispose: () => {
            geometry.dispose();
            material.dispose();
        },
    };
}

function updatePath() {
    clearVisuals();

    const startFlag = createFlag(0x2196f3);
    startFlag.object.position.set(...start);
    addVisual(startFlag);

    const endFlag = createFlag(GREEN_COLOR);
    endFlag.object.position.set(...end);
    addVisual(endFlag);

    const pathResult = findPath(navMesh, start, end, halfExtents, queryFilter);

    const { path } = pathResult;

    if (path) {
        for (let i = 0; i < path.length; i++) {
            const point = path[i];
            addVisual(createPathPoint(point.position));

            if (i > 0) {
                const prev = path[i - 1];
                addVisual(createPathSegment(prev.position, point.position));
            }
        }
    }
}

/* interaction */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function getPointOnFloor(event: PointerEvent): Vec3 | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const intersects = raycaster.intersectObjects([floorMesh], true);
    if (intersects.length > 0) {
        const p = intersects[0].point;
        return [p.x, p.y, p.z];
    }
    return null;
}

let moving: 'start' | 'end' | null = null;

renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    const point = getPointOnFloor(event);
    if (!point) return;

    if (event.button === 0) {
        moving = 'start';
        renderer.domElement.style.cursor = 'crosshair';
        start = point;
    } else if (event.button === 2) {
        moving = 'end';
        renderer.domElement.style.cursor = 'crosshair';
        end = point;
    }

    updatePath();
});

renderer.domElement.addEventListener('pointerup', () => {
    moving = null;
    renderer.domElement.style.cursor = '';
});

renderer.domElement.addEventListener('pointermove', (event: PointerEvent) => {
    if (!moving) return;
    const point = getPointOnFloor(event);
    if (!point) return;

    if (moving === 'start') {
        start = point;
    } else if (moving === 'end') {
        end = point;
    }

    updatePath();
});

renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

const gui = new GUI();
gui.title('Area Cost Controls');
const costsFolder = gui.addFolder('Cost multipliers');
const sliderMin = 0.1;
const sliderMax = 5;
const sliderStep = 0.05;

costsFolder.add(areaCostConfig, 'ground', sliderMin, sliderMax, sliderStep).name('Ground').onChange(() => updatePath());
costsFolder.add(areaCostConfig, 'red', sliderMin, sliderMax, sliderStep).name('Red').onChange(() => updatePath());
costsFolder.add(areaCostConfig, 'green', sliderMin, sliderMax, sliderStep).name('Green').onChange(() => updatePath());
costsFolder.open();

/* initial render */
updatePath();

function update() {
    requestAnimationFrame(update);
    orbitControls.update();
    renderer.render(scene, camera);
}

update();

