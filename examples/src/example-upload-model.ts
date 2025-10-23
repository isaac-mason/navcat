import GUI from 'lil-gui';
import type { Vec3 } from 'mathcat';
import { DEFAULT_QUERY_FILTER, FindStraightPathResultFlags, findNearestPoly, findPath, getNodeRefType, NodeType } from 'navcat';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
import {
    createCompactHeightfieldDistancesHelper,
    createCompactHeightfieldRegionsHelper,
    createCompactHeightfieldSolidHelper,
    createHeightfieldHelper,
    createNavMeshBvTreeHelper,
    createNavMeshHelper,
    createNavMeshLinksHelper,
    createNavMeshPolyHelper,
    createNavMeshPortalsHelper,
    createPolyMeshDetailHelper,
    createPolyMeshHelper,
    createRawContoursHelper,
    createSearchNodesHelper,
    createSimplifiedContoursHelper,
    createTriangleAreaIdsHelper,
    type DebugObject,
} from 'navcat/three';
import { createExample } from './common/example-base';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { generateSoloNavMesh, type SoloNavMeshInput, type SoloNavMeshOptions } from 'navcat/blocks';
import { getPositionsAndIndices } from 'navcat/three';
import { loadGLTF } from './common/load-gltf';

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

// Add grid helper for reference
const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
scene.add(gridHelper);

/* state variables */
let currentModel: THREE.Group | null = null;
let walkableMeshes: THREE.Mesh[] = [];

/* tool state */
type ToolType = 'pathfinding' | 'query';

const toolConfig = {
    activeTool: 'pathfinding' as ToolType,
};

/* pathfinding tool state */
const pathfindingConfig = {
    halfExtentsX: 1,
    halfExtentsY: 1,
    halfExtentsZ: 1,
    showSearchNodes: false,
};

let pathStart: Vec3 | null = null;
let pathEnd: Vec3 | null = null;
type PathVisual = { object: THREE.Object3D; dispose: () => void };
let pathVisuals: PathVisual[] = [];

/* query tool state */
const queryConfig = {
    mode: 'click' as 'click' | 'hover',
    halfExtentsX: 1,
    halfExtentsY: 1,
    halfExtentsZ: 1,
};

type QueryVisual = { object: THREE.Object3D; dispose: () => void };
let queryVisuals: QueryVisual[] = [];

/* unified navmesh generation configuration */
type NavMeshType = 'solo' | 'tiled';

