import GUI from 'lil-gui';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import {
    createCompactHeightfieldDistancesHelper,
    createCompactHeightfieldRegionsHelper,
    createCompactHeightfieldSolidHelper,
    createHeightfieldHelper,
    createNavMeshBvTreeHelper,
    createNavMeshHelper,
    createNavMeshLinksHelper,
    createPolyMeshDetailHelper,
    createPolyMeshHelper,
    createRawContoursHelper,
    createSimplifiedContoursHelper,
    createTriangleAreaIdsHelper,
    type DebugObject,
} from './common/debug';
import { createExample } from './common/example-base';
import { generateSoloNavMesh, type SoloNavMeshInput, type SoloNavMeshOptions } from './common/generate-solo-nav-mesh';
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

/* navmesh generation parameters */
const config = {
    cellSize: 0.15,
    cellHeight: 0.15,
    walkableRadiusWorld: 0.1,
    walkableClimbWorld: 0.5,
    walkableHeightWorld: 0.25,
    walkableSlopeAngleDegrees: 45,
    borderSize: 0,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxSimplificationError: 1.3,
    maxEdgeLength: 12,
    maxVerticesPerPoly: 5,
    detailSampleDistance: 6,
    detailSampleMaxError: 1,
};

/* debug helpers configuration */
const debugConfig = {
    showMesh: true,
    showTriangleAreaIds: false,
    showHeightfield: false,
    showCompactHeightfieldSolid: false,
    showCompactHeightfieldDistances: false,
    showCompactHeightfieldRegions: false,
    showRawContours: false,
    showSimplifiedContours: false,
    showPolyMesh: false,
    showPolyMeshDetail: false,
    showNavMeshBvTree: false,
    showNavMesh: true,
    showNavMeshLinks: false,
};

/* setup gui */
const gui = new GUI();
gui.title('NavMesh Generation');

const cellFolder = gui.addFolder('Heightfield');
cellFolder.add(config, 'cellSize', 0.01, 1, 0.01);
cellFolder.add(config, 'cellHeight', 0.01, 1, 0.01);

const walkableFolder = gui.addFolder('Agent');
walkableFolder.add(config, 'walkableRadiusWorld', 0, 2, 0.01);
walkableFolder.add(config, 'walkableClimbWorld', 0, 2, 0.01);
walkableFolder.add(config, 'walkableHeightWorld', 0, 2, 0.01);
walkableFolder.add(config, 'walkableSlopeAngleDegrees', 0, 90, 1);

const regionFolder = gui.addFolder('Region');
regionFolder.add(config, 'borderSize', 0, 10, 1);
regionFolder.add(config, 'minRegionArea', 0, 50, 1);
regionFolder.add(config, 'mergeRegionArea', 0, 50, 1);

const contourFolder = gui.addFolder('Contour');
contourFolder.add(config, 'maxSimplificationError', 0.1, 10, 0.1);
contourFolder.add(config, 'maxEdgeLength', 0, 50, 1);

const polyMeshFolder = gui.addFolder('PolyMesh');
polyMeshFolder.add(config, 'maxVerticesPerPoly', 3, 12, 1);

const detailFolder = gui.addFolder('Detail');
detailFolder.add(config, 'detailSampleDistance', 0, 16, 0.1);
detailFolder.add(config, 'detailSampleMaxError', 0, 16, 0.1);

const debugFolder = gui.addFolder('Debug Helpers');
debugFolder
    .add(debugConfig, 'showMesh')
    .name('Show Mesh')
    .onChange(() => {
        navTestModel.scene.visible = debugConfig.showMesh;
    });
debugFolder.add(debugConfig, 'showTriangleAreaIds').name('Triangle Area IDs').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showHeightfield').name('Heightfield').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showCompactHeightfieldSolid').name('Compact Heightfield Solid').onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showCompactHeightfieldDistances')
    .name('Compact Heightfield Distances')
    .onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showCompactHeightfieldRegions').name('Compact Heightfield Regions').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showRawContours').name('Raw Contours').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showSimplifiedContours').name('Simplified Contours').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showPolyMesh').name('Poly Mesh').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showPolyMeshDetail').name('Poly Mesh Detail').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showNavMeshBvTree').name('NavMesh BV Tree').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showNavMesh').name('NavMesh').onChange(updateDebugHelpers);
debugFolder.add(debugConfig, 'showNavMeshLinks').name('NavMesh Links').onChange(updateDebugHelpers);
let result: ReturnType<typeof generateSoloNavMesh> | null = null;

// Debug helper objects
const debugHelpers: {
    triangleAreaIds: DebugObject | null;
    heightfield: DebugObject | null;
    compactHeightfieldSolid: DebugObject | null;
    compactHeightfieldDistances: DebugObject | null;
    compactHeightfieldRegions: DebugObject | null;
    rawContours: DebugObject | null;
    simplifiedContours: DebugObject | null;
    polyMesh: DebugObject | null;
    polyMeshDetail: DebugObject | null;
    navMeshBvTree: DebugObject | null;
    navMesh: DebugObject | null;
    navMeshLinks: DebugObject | null;
} = {
    triangleAreaIds: null,
    heightfield: null,
    compactHeightfieldSolid: null,
    compactHeightfieldDistances: null,
    compactHeightfieldRegions: null,
    rawContours: null,
    simplifiedContours: null,
    polyMesh: null,
    polyMeshDetail: null,
    navMeshBvTree: null,
    navMesh: null,
    navMeshLinks: null,
};

