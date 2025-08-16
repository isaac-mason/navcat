import GUI from 'lil-gui';
import { three as threeUtils } from 'nav3d';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createExample } from './common/example-boilerplate';
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

/* navmesh generation parameters */
const config = {
    cellSize: 0.15,
    cellHeight: 0.15,
    tileSizeVoxels: 32,
    walkableRadiusWorld: 0.1,
    walkableClimbWorld: 0.5,
    walkableHeightWorld: 0.25,
    walkableSlopeAngleDegrees: 45,
    borderSize: 4,
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
    showNavMeshPortals: false,
};

/* setup gui */
const gui = new GUI();
gui.title('Tiled NavMesh Generation');

const cellFolder = gui.addFolder('Heightfield');
cellFolder.add(config, 'cellSize', 0.01, 1, 0.01);
cellFolder.add(config, 'cellHeight', 0.01, 1, 0.01);

const tileFolder = gui.addFolder('Tile');
tileFolder.add(config, 'tileSizeVoxels', 8, 128, 1);

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
detailFolder.add(config, 'detailSampleDistance', 0, 16, 1);
detailFolder.add(config, 'detailSampleMaxError', 0, 16, 1);

const debugFolder = gui.addFolder('Debug Helpers');
debugFolder
    .add(debugConfig, 'showMesh')
    .name('Show Mesh')
    .onChange(() => {
        navTestModel.scene.visible = debugConfig.showMesh;
    });
debugFolder
    .add(debugConfig, 'showTriangleAreaIds')
    .name('Triangle Area IDs')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showHeightfield')
    .name('Heightfield')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showCompactHeightfieldSolid')
    .name('Compact Heightfield Solid')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showCompactHeightfieldDistances')
    .name('Compact Heightfield Distances')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showCompactHeightfieldRegions')
    .name('Compact Heightfield Regions')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showRawContours')
    .name('Raw Contours')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showSimplifiedContours')
    .name('Simplified Contours')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showPolyMesh')
    .name('Poly Mesh')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showPolyMeshDetail')
    .name('Poly Mesh Detail')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showNavMeshBvTree')
    .name('NavMesh BV Tree')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showNavMesh')
    .name('NavMesh')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showNavMeshLinks')
    .name('NavMesh Links')
    .onChange(updateDebugHelpers);
debugFolder
    .add(debugConfig, 'showNavMeshPortals')
    .name('NavMesh Portals')
    .onChange(updateDebugHelpers);

let currentResult: ReturnType<typeof generateTiledNavMesh> | null = null;

// Debug helper objects - arrays to hold helpers for each tile
const debugHelpers: {
    triangleAreaIds: threeUtils.DebugObject[];
    heightfield: threeUtils.DebugObject[];
    compactHeightfieldSolid: threeUtils.DebugObject[];
    compactHeightfieldDistances: threeUtils.DebugObject[];
    compactHeightfieldRegions: threeUtils.DebugObject[];
    rawContours: threeUtils.DebugObject[];
    simplifiedContours: threeUtils.DebugObject[];
    polyMesh: threeUtils.DebugObject[];
    polyMeshDetail: threeUtils.DebugObject[];
    navMeshBvTree: threeUtils.DebugObject | null;
    navMesh: threeUtils.DebugObject | null;
    navMeshLinks: threeUtils.DebugObject | null;
    navMeshPortals: threeUtils.DebugObject | null;
} = {
    triangleAreaIds: [],
    heightfield: [],
    compactHeightfieldSolid: [],
    compactHeightfieldDistances: [],
    compactHeightfieldRegions: [],
    rawContours: [],
    simplifiedContours: [],
    polyMesh: [],
    polyMeshDetail: [],
    navMeshBvTree: null,
    navMesh: null,
    navMeshLinks: null,
    navMeshPortals: null,
};

function clearDebugHelpers() {
    for (const key in debugHelpers) {
        const helper = debugHelpers[key as keyof typeof debugHelpers];

        if (Array.isArray(helper)) {
            helper.forEach((item) => {
                if (item) {
                    scene.remove(item.object);
                    item.dispose();
                }
            });
            helper.length = 0;
        } else if (helper) {
            scene.remove(helper.object);
            helper.dispose();
        }
    }
}