const config = {
    // NavMesh type
    navmeshType: 'solo' as NavMeshType,

    // Heightfield parameters
    cellSize: 0.15,
    cellHeight: 0.25,

    // Tiled-specific parameters
    tileSizeVoxels: 32,

    // Agent parameters
    walkableRadiusWorld: 0.3,
    walkableClimbWorld: 0.4,
    walkableHeightWorld: 2,
    walkableSlopeAngleDegrees: 45,

    // Region parameters
    // Note: borderSize is 0 for solo, 4 for tiled (we'll handle this dynamically)
    borderSize: 0,
    minRegionArea: 8,
    mergeRegionArea: 20,

    // Contour parameters
    maxSimplificationError: 1.3,
    maxEdgeLength: 12,

    // PolyMesh parameters
    maxVerticesPerPoly: 5,

    // Detail parameters (in voxels)
    detailSampleDistanceVoxels: 6,
    detailSampleMaxErrorVoxels: 1,
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
let gui = new GUI();

function buildGUI() {
    // Clear existing controllers
    gui.destroy();
    gui = new GUI();

    // Actions
    gui.add({ generate }, 'generate').name('Generate NavMesh');
    gui.add({ resetCamera }, 'resetCamera').name('Reset Camera');
    gui.add({ copyShareURL }, 'copyShareURL').name('Copy Share URL');

    gui.title(`${config.navmeshType === 'solo' ? 'Solo' : 'Tiled'} NavMesh Generation`);

    // Close GUI if no model is loaded
    if (!currentModel) {
        gui.close();
    }

    // NavMesh Type Selector
    const typeFolder = gui.addFolder('NavMesh Type');
    typeFolder
        .add(config, 'navmeshType', ['solo', 'tiled'])
        .name('Type')
        .onChange(() => {
            // Update borderSize based on type
            config.borderSize = config.navmeshType === 'solo' ? 0 : 4;
            buildGUI();
        });
    typeFolder.open();

    // Heightfield parameters
    const cellFolder = gui.addFolder('Heightfield');
    cellFolder.add(config, 'cellSize', 0.01, 1, 0.01);
    cellFolder.add(config, 'cellHeight', 0.01, 1, 0.01);

    // Tile parameters (only for tiled)
    if (config.navmeshType === 'tiled') {
        const tileFolder = gui.addFolder('Tile');
        tileFolder.add(config, 'tileSizeVoxels', 8, 128, 1);
    }

    // Agent parameters
    const walkableFolder = gui.addFolder('Agent');
    walkableFolder.add(config, 'walkableRadiusWorld', 0, 2, 0.01);
    walkableFolder.add(config, 'walkableClimbWorld', 0, 2, 0.01);
    walkableFolder.add(config, 'walkableHeightWorld', 0, 2, 0.01);
    walkableFolder.add(config, 'walkableSlopeAngleDegrees', 0, 90, 1);

    // Region parameters
    const regionFolder = gui.addFolder('Region');
    regionFolder.add(config, 'borderSize', 0, 10, 1);
    regionFolder.add(config, 'minRegionArea', 0, 50, 1);
    regionFolder.add(config, 'mergeRegionArea', 0, 50, 1);

    // Contour parameters
    const contourFolder = gui.addFolder('Contour');
    contourFolder.add(config, 'maxSimplificationError', 0.1, 10, 0.1);
    contourFolder.add(config, 'maxEdgeLength', 0, 50, 1);

    // PolyMesh parameters
    const polyMeshFolder = gui.addFolder('PolyMesh');
    polyMeshFolder.add(config, 'maxVerticesPerPoly', 3, 12, 1);

    // Detail parameters
    const detailFolder = gui.addFolder('Detail');
    detailFolder.add(config, 'detailSampleDistanceVoxels', 0, 16, 0.1).name('Sample Distance (voxels)');
    detailFolder.add(config, 'detailSampleMaxErrorVoxels', 0, 16, 0.1).name('Max Error (voxels)');

    // Debug Helpers
    const debugFolder = gui.addFolder('Debug Helpers');
    debugFolder
        .add(debugConfig, 'showMesh')
        .name('Show Mesh')
        .onChange(() => {
            if (currentModel) {
                currentModel.visible = debugConfig.showMesh;
            }
        });
    debugFolder.add(debugConfig, 'showTriangleAreaIds').name('Triangle Area IDs').onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showHeightfield').name('Heightfield').onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showCompactHeightfieldSolid').name('Compact Heightfield Solid').onChange(updateDebugHelpers);
    debugFolder
        .add(debugConfig, 'showCompactHeightfieldDistances')
        .name('Compact Heightfield Distances')
        .onChange(updateDebugHelpers);
    debugFolder
        .add(debugConfig, 'showCompactHeightfieldRegions')
        .name('Compact Heightfield Regions')
        .onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showRawContours').name('Raw Contours').onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showSimplifiedContours').name('Simplified Contours').onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showPolyMesh').name('Poly Mesh').onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showPolyMeshDetail').name('Poly Mesh Detail').onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showNavMeshBvTree').name('NavMesh BV Tree').onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showNavMesh').name('NavMesh').onChange(updateDebugHelpers);
    debugFolder.add(debugConfig, 'showNavMeshLinks').name('NavMesh Links').onChange(updateDebugHelpers);
    if (config.navmeshType === 'tiled') {
        debugFolder.add(debugConfig, 'showNavMeshPortals').name('NavMesh Portals').onChange(updateDebugHelpers);
    }

    // Tools (only show if model is loaded)
    if (currentModel) {
        const toolFolder = gui.addFolder('🛠️ Tools');
        toolFolder
            .add(toolConfig, 'activeTool', ['none', 'pathfinding', 'query'])
            .name('Active Tool')
            .onChange((tool: ToolType) => {
                // Explicitly set the value to ensure it's updated before rebuilding
                toolConfig.activeTool = tool;

                // Clear all tool visuals
                clearPathVisuals();
                clearQueryVisuals();

                // Hide all info panels
                document.getElementById('pathfinding-info')!.classList.remove('visible');
                document.getElementById('query-info')!.classList.remove('visible');

                // Show appropriate info panel
                if (tool === 'pathfinding') {
                    document.getElementById('pathfinding-info')!.classList.add('visible');
                } else if (tool === 'query') {
                    document.getElementById('query-info')!.classList.add('visible');
                }

                // Rebuild GUI to show tool-specific controls
                buildGUI();
            });

        // Show tool-specific controls based on active tool
        if (toolConfig.activeTool === 'pathfinding') {
            const pathfindingFolder = toolFolder.addFolder('🎯 Pathfinding Settings');
            pathfindingFolder.add(pathfindingConfig, 'halfExtentsX', 0.1, 5, 0.1).name('Half Extents X');
            pathfindingFolder.add(pathfindingConfig, 'halfExtentsY', 0.1, 5, 0.1).name('Half Extents Y');
            pathfindingFolder.add(pathfindingConfig, 'halfExtentsZ', 0.1, 5, 0.1).name('Half Extents Z');
            pathfindingFolder.add(pathfindingConfig, 'showSearchNodes').name('Show Search Nodes').onChange(updatePath);
            pathfindingFolder.add({ clearPath: clearPathVisuals }, 'clearPath').name('Clear Path');
            pathfindingFolder.open();
        } else if (toolConfig.activeTool === 'query') {
            const queryFolder = toolFolder.addFolder('🔍 Query Settings');
            queryFolder.add(queryConfig, 'mode', ['click', 'hover']).name('Mode');
            queryFolder.add(queryConfig, 'halfExtentsX', 0.1, 5, 0.1).name('Half Extents X');
            queryFolder.add(queryConfig, 'halfExtentsY', 0.1, 5, 0.1).name('Half Extents Y');
            queryFolder.add(queryConfig, 'halfExtentsZ', 0.1, 5, 0.1).name('Half Extents Z');
            queryFolder.open();
        }

        toolFolder.open();
    }
}

