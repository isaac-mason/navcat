import GUI from 'lil-gui';
import type { Box3, Vec3 } from 'mathcat';
import { box3, vec2, vec3 } from 'mathcat';
import {
    addTile,
    buildCompactHeightfield,
    BuildContext,
    type BuildContextState,
    buildContours,
    buildDistanceField,
    buildPolyMesh,
    buildPolyMeshDetail,
    buildRegions,
    buildTile,
    calculateGridSize,
    calculateMeshBounds,
    type CompactHeightfield,
    ContourBuildFlags,
    type ContourSet,
    createHeightfield,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    findPath,
    FindStraightPathResultFlags,
    getNodeByRef,
    getNodeRefType,
    type Heightfield,
    markBoxArea,
    markWalkableTriangles,
    type NavMesh,
    type NavMeshTileParams,
    NodeType,
    type PolyMesh,
    type PolyMeshDetail,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    type QueryFilter,
    rasterizeTriangles,
    WALKABLE_AREA,
} from 'navcat';
import {
    createCompactHeightfieldSolidHelper,
    createHeightfieldHelper,
    createNavMeshHelper,
    createNavMeshPolyHelper,
    createSearchNodesHelper,
    getPositionsAndIndices,
} from 'navcat/three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import * as THREE from 'three/webgpu';
import { Line2NodeMaterial } from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';

/* area types */
enum NavMeshAreaType {
    GROUND = 1,
    WATER = 2,
}

/* custom query filters */
const WATER_ONLY_QUERY_FILTER: QueryFilter = {
    ...DEFAULT_QUERY_FILTER,
    passFilter(nodeRef, navMesh) {
        const node = getNodeByRef(navMesh, nodeRef);
        return node.area === NavMeshAreaType.WATER;
    },
};

const GROUND_ONLY_QUERY_FILTER: QueryFilter = {
    ...DEFAULT_QUERY_FILTER,
    passFilter(nodeRef, navMesh) {
        const node = getNodeByRef(navMesh, nodeRef);
        return node.area === NavMeshAreaType.GROUND;
    },
};

/* navmesh generator for water and ground custom areas */
type NavMeshInput = {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
    waterBounds: Box3;
};

type NavMeshOptions = {
    cellSize: number;
    cellHeight: number;
    walkableRadiusVoxels: number;
    walkableRadiusWorld: number;
    walkableClimbVoxels: number;
    walkableClimbWorld: number;
    walkableHeightVoxels: number;
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

type NavMeshIntermediates = {
    buildContext: BuildContextState;
    input: NavMeshInput;
    triAreaIds: Uint8Array;
    heightfield: Heightfield;
    compactHeightfield: CompactHeightfield;
    contourSet: ContourSet;
    polyMesh: PolyMesh;
    polyMeshDetail: PolyMeshDetail;
};

type NavMeshResult = {
    navMesh: NavMesh;
    intermediates: NavMeshIntermediates;
};

function generateNavMesh(input: NavMeshInput, options: NavMeshOptions): NavMeshResult {
    const ctx = BuildContext.create();

    BuildContext.start(ctx, 'navmesh generation');

    const { positions, indices } = input;

    /* 0. define generation parameters */
    const {
        cellSize,
        cellHeight,
        walkableRadiusVoxels,
        walkableRadiusWorld,
        walkableClimbVoxels,
        walkableClimbWorld,
        walkableHeightVoxels,
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

    /* 1. mark walkable triangles */
    BuildContext.start(ctx, 'mark walkable triangles');

    const triAreaIds = new Uint8Array(indices.length / 3).fill(0);
    markWalkableTriangles(positions, indices, triAreaIds, walkableSlopeAngleDegrees);

    BuildContext.end(ctx, 'mark walkable triangles');

    /* 2. rasterize the triangles to a voxel heightfield */
    BuildContext.start(ctx, 'rasterize triangles');

    const bounds = calculateMeshBounds(box3.create(), positions, indices);
    const [heightfieldWidth, heightfieldHeight] = calculateGridSize(vec2.create(), bounds, cellSize);

    const heightfield = createHeightfield(heightfieldWidth, heightfieldHeight, bounds, cellSize, cellHeight);

    rasterizeTriangles(ctx, heightfield, positions, indices, triAreaIds, walkableClimbVoxels);

    BuildContext.end(ctx, 'rasterize triangles');

    /* 3. filter walkable surfaces */
    BuildContext.start(ctx, 'filter walkable surfaces');

    filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
    filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
    filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

    BuildContext.end(ctx, 'filter walkable surfaces');

    /* 4. compact the heightfield */
    BuildContext.start(ctx, 'build compact heightfield');

    const compactHeightfield = buildCompactHeightfield(ctx, walkableHeightVoxels, walkableClimbVoxels, heightfield);

    BuildContext.end(ctx, 'build compact heightfield');

    /* 5. mark custom areas */

    // mark 'water' custom area with bounds
    markBoxArea(navMeshInput.waterBounds, NavMeshAreaType.WATER, compactHeightfield);

    /* 6. erode the walkable area by the agent radius / walkable radius */
    BuildContext.start(ctx, 'erode walkable area');

    erodeWalkableArea(walkableRadiusVoxels, compactHeightfield);

    BuildContext.end(ctx, 'erode walkable area');

    /* 7. prepare for region partitioning by calculating a distance field along the walkable surface */
    BuildContext.start(ctx, 'build compact heightfield distance field');

    buildDistanceField(compactHeightfield);

    BuildContext.end(ctx, 'build compact heightfield distance field');

    /* 8. partition the walkable surface into simple regions without holes */
    BuildContext.start(ctx, 'build compact heightfield regions');

    buildRegions(ctx, compactHeightfield, borderSize, minRegionArea, mergeRegionArea);

    BuildContext.end(ctx, 'build compact heightfield regions');

    /* 9. trace and simplify region contours */
    BuildContext.start(ctx, 'trace and simplify region contours');

    const contourSet = buildContours(
        ctx,
        compactHeightfield,
        maxSimplificationError,
        maxEdgeLength,
        ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
    );

    BuildContext.end(ctx, 'trace and simplify region contours');

    /* 10. build polygons mesh from contours */
    BuildContext.start(ctx, 'build polygons mesh from contours');

    const polyMesh = buildPolyMesh(ctx, contourSet, maxVerticesPerPoly);

    for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
        if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
            polyMesh.areas[polyIndex] = NavMeshAreaType.GROUND;
            polyMesh.flags[polyIndex] = 0x01;
        } else if (polyMesh.areas[polyIndex] === NavMeshAreaType.WATER) {
            polyMesh.areas[polyIndex] = NavMeshAreaType.WATER;
            polyMesh.flags[polyIndex] = 0x02;
        }
    }

    BuildContext.end(ctx, 'build polygons mesh from contours');

    /* 11. create detail mesh which allows to access approximate height on each polygon */
    BuildContext.start(ctx, 'build detail mesh from contours');

    const polyMeshDetail = buildPolyMeshDetail(ctx, polyMesh, compactHeightfield, detailSampleDistance, detailSampleMaxError);

    BuildContext.end(ctx, 'build detail mesh from contours');

    BuildContext.end(ctx, 'navmesh generation');

    /* store intermediates for debugging */
    const intermediates: NavMeshIntermediates = {
        buildContext: ctx,
        input,
        triAreaIds,
        heightfield,
        compactHeightfield,
        contourSet,
        polyMesh,
        polyMeshDetail,
    };

    /* create a single tile nav mesh */
    const nav = createNavMesh();
    nav.tileWidth = polyMesh.bounds[1][0] - polyMesh.bounds[0][0];
    nav.tileHeight = polyMesh.bounds[1][2] - polyMesh.bounds[0][2];
    vec3.copy(nav.origin, polyMesh.bounds[0]);

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

    addTile(nav, tile);

    return {
        navMesh: nav,
        intermediates,
    };
}

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