function updateDebugHelpers() {
    if (!currentResult) return;

    const { navMesh, intermediates } = currentResult;

    // clear existing helpers
    clearDebugHelpers();

    // create debug helpers for each tile based on current config
    if (debugConfig.showTriangleAreaIds) {
        intermediates.triAreaIds.forEach((triAreaIds) => {
            const helper = threeUtils.createTriangleAreaIdsHelper(
                intermediates.input,
                triAreaIds,
            );
            debugHelpers.triangleAreaIds.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showHeightfield) {
        intermediates.heightfield.forEach((heightfield) => {
            const helper = threeUtils.createHeightfieldHelper(heightfield);
            debugHelpers.heightfield.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showCompactHeightfieldSolid) {
        intermediates.compactHeightfield.forEach((compactHeightfield) => {
            const helper =
                threeUtils.createCompactHeightfieldSolidHelper(
                    compactHeightfield,
                );
            debugHelpers.compactHeightfieldSolid.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showCompactHeightfieldDistances) {
        intermediates.compactHeightfield.forEach((compactHeightfield) => {
            const helper =
                threeUtils.createCompactHeightfieldDistancesHelper(
                    compactHeightfield,
                );
            debugHelpers.compactHeightfieldDistances.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showCompactHeightfieldRegions) {
        intermediates.compactHeightfield.forEach((compactHeightfield) => {
            const helper =
                threeUtils.createCompactHeightfieldRegionsHelper(
                    compactHeightfield,
                );
            debugHelpers.compactHeightfieldRegions.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showRawContours) {
        intermediates.contourSet.forEach((contourSet) => {
            const helper = threeUtils.createRawContoursHelper(contourSet);
            debugHelpers.rawContours.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showSimplifiedContours) {
        intermediates.contourSet.forEach((contourSet) => {
            const helper =
                threeUtils.createSimplifiedContoursHelper(contourSet);
            debugHelpers.simplifiedContours.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showPolyMesh) {
        intermediates.polyMesh.forEach((polyMesh) => {
            const helper = threeUtils.createPolyMeshHelper(polyMesh);
            debugHelpers.polyMesh.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showPolyMeshDetail) {
        intermediates.polyMeshDetail.forEach((polyMeshDetail) => {
            const helper =
                threeUtils.createPolyMeshDetailHelper(polyMeshDetail);
            debugHelpers.polyMeshDetail.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showNavMeshBvTree) {
        debugHelpers.navMeshBvTree =
            threeUtils.createNavMeshBvTreeHelper(navMesh);
        scene.add(debugHelpers.navMeshBvTree.object);
    }

    if (debugConfig.showNavMesh) {
        debugHelpers.navMesh = threeUtils.createNavMeshHelper(navMesh);
        debugHelpers.navMesh.object.position.y += 0.1;
        scene.add(debugHelpers.navMesh.object);
    }

    if (debugConfig.showNavMeshLinks) {
        debugHelpers.navMeshLinks =
            threeUtils.createNavMeshLinksHelper(navMesh);
        scene.add(debugHelpers.navMeshLinks.object);
    }

    if (debugConfig.showNavMeshPortals) {
        debugHelpers.navMeshPortals =
            threeUtils.createNavMeshPortalsHelper(navMesh);
        scene.add(debugHelpers.navMeshPortals.object);
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

    const [positions, indices] =
        threeUtils.getPositionsAndIndices(walkableMeshes);

    const navMeshInput: TiledNavMeshInput = {
        positions,
        indices,
    };

    const tileSizeWorld = config.tileSizeVoxels * config.cellSize;
    const walkableRadiusVoxels = Math.ceil(
        config.walkableRadiusWorld / config.cellSize,
    );
    const walkableClimbVoxels = Math.ceil(
        config.walkableClimbWorld / config.cellHeight,
    );
    const walkableHeightVoxels = Math.ceil(
        config.walkableHeightWorld / config.cellHeight,
    );

    const navMeshConfig: TiledNavMeshOptions = {
        cellSize: config.cellSize,
        cellHeight: config.cellHeight,
        tileSizeVoxels: config.tileSizeVoxels,
        tileSizeWorld,
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

    currentResult = generateTiledNavMesh(navMeshInput, navMeshConfig);

    /* create debug helpers */
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