buildGUI();

/* navmesh generation state */
let currentResult: ReturnType<typeof generateSoloNavMesh> | ReturnType<typeof generateTiledNavMesh> | null = null;

// Debug helper objects - always arrays (solo pushes 1 item, tiled pushes multiple)
const debugHelpers: {
    triangleAreaIds: DebugObject[];
    heightfield: DebugObject[];
    compactHeightfieldSolid: DebugObject[];
    compactHeightfieldDistances: DebugObject[];
    compactHeightfieldRegions: DebugObject[];
    rawContours: DebugObject[];
    simplifiedContours: DebugObject[];
    polyMesh: DebugObject[];
    polyMeshDetail: DebugObject[];
    navMeshBvTree: DebugObject | null;
    navMesh: DebugObject | null;
    navMeshLinks: DebugObject | null;
    navMeshPortals: DebugObject | null;
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

    // Handle both solo (single values) and tiled (arrays) intermediates
    // For solo: wrap in array. For tiled: already arrays
    const triAreaIdsArray = Array.isArray(intermediates.triAreaIds) ? intermediates.triAreaIds : [intermediates.triAreaIds];
    const heightfieldArray = Array.isArray(intermediates.heightfield) ? intermediates.heightfield : [intermediates.heightfield];
    const compactHeightfieldArray = Array.isArray(intermediates.compactHeightfield)
        ? intermediates.compactHeightfield
        : [intermediates.compactHeightfield];
    const contourSetArray = Array.isArray(intermediates.contourSet) ? intermediates.contourSet : [intermediates.contourSet];
    const polyMeshArray = Array.isArray(intermediates.polyMesh) ? intermediates.polyMesh : [intermediates.polyMesh];
    const polyMeshDetailArray = Array.isArray(intermediates.polyMeshDetail)
        ? intermediates.polyMeshDetail
        : [intermediates.polyMeshDetail];

    // create debug helpers
    if (debugConfig.showTriangleAreaIds) {
        triAreaIdsArray.forEach((triAreaIds) => {
            const helper = createTriangleAreaIdsHelper(intermediates.input, triAreaIds);
            debugHelpers.triangleAreaIds.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showHeightfield) {
        heightfieldArray.forEach((heightfield) => {
            const helper = createHeightfieldHelper(heightfield);
            debugHelpers.heightfield.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showCompactHeightfieldSolid) {
        compactHeightfieldArray.forEach((compactHeightfield) => {
            const helper = createCompactHeightfieldSolidHelper(compactHeightfield);
            debugHelpers.compactHeightfieldSolid.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showCompactHeightfieldDistances) {
        compactHeightfieldArray.forEach((compactHeightfield) => {
            const helper = createCompactHeightfieldDistancesHelper(compactHeightfield);
            debugHelpers.compactHeightfieldDistances.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showCompactHeightfieldRegions) {
        compactHeightfieldArray.forEach((compactHeightfield) => {
            const helper = createCompactHeightfieldRegionsHelper(compactHeightfield);
            debugHelpers.compactHeightfieldRegions.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showRawContours) {
        contourSetArray.forEach((contourSet) => {
            const helper = createRawContoursHelper(contourSet);
            debugHelpers.rawContours.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showSimplifiedContours) {
        contourSetArray.forEach((contourSet) => {
            const helper = createSimplifiedContoursHelper(contourSet);
            debugHelpers.simplifiedContours.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showPolyMesh) {
        polyMeshArray.forEach((polyMesh) => {
            const helper = createPolyMeshHelper(polyMesh);
            debugHelpers.polyMesh.push(helper);
            scene.add(helper.object);
        });
    }

    if (debugConfig.showPolyMeshDetail) {
        polyMeshDetailArray.forEach((polyMeshDetail) => {
            const helper = createPolyMeshDetailHelper(polyMeshDetail);
            debugHelpers.polyMeshDetail.push(helper);
            scene.add(helper.object);
        });
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

    if (debugConfig.showNavMeshPortals) {
        debugHelpers.navMeshPortals = createNavMeshPortalsHelper(navMesh);
        scene.add(debugHelpers.navMeshPortals.object);
    }
}

/* pathfinding functions */
function clearPathVisuals() {
    for (const visual of pathVisuals) {
        scene.remove(visual.object);
        visual.dispose();
    }
    pathVisuals = [];

    // Update info panel (only if elements exist)
    const pathStartEl = document.getElementById('path-start');
    const pathEndEl = document.getElementById('path-end');
    const pathWaypoints = document.getElementById('path-waypoints');
    const pathLength = document.getElementById('path-length');
    const pathPartial = document.getElementById('path-partial');
    const pathTime = document.getElementById('path-time');

    if (pathStartEl) pathStartEl.textContent = 'Not set';
    if (pathEndEl) pathEndEl.textContent = 'Not set';
    if (pathWaypoints) pathWaypoints.textContent = '-';
    if (pathLength) pathLength.textContent = '-';
    if (pathPartial) pathPartial.textContent = '-';
    if (pathTime) pathTime.textContent = '-';
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

function addPathVisual(visual: PathVisual) {
    pathVisuals.push(visual);
    scene.add(visual.object);
}

function updatePath() {
    if (!currentResult) return;

    // Save start and end before clearing (clearPathVisuals sets them to null)
    const start = pathStart;
    const end = pathEnd;

    clearPathVisuals();

    const { navMesh } = currentResult;

    // Create start flag if start point is set
    if (start) {
        const startFlag = createFlag(0x2196f3);
        startFlag.position.set(...start);
        addPathVisual({
            object: startFlag,
            dispose: () => {
                startFlag.traverse((child) => {
                    if (child instanceof THREE.Mesh) {
                        child.geometry?.dispose();
                        if (Array.isArray(child.material)) {
                            for (const mat of child.material) {
                                mat?.dispose?.();
                            }
                        } else {
                            child.material?.dispose?.();
                        }
                    }
                });
            },
        });
    }

    // Create end flag if end point is set
    if (end) {
        const endFlag = createFlag(0x00ff00);
        endFlag.position.set(...end);
        addPathVisual({
            object: endFlag,
            dispose: () => {
                endFlag.traverse((child) => {
                    if (child instanceof THREE.Mesh) {
                        child.geometry?.dispose();
                        if (Array.isArray(child.material)) {
                            for (const mat of child.material) {
                                mat?.dispose?.();
                            }
                        } else {
                            child.material?.dispose?.();
                        }
                    }
                });
            },
        });
    }

    // Only compute path if both start and end are set
    if (!start || !end) {
        // Restore start and end points (clearPathVisuals set them to null)
        pathStart = start;
        pathEnd = end;
        return;
    }

    // Find path
    const halfExtents: Vec3 = [pathfindingConfig.halfExtentsX, pathfindingConfig.halfExtentsY, pathfindingConfig.halfExtentsZ];

    const startTime = performance.now();
    const pathResult = findPath(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER);
    const endTime = performance.now();

    const { path, nodePath } = pathResult;

    // Show search nodes
    if (pathfindingConfig.showSearchNodes && nodePath) {
        const searchNodesHelper = createSearchNodesHelper(nodePath.nodes);
        addPathVisual(searchNodesHelper);

        for (let i = 0; i < nodePath.path.length; i++) {
            const node = nodePath.path[i];
            if (getNodeRefType(node) === NodeType.POLY) {
                const polyHelper = createNavMeshPolyHelper(navMesh, node);
                polyHelper.object.position.y += 0.15;
                addPathVisual(polyHelper);
            }
        }
    }

    // Visualize path
    if (path) {
        let pathLength = 0;

        for (let i = 0; i < path.length; i++) {
            const point = path[i];

            // Waypoint sphere
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
            mesh.position.set(...point.position);
            addPathVisual({
                object: mesh,
                dispose: () => {
                    mesh.geometry?.dispose();
                    mesh.material?.dispose?.();
                },
            });

            // Line to previous point
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
                addPathVisual({
                    object: line,
                    dispose: () => {
                        line.geometry?.dispose();
                        line.material?.dispose?.();
                    },
                });

                // Calculate path length
                const dx = point.position[0] - prevPoint.position[0];
                const dy = point.position[1] - prevPoint.position[1];
                const dz = point.position[2] - prevPoint.position[2];
                pathLength += Math.sqrt(dx * dx + dy * dy + dz * dz);
            }
        }

        // Update info panel
        const pathWaypointsEl = document.getElementById('path-waypoints');
        const pathLengthEl = document.getElementById('path-length');
        const pathPartialEl = document.getElementById('path-partial');
        const pathTimeEl = document.getElementById('path-time');

        if (pathWaypointsEl) pathWaypointsEl.textContent = path.length.toString();
        if (pathLengthEl) pathLengthEl.textContent = pathLength.toFixed(2);
        if (pathPartialEl)
            pathPartialEl.textContent =
                (pathResult.straightPathFlags & FindStraightPathResultFlags.PARTIAL_PATH) !== 0 ? 'Yes' : 'No';
        if (pathTimeEl) pathTimeEl.textContent = `${(endTime - startTime).toFixed(2)}ms`;
    }
}

/* query tool functions */
function clearQueryVisuals() {
    for (const visual of queryVisuals) {
        scene.remove(visual.object);
        visual.dispose();
    }
    queryVisuals = [];

    // Update info panel (only if elements exist)
    const queryPoint = document.getElementById('query-point');
    const queryNearest = document.getElementById('query-nearest');
    const queryDistance = document.getElementById('query-distance');
    const queryRef = document.getElementById('query-ref');

    if (queryPoint) queryPoint.textContent = '-';
    if (queryNearest) queryNearest.textContent = '-';
    if (queryDistance) queryDistance.textContent = '-';
    if (queryRef) queryRef.textContent = '-';
}

function addQueryVisual(visual: QueryVisual) {
    queryVisuals.push(visual);
    scene.add(visual.object);
}

function updateQuery(point: THREE.Vector3) {
    if (toolConfig.activeTool !== 'query' || !currentResult) return;

    clearQueryVisuals();

    const { navMesh } = currentResult;
    const pos: Vec3 = [point.x, point.y, point.z];
    const halfExtents: Vec3 = [queryConfig.halfExtentsX, queryConfig.halfExtentsY, queryConfig.halfExtentsZ];

    const result = { success: false, ref: 0, point: [0, 0, 0] as Vec3 };
    findNearestPoly(result, navMesh, pos, halfExtents, DEFAULT_QUERY_FILTER);

    if (result.success) {
        // Show the poly
        const polyHelper = createNavMeshPolyHelper(navMesh, result.ref);
        polyHelper.object.position.y += 0.1;
        addQueryVisual(polyHelper);

        // Update info panel
        const queryPoint = document.getElementById('query-point');
        const queryNearest = document.getElementById('query-nearest');
        const queryDistance = document.getElementById('query-distance');
        const queryRef = document.getElementById('query-ref');

        if (queryPoint) {
            queryPoint.textContent = `${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}, ${pos[2].toFixed(2)}`;
        }
        if (queryNearest) {
            queryNearest.textContent = `${result.point[0].toFixed(2)}, ${result.point[1].toFixed(2)}, ${result.point[2].toFixed(2)}`;
        }
        if (queryDistance) {
            queryDistance.textContent = Math.sqrt(
                Math.pow(result.point[0] - pos[0], 2) +
                    Math.pow(result.point[1] - pos[1], 2) +
                    Math.pow(result.point[2] - pos[2], 2),
            ).toFixed(3);
        }
        if (queryRef) queryRef.textContent = result.ref.toString();
    } else {
        const queryPoint = document.getElementById('query-point');
        const queryNearest = document.getElementById('query-nearest');
        const queryDistance = document.getElementById('query-distance');
        const queryRef = document.getElementById('query-ref');

        if (queryPoint) {
            queryPoint.textContent = `${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}, ${pos[2].toFixed(2)}`;
        }
        if (queryNearest) queryNearest.textContent = 'Not found';
        if (queryDistance) queryDistance.textContent = '-';
        if (queryRef) queryRef.textContent = '-';
    }
}

function generate() {
    /* check if model is loaded */
    if (!currentModel) {
        showStatus('Please load a model first', 'error');
        return;
    }

    try {
        showLoading('Generating navmesh...');

        /* clear helpers */
        clearDebugHelpers();

        /* collect walkable meshes */
        walkableMeshes = [];
        currentModel.traverse((object) => {
            if (object instanceof THREE.Mesh) {
                walkableMeshes.push(object);
            }
        });

        if (walkableMeshes.length === 0) {
            hideLoading();
            showStatus('No meshes found in model', 'error');
            return;
        }

        const [positions, indices] = getPositionsAndIndices(walkableMeshes);

        // Calculate voxel values from world values
        const walkableRadiusVoxels = Math.ceil(config.walkableRadiusWorld / config.cellSize);
        const walkableClimbVoxels = Math.ceil(config.walkableClimbWorld / config.cellHeight);
        const walkableHeightVoxels = Math.ceil(config.walkableHeightWorld / config.cellHeight);

        // Detail mesh parameters: convert voxel units to world units
        const detailSampleDistance =
            config.detailSampleDistanceVoxels < 0.9 ? 0 : config.cellSize * config.detailSampleDistanceVoxels;
        const detailSampleMaxError = config.cellHeight * config.detailSampleMaxErrorVoxels;

        const startTime = performance.now();

        if (config.navmeshType === 'solo') {
            /* Generate Solo NavMesh */
            const navMeshInput: SoloNavMeshInput = {
                positions,
                indices,
            };

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
                detailSampleDistance,
                detailSampleMaxError,
            };

            currentResult = generateSoloNavMesh(navMeshInput, navMeshConfig);
        } else {
            /* Generate Tiled NavMesh */
            const navMeshInput: TiledNavMeshInput = {
                positions,
                indices,
            };

            const tileSizeWorld = config.tileSizeVoxels * config.cellSize;

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
                detailSampleDistance,
                detailSampleMaxError,
            };

            currentResult = generateTiledNavMesh(navMeshInput, navMeshConfig);
        }

        console.log(currentResult);

        const endTime = performance.now();
        const generationTime = endTime - startTime;

        /* create debug helpers */
        updateDebugHelpers();

        /* update performance metrics */
        updatePerformanceMetrics(generationTime, positions.length / 3, indices.length / 3);

        hideLoading();
        showStatus(`${config.navmeshType === 'solo' ? 'Solo' : 'Tiled'} navmesh generated successfully`, 'success');
    } catch (error) {
        hideLoading();
        console.error('Error generating navmesh:', error);
        showStatus('Failed to generate navmesh. Check console for details.', 'error');
    }
}

gui.add({ generate }, 'generate').name('Generate NavMesh');

/* utility functions */
function showStatus(message: string, type: 'success' | 'error' | 'info' = 'info') {
    const statusEl = document.getElementById('status-message')!;
    statusEl.textContent = message;
    statusEl.className = `visible ${type}`;
    setTimeout(() => {
        statusEl.classList.remove('visible');
    }, 3000);
}

function showLoading(message: string) {
    const loadingEl = document.getElementById('loading-spinner')!;
    const textEl = document.getElementById('loading-text')!;
    textEl.textContent = message;
    loadingEl.classList.add('visible');
}

function hideLoading() {
    const loadingEl = document.getElementById('loading-spinner')!;
    loadingEl.classList.remove('visible');
}

function updateDropZoneVisibility() {
    const dropZone = document.getElementById('drop-zone')!;
    if (currentModel) {
        dropZone.classList.add('hidden');
    } else {
        dropZone.classList.remove('hidden');
    }
}

function updatePerformanceMetrics(generationTime: number, vertexCount: number, triangleCount: number) {
    if (!currentResult) return;

    const perfPanel = document.getElementById('performance-info')!;
    const { navMesh } = currentResult;

    // Show the panel
    perfPanel.classList.add('visible');

    // Update type
    document.getElementById('perf-type')!.textContent = config.navmeshType === 'solo' ? 'Solo' : 'Tiled';

    // Update generation time
    document.getElementById('perf-time')!.textContent = `${generationTime.toFixed(2)}ms`;

    // Update triangle and vertex counts (input mesh stats)
    document.getElementById('perf-triangles')!.textContent = triangleCount.toFixed(0);
    document.getElementById('perf-vertices')!.textContent = vertexCount.toFixed(0);

    // Count polygons and tiles
    let polyCount = 0;
    let tileCount = 0;

    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        if (tile) {
            tileCount++;
            polyCount += tile.polys.length;
        }
    }

    document.getElementById('perf-polys')!.textContent = polyCount.toString();

    // For tiled: show tile count
    const tilesRow = document.getElementById('perf-tiles-row')!;
    if (config.navmeshType === 'tiled') {
        document.getElementById('perf-tiles')!.textContent = tileCount.toString();
        tilesRow.style.display = 'flex';
    } else {
        tilesRow.style.display = 'none';
    }
}

/* drag and drop file handling */
const dropZone = document.getElementById('drop-zone')!;
const dragOverlay = document.getElementById('drag-overlay')!;

// Prevent default drag behaviors
document.body.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('active');
    dragOverlay.classList.add('active');
});

document.body.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only hide if we're leaving the document
    if (e.target === document.body) {
        dropZone.classList.remove('active');
        dragOverlay.classList.remove('active');
    }
});

document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    dropZone.classList.remove('active');
    dragOverlay.classList.remove('active');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const fileName = file.name.toLowerCase();

    // Validate file extension
    if (!fileName.endsWith('.glb') && !fileName.endsWith('.gltf')) {
        showStatus('Invalid file type. Please use .glb or .gltf files', 'error');
        return;
    }

    await loadModelFromFile(file);
});

async function loadModelFromFile(file: File) {
    showLoading('Loading model...');

    try {
        // Create object URL for the file
        const url = URL.createObjectURL(file);

        // Load the GLTF model
        const gltf = await loadGLTF(url);

        // Clean up the object URL
        URL.revokeObjectURL(url);

        // Remove previous model if exists
        if (currentModel) {
            scene.remove(currentModel);
            currentModel.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry?.dispose();
                    if (Array.isArray(child.material)) {
                        for (const mat of child.material) {
                            mat?.dispose?.();
                        }
                    } else {
                        child.material?.dispose?.();
                    }
                }
            });
        }

        // Clear previous navmesh
        clearDebugHelpers();
        currentResult = null;

        // Add new model to scene
        currentModel = gltf.scene;
        scene.add(currentModel);

        // Update drop zone visibility
        updateDropZoneVisibility();

        // Fit camera to model
        fitCameraToModel();

        // Rebuild GUI to show tools section and open it
        buildGUI();
        gui.open();

        hideLoading();
        showStatus(`Model loaded: ${file.name}`, 'success');
    } catch (error) {
        hideLoading();
        console.error('Error loading model:', error);
        showStatus('Failed to load model. Please check the file format.', 'error');
    }
}

function fitCameraToModel() {
    if (!currentModel) return;

    // Calculate bounding box
    const box = new THREE.Box3().setFromObject(currentModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // Get the max side of the bounding box
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));

    // Add some padding
    cameraZ *= 1.5;

    // Position camera
    camera.position.set(center.x - cameraZ * 0.5, center.y + cameraZ * 0.5, center.z + cameraZ);
    camera.lookAt(center);

    // Update orbit controls target
    orbitControls.target.copy(center);
    orbitControls.update();
}

function resetCamera() {
    if (currentModel) {
        fitCameraToModel();
    } else {
        camera.position.set(-2, 10, 10);
        camera.lookAt(0, 0, 0);
        orbitControls.target.set(0, 0, 0);
        orbitControls.update();
    }
}

function copyShareURL() {
    const params = new URLSearchParams();

    // Encode essential config
    params.set('navmeshType', config.navmeshType);
    params.set('cellSize', config.cellSize.toString());
    params.set('cellHeight', config.cellHeight.toString());
    params.set('walkableRadiusWorld', config.walkableRadiusWorld.toString());
    params.set('walkableClimbWorld', config.walkableClimbWorld.toString());
    params.set('walkableHeightWorld', config.walkableHeightWorld.toString());
    params.set('walkableSlopeAngleDegrees', config.walkableSlopeAngleDegrees.toString());
    params.set('maxEdgeLength', config.maxEdgeLength.toString());
    params.set('maxSimplificationError', config.maxSimplificationError.toString());
    params.set('minRegionArea', config.minRegionArea.toString());
    params.set('mergeRegionArea', config.mergeRegionArea.toString());
    params.set('maxVerticesPerPoly', config.maxVerticesPerPoly.toString());
    params.set('detailSampleDistanceVoxels', config.detailSampleDistanceVoxels.toString());
    params.set('detailSampleMaxErrorVoxels', config.detailSampleMaxErrorVoxels.toString());
    params.set('borderSize', config.borderSize.toString());

    if (config.navmeshType === 'tiled') {
        params.set('tileSizeVoxels', config.tileSizeVoxels.toString());
    }

    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;

    navigator.clipboard
        .writeText(url)
        .then(() => {
            showStatus('Share URL copied to clipboard!', 'success');
        })
        .catch((err) => {
            console.error('Failed to copy:', err);
            showStatus('Failed to copy URL', 'error');
        });
}

function loadConfigFromURL() {
    const params = new URLSearchParams(window.location.search);

    if (params.has('navmeshType')) {
        config.navmeshType = params.get('navmeshType') as NavMeshType;
    }
    if (params.has('cellSize')) {
        config.cellSize = parseFloat(params.get('cellSize')!);
    }
    if (params.has('cellHeight')) {
        config.cellHeight = parseFloat(params.get('cellHeight')!);
    }
    if (params.has('walkableRadiusWorld')) {
        config.walkableRadiusWorld = parseFloat(params.get('walkableRadiusWorld')!);
    }
    if (params.has('walkableClimbWorld')) {
        config.walkableClimbWorld = parseFloat(params.get('walkableClimbWorld')!);
    }
    if (params.has('walkableHeightWorld')) {
        config.walkableHeightWorld = parseFloat(params.get('walkableHeightWorld')!);
    }
    if (params.has('walkableSlopeAngleDegrees')) {
        config.walkableSlopeAngleDegrees = parseFloat(params.get('walkableSlopeAngleDegrees')!);
    }
    if (params.has('maxEdgeLength')) {
        config.maxEdgeLength = parseFloat(params.get('maxEdgeLength')!);
    }
    if (params.has('maxSimplificationError')) {
        config.maxSimplificationError = parseFloat(params.get('maxSimplificationError')!);
    }
    if (params.has('minRegionArea')) {
        config.minRegionArea = parseFloat(params.get('minRegionArea')!);
    }
    if (params.has('mergeRegionArea')) {
        config.mergeRegionArea = parseFloat(params.get('mergeRegionArea')!);
    }
    if (params.has('maxVerticesPerPoly')) {
        config.maxVerticesPerPoly = parseInt(params.get('maxVerticesPerPoly')!);
    }
    if (params.has('detailSampleDistanceVoxels')) {
        config.detailSampleDistanceVoxels = parseFloat(params.get('detailSampleDistanceVoxels')!);
    }
    if (params.has('detailSampleMaxErrorVoxels')) {
        config.detailSampleMaxErrorVoxels = parseFloat(params.get('detailSampleMaxErrorVoxels')!);
    }
    if (params.has('borderSize')) {
        config.borderSize = parseInt(params.get('borderSize')!, 10);
    }
    if (params.has('tileSizeVoxels')) {
        config.tileSizeVoxels = parseInt(params.get('tileSizeVoxels')!);
    }

    buildGUI();
}

loadConfigFromURL();

/* interaction handlers */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

window.addEventListener('mousedown', (event) => {
    if (!currentModel || !currentResult) return;

    // Calculate pointer position in normalized device coordinates
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Raycast
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObject(currentModel, true);

    if (intersects.length > 0) {
        const point = intersects[0].point;

        // Handle pathfinding tool
        if (toolConfig.activeTool === 'pathfinding') {
            const pos: Vec3 = [point.x, point.y, point.z];

            // Left click (button 0) sets start point
            if (event.button === 0) {
                pathStart = pos;
                const pathStartEl = document.getElementById('path-start');
                if (pathStartEl) pathStartEl.textContent = `${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}, ${pos[2].toFixed(2)}`;
                updatePath();
            }
            // Right click (button 2) sets end point
            else if (event.button === 2) {
                event.preventDefault(); // Prevent context menu
                pathEnd = pos;
                const pathEndEl = document.getElementById('path-end');
                if (pathEndEl) pathEndEl.textContent = `${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}, ${pos[2].toFixed(2)}`;
                updatePath();
            }
        }

        // Handle query tool (click mode) - left click only
        if (toolConfig.activeTool === 'query' && queryConfig.mode === 'click' && event.button === 0) {
            updateQuery(point);
        }
    }
});

window.addEventListener('mousemove', (event) => {
    if (toolConfig.activeTool !== 'query' || queryConfig.mode !== 'hover' || !currentModel || !currentResult) return;

    // Calculate pointer position
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Raycast
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObject(currentModel, true);

    if (intersects.length > 0) {
        updateQuery(intersects[0].point);
    }
});

// Prevent context menu when pathfinding tool is active
window.addEventListener('contextmenu', (event) => {
    if (toolConfig.activeTool === 'pathfinding') {
        event.preventDefault();
    }
});

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