const navTestModel = await loadGLTF('/models/bridges.glb');
scene.add(navTestModel.scene);

/* generate navmesh */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    console.log(object.userData);
    if (object.userData?.walkable === false) return;

    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = getPositionsAndIndices(walkableMeshes);

const navMeshInput: NavMeshInput = {
    positions,
    indices,
    waterBounds: [
        [-100, -1, -100],
        [100, 1, 100],
    ],
};

const cellSize = 0.2;
const cellHeight = 0.15;

const walkableRadiusWorld = 0.1;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 0.1;
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

const navMeshConfig: NavMeshOptions = {
    cellSize,
    cellHeight,
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

const navMeshResult = generateNavMesh(navMeshInput, navMeshConfig);
const navMesh = navMeshResult.navMesh;

const debugConfig = {
    navMesh: false,
    heightfield: false,
    compactHeightfield: false,
};

const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

const heightfieldHelper = createHeightfieldHelper(navMeshResult.intermediates.heightfield);
heightfieldHelper.object.position.y += 0.05;
scene.add(heightfieldHelper.object);

const compactHeightfieldHelper = createCompactHeightfieldSolidHelper(navMeshResult.intermediates.compactHeightfield);
scene.add(compactHeightfieldHelper.object);
compactHeightfieldHelper.object.position.y += 0.1;

const gui = new GUI();

const debugFolder = gui.addFolder('Debug Views');

const updateDebugViews = () => {
    heightfieldHelper.object.visible = debugConfig.heightfield;
    compactHeightfieldHelper.object.visible = debugConfig.compactHeightfield;
    navMeshHelper.object.visible = debugConfig.navMesh;
};
updateDebugViews();

debugFolder.add(debugConfig, 'navMesh').onChange(updateDebugViews);
debugFolder.add(debugConfig, 'heightfield').onChange(updateDebugViews);
debugFolder.add(debugConfig, 'compactHeightfield').onChange(updateDebugViews);
debugFolder.open();

/* query filter gui */
const queryFilterConfig = {
    filter: 'ground' as 'all' | 'ground' | 'water',
};
const queryFilterFolder = gui.addFolder('Query Filter');
queryFilterFolder.add(queryFilterConfig, 'filter', ['all', 'ground', 'water']).name('area').onChange(updatePath);

/* find path */
let start: Vec3 = [-8, 1.5, -2.3];
let end: Vec3 = [8, 1, -0.5];
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

    const queryFilter =
        queryFilterConfig.filter === 'all'
            ? DEFAULT_QUERY_FILTER
            : queryFilterConfig.filter === 'ground'
              ? GROUND_ONLY_QUERY_FILTER
              : WATER_ONLY_QUERY_FILTER;

    const pathResult = findPath(navMesh, start, end, halfExtents, queryFilter);

    console.log('pathResult', pathResult);
    console.log('partial?', (pathResult.straightPathFlags & FindStraightPathResultFlags.PARTIAL_PATH) !== 0);

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
            // point
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
            mesh.position.set(...point.position);
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