function clearDebugHelpers() {
    Object.values(debugHelpers).forEach((helper) => {
        if (helper) {
            scene.remove(helper.object);
            helper.dispose();
        }
    });

    // Reset all references
    debugHelpers.triangleAreaIds = null;
    debugHelpers.heightfield = null;
    debugHelpers.compactHeightfieldSolid = null;
    debugHelpers.compactHeightfieldDistances = null;
    debugHelpers.compactHeightfieldRegions = null;
    debugHelpers.rawContours = null;
    debugHelpers.simplifiedContours = null;
    debugHelpers.polyMesh = null;
    debugHelpers.polyMeshDetail = null;
    debugHelpers.navMeshBvTree = null;
    debugHelpers.navMesh = null;
    debugHelpers.navMeshLinks = null;
}

function updateDebugHelpers() {
    if (!result) return;

    const { navMesh, intermediates } = result;

    // Clear existing helpers
    clearDebugHelpers();

    // Create debug helpers based on current config
    if (debugConfig.showTriangleAreaIds) {
        debugHelpers.triangleAreaIds = createTriangleAreaIdsHelper(intermediates.input, intermediates.triAreaIds);
        scene.add(debugHelpers.triangleAreaIds.object);
    }

    if (debugConfig.showHeightfield) {
        debugHelpers.heightfield = createHeightfieldHelper(intermediates.heightfield);
        scene.add(debugHelpers.heightfield.object);
    }

    if (debugConfig.showCompactHeightfieldSolid) {
        debugHelpers.compactHeightfieldSolid = createCompactHeightfieldSolidHelper(intermediates.compactHeightfield);
        scene.add(debugHelpers.compactHeightfieldSolid.object);
    }

    if (debugConfig.showCompactHeightfieldDistances) {
        debugHelpers.compactHeightfieldDistances = createCompactHeightfieldDistancesHelper(intermediates.compactHeightfield);
        scene.add(debugHelpers.compactHeightfieldDistances.object);
    }

    if (debugConfig.showCompactHeightfieldRegions) {
        debugHelpers.compactHeightfieldRegions = createCompactHeightfieldRegionsHelper(intermediates.compactHeightfield);
        scene.add(debugHelpers.compactHeightfieldRegions.object);
    }

    if (debugConfig.showRawContours) {
        debugHelpers.rawContours = createRawContoursHelper(intermediates.contourSet);
        scene.add(debugHelpers.rawContours.object);
    }

    if (debugConfig.showSimplifiedContours) {
        debugHelpers.simplifiedContours = createSimplifiedContoursHelper(intermediates.contourSet);
        scene.add(debugHelpers.simplifiedContours.object);
    }

    if (debugConfig.showPolyMesh) {
        debugHelpers.polyMesh = createPolyMeshHelper(intermediates.polyMesh);
        scene.add(debugHelpers.polyMesh.object);
    }

    if (debugConfig.showPolyMeshDetail) {
        debugHelpers.polyMeshDetail = createPolyMeshDetailHelper(intermediates.polyMeshDetail);
        scene.add(debugHelpers.polyMeshDetail.object);
    }

    if (debugConfig.showNavMeshBvTree) {
        debugHelpers.navMeshBvTree = createNavMeshBvTreeHelper(navMesh);
        scene.add(debugHelpers.navMeshBvTree.object);
    }

    if (debugConfig.showNavMesh) {
        debugHelpers.navMesh = createNavMeshHelper(navMesh);
        debugHelpers.navMesh.object.position.y += 0.1;
        scene.add(debugHelpers.navMesh.object);
    }

    if (debugConfig.showNavMeshLinks) {
        debugHelpers.navMeshLinks = createNavMeshLinksHelper(navMesh);
        scene.add(debugHelpers.navMeshLinks.object);
    }
}

function generate() {
    /* clear helpers */
    clearDebugHelpers();

    /* generate navmesh */
    const walkableMeshes: THREE.Mesh[] = [];
    scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
            walkableMeshes.push(object);
        }
    });

    const [positions, indices] = getPositionsAndIndices(walkableMeshes);

    const navMeshInput: SoloNavMeshInput = {
        positions,
        indices,
    };

    const walkableRadiusVoxels = Math.ceil(config.walkableRadiusWorld / config.cellSize);
    const walkableClimbVoxels = Math.ceil(config.walkableClimbWorld / config.cellHeight);
    const walkableHeightVoxels = Math.ceil(config.walkableHeightWorld / config.cellHeight);

    const navMeshConfig: SoloNavMeshOptions = {
        cellSize: config.cellSize,
        cellHeight: config.cellHeight,
        walkableRadiusWorld: config.walkableRadiusWorld,
        walkableRadiusVoxels,
        walkableClimbWorld: config.walkableClimbWorld,
        walkableClimbVoxels,
        walkableHeightWorld: config.walkableHeightWorld,
        walkableHeightVoxels,
        walkableSlopeAngleDegrees: config.walkableSlopeAngleDegrees,
        borderSize: config.borderSize,
        minRegionArea: config.minRegionArea,
        mergeRegionArea: config.mergeRegionArea,
        maxSimplificationError: config.maxSimplificationError,
        maxEdgeLength: config.maxEdgeLength,
        maxVerticesPerPoly: config.maxVerticesPerPoly,
        detailSampleDistance: config.detailSampleDistance,
        detailSampleMaxError: config.detailSampleMaxError,
    };

    result = generateSoloNavMesh(navMeshInput, navMeshConfig);

    console.log(result);

    /* update helpers */
    updateDebugHelpers();
}

gui.add({ generate }, 'generate').name('Generate NavMesh');

// generate initial navmesh
generate();

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
