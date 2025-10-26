import GUI from 'lil-gui';
import type { Vec3 } from 'mathcat';
import { box3, degreesToRadians, vec2, vec3 } from 'mathcat';
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
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    type Heightfield,
    markBoxArea,
    markConvexPolyArea,
    markCylinderArea,
    markRotatedBoxArea,
    markWalkableTriangles,
    type NavMesh,
    type NavMeshTileParams,
    type PolyMesh,
    type PolyMeshDetail,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    rasterizeTriangles,
} from 'navcat';
import { createCompactHeightfieldSolidHelper, createHeightfieldHelper, createNavMeshHelper, getPositionsAndIndices } from 'navcat/three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import * as THREE from 'three/webgpu';
import { Line2NodeMaterial } from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';

/* area types */
enum NavMeshAreaType {
    A = 1,
    B = 2,
    C = 3,
    D = 4,
    E = 5,
}

/* navmesh generator showcasing multiple area marking APIs */
type NavMeshInput = {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
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

/* Shared area definitions (single source of truth for rasterization and helpers) */
const waterBox: [Vec3, Vec3] = [
    [5, -1, -8],
    [11, 1, -3],
];

const grassCylinderCenter: Vec3 = [9, 1.5, 3.5];
const grassCylinderRadius = 0.5;
const grassCylinderHeight = 2;

// biome-ignore format: readability
const roadVerts = [
    -2, 0, 5, // bottom-left
    2, 0, 5, // bottom-right
    3, 0, 3, // top-right
    0, 0, 2, // mid
    -3, 0, 3, // top-left
];
const roadMinY = -0.5;
const roadMaxY = 1.5;

const iceRinkCenter: Vec3 = [-3, 0, -3];
const iceRinkHalfExtentsParam: Vec3 = [1, 1, 4];
const iceRinkRotation = degreesToRadians(40);

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

    /* 5. mark custom areas - showcase different area marking APIs */

    // Example 1: markBoxArea - mark a rectangular water area
    markBoxArea(waterBox, NavMeshAreaType.B, compactHeightfield);

    // Example 2: markCylinderArea - mark a circular grass area
    markCylinderArea(grassCylinderCenter, grassCylinderRadius, grassCylinderHeight, NavMeshAreaType.C, compactHeightfield);

    // Example 3: markConvexPolyArea - mark a trapezoidal road area
    markConvexPolyArea(roadVerts, roadMinY, roadMaxY, NavMeshAreaType.D, compactHeightfield);

    // Example 4: markRotatedBoxArea - mark a rotated rectangular ice rink area
    markRotatedBoxArea(iceRinkCenter, iceRinkHalfExtentsParam, iceRinkRotation, NavMeshAreaType.E, compactHeightfield);

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

const navTestModel = await loadGLTF('./models/nav-test.glb');
scene.add(navTestModel.scene);

/* generate navmesh */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    if (object.userData?.walkable === false) return;

    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = getPositionsAndIndices(walkableMeshes);

const navMeshInput: NavMeshInput = {
    positions,
    indices,
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
    navMesh: true,
    heightfield: false,
    compactHeightfield: false,
    areaMarkers: true,
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

/* Area marker visuals (use the same shared variables so editing one place updates both behavior and visuals) */
type Visual = { object: THREE.Object3D; dispose: () => void };
const areaVisuals: Visual[] = [];

function createAreaVisuals() {
    // water box
    const wbMin = waterBox[0];
    const wbMax = waterBox[1];
    const wbSize = [wbMax[0] - wbMin[0], wbMax[1] - wbMin[1], wbMax[2] - wbMin[2]] as const;
    const wbCenter = [(wbMin[0] + wbMax[0]) / 2, (wbMin[1] + wbMax[1]) / 2, (wbMin[2] + wbMax[2]) / 2] as Vec3;
    const waterGeom = new THREE.BoxGeometry(wbSize[0], wbSize[1], wbSize[2]);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x1565c0, opacity: 0.35, transparent: true });
    const waterMesh = new THREE.Mesh(waterGeom, waterMat);
    waterMesh.position.set(...wbCenter);
    areaVisuals.push({
        object: waterMesh,
        dispose: () => {
            waterGeom.dispose();
            waterMat.dispose();
        },
    });

    // grass cylinder
    const grassGeom = new THREE.CylinderGeometry(grassCylinderRadius, grassCylinderRadius, grassCylinderHeight, 32);
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x4caf50, opacity: 0.35, transparent: true });
    const grassMesh = new THREE.Mesh(grassGeom, grassMat);
    grassMesh.position.set(grassCylinderCenter[0], grassCylinderCenter[1] + grassCylinderHeight / 2, grassCylinderCenter[2]);
    areaVisuals.push({
        object: grassMesh,
        dispose: () => {
            grassGeom.dispose();
            grassMat.dispose();
        },
    });

    // road polygon (wireframe loop)
    const roadPoints: THREE.Vector3[] = [];
    for (let i = 0; i < roadVerts.length; i += 3) {
        roadPoints.push(new THREE.Vector3(roadVerts[i], roadVerts[i + 1] + 0.05, roadVerts[i + 2]));
    }
    // close loop
    if (roadPoints.length > 0) roadPoints.push(roadPoints[0].clone());
    const roadLineGeom = new LineGeometry();
    roadLineGeom.setFromPoints(roadPoints);
    const roadLineMat = new Line2NodeMaterial({ color: 'orange', linewidth: 0.08, worldUnits: true });
    const roadLine = new Line2(roadLineGeom, roadLineMat);
    areaVisuals.push({
        object: roadLine,
        dispose: () => {
            roadLineGeom.dispose();
            roadLineMat.dispose();
        },
    });

    // ice rink (rotated box)
    const iceRinkGeom = new THREE.BoxGeometry(iceRinkHalfExtentsParam[0] * 2, iceRinkHalfExtentsParam[1] * 2, iceRinkHalfExtentsParam[2] * 2);
    const iceRinkMat = new THREE.MeshStandardMaterial({ color: 0xff0099, opacity: 0.35, transparent: true });
    const iceRinkMesh = new THREE.Mesh(iceRinkGeom, iceRinkMat);
    iceRinkMesh.position.set(iceRinkCenter[0], iceRinkCenter[1], iceRinkCenter[2]);
    iceRinkMesh.rotation.y = iceRinkRotation;
    areaVisuals.push({
        object: iceRinkMesh,
        dispose: () => {
            iceRinkGeom.dispose();
            iceRinkMat.dispose();
        },
    });

    // add all area visuals to scene
    for (const v of areaVisuals) scene.add(v.object);
}

createAreaVisuals();

const gui = new GUI();
gui.title('Mark Compact Heightfield Areas Example');

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
debugFolder
    .add(debugConfig, 'areaMarkers')
    .name('area markers')
    .onChange((visible: boolean) => {
        for (const v of areaVisuals) v.object.visible = visible;
        updateDebugViews();
    });
debugFolder.open();

/* start loop */
function update() {
    requestAnimationFrame(update);
    orbitControls.update();
    renderer.render(scene, camera);
}

update();
