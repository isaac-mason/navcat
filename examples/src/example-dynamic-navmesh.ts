import Rapier from '@dimforge/rapier3d-compat';
import { GUI } from 'lil-gui';
import { box3, triangle3, type Vec3, vec2, vec3 } from 'mathcat';
import {
    addOffMeshConnection,
    addTile,
    BuildContext,
    buildCompactHeightfield,
    buildContours,
    buildDistanceField,
    buildPolyMesh,
    buildPolyMeshDetail,
    buildRegions,
    buildTile,
    ContourBuildFlags,
    calculateGridSize,
    calculateMeshBounds,
    createFindNearestPolyResult,
    createHeightfield,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    findNearestPoly,
    markWalkableTriangles,
    OffMeshConnectionDirection,
    type OffMeshConnectionParams,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    rasterizeTriangles,
    removeTile,
    WALKABLE_AREA,
} from 'navcat';
import { crowd } from 'navcat/blocks';
import {
    createNavMeshOffMeshConnectionsHelper,
    createNavMeshTileHelper,
    type DebugObject,
    getPositionsAndIndices,
} from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';

/* init rapier */
await Rapier.init();

/* controls */
const guiSettings = {
    showRapierDebug: true,
};

const navMeshConfig = {
    cellSize: 0.15,
    cellHeight: 0.15,
    tileSizeVoxels: 32,
    walkableRadiusWorld: 0.15,
    walkableClimbWorld: 0.5,
    walkableHeightWorld: 1.0,
    walkableSlopeAngleDegrees: 45,
    borderSize: 4,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxSimplificationError: 1.3,
    maxEdgeLength: 12,
    maxVerticesPerPoly: 5,
    detailSampleDistance: 6,
    detailSampleMaxError: 1,
    tileRebuildThrottleMs: 1000,
};

/* setup example scene */
const container = document.getElementById('root')!;

// scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

// camera
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(-2, 10, 10);

// renderer
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

container.appendChild(renderer.domElement);

// lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
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

// controls
const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

// load level model
const levelModel = await loadGLTF('./models/nav-test.glb');
scene.add(levelModel.scene);

/* get walkable level geometry */
const walkableMeshes: THREE.Mesh[] = [];
const raycastTargets: THREE.Object3D[] = [];

scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
        raycastTargets.push(object);
    }
});

const [levelPositionsArray, levelIndicesArray] = getPositionsAndIndices(walkableMeshes);
const levelPositions = new Float32Array(levelPositionsArray);
const levelIndices = new Uint32Array(levelIndicesArray);

/* navmesh generation state */
const meshBounds = calculateMeshBounds(box3.create(), levelPositions, levelIndices);

const tileKey = (x: number, y: number) => `${x}_${y}`;

/* Dynamic NavMesh state - initialized later after off-mesh connections setup */
let navMeshState: DynamicNavMeshState;

const scratchVec3 = new THREE.Vector3();

const extractMeshWorldTriangles = (mesh: THREE.Mesh) => {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (!geometry) return null;

    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr) return null;

    mesh.updateMatrixWorld();

    const positions = new Float32Array(positionAttr.count * 3);
    for (let i = 0; i < positionAttr.count; i++) {
        scratchVec3.set(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
        scratchVec3.applyMatrix4(mesh.matrixWorld);
        positions[i * 3 + 0] = scratchVec3.x;
        positions[i * 3 + 1] = scratchVec3.y;
        positions[i * 3 + 2] = scratchVec3.z;
    }

    const indexAttr = geometry.getIndex();
    let indices: number[];
    if (indexAttr) {
        indices = Array.from(indexAttr.array as ArrayLike<number>);
    } else {
        indices = Array.from({ length: positionAttr.count }, (_, idx) => idx);
    }

    return { positions, indices };
};

const offMeshConnections: OffMeshConnectionParams[] = [
    {
        start: [0.39257542778564014, 3.9164539337158204, 2.7241512942770267],
        end: [1.2915380743929097, 2.8616158587143867, 3.398593875470379],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        flags: 0xffffff,
        area: 0x000000,
    },
    {
        start: [3.491345350637368, 3.169861227710937, 2.8419154179454473],
        end: [4.0038066734125435, 0.466454005241394, 1.686211347289651],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        flags: 0xffffff,
        area: 0x000000,
    },
    {
        start: [4.612475330561077, 0.466454005241394, 2.7619018768157435],
        end: [6.696740007427642, 0.5132029874438654, 2.5838885990777243],
        direction: OffMeshConnectionDirection.BIDIRECTIONAL,
        radius: 0.5,
        flags: 0xffffff,
        area: 0x000000,
    },
    {
        start: [3.8221359252929688, 0.47645399570465086, -4.391971844600165],
        end: [5.91173484469572, 0.6573111525835266, -4.671632275169128],
        direction: OffMeshConnectionDirection.BIDIRECTIONAL,
        radius: 0.5,
        flags: 0xffffff,
        area: 0x000000,
    },
    {
        start: [8.354324172733968, 0.5340897451517822, -3.2333049546492223],
        end: [8.461111697936666, 0.8365034207348984, -1.0863215738579806],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        flags: 0xffffff,
        area: 0x000000,
    },
];

/* Initialize dynamic navmesh */
navMeshState = initDynamicNavMesh(navMeshConfig, levelPositions, levelIndices, meshBounds, offMeshConnections, scene);

const offMeshConnectionsHelper = createNavMeshOffMeshConnectionsHelper(navMeshState.navMesh);
scene.add(offMeshConnectionsHelper.object);

/* Reinitialize function for GUI callbacks */
const reinitializeNavMesh = () => {
    // Clear old visuals
    for (const helper of navMeshState.visuals.tileHelpers.values()) {
        scene.remove(helper.object);
        helper.dispose();
    }

    // Reinitialize state
    navMeshState = initDynamicNavMesh(navMeshConfig, levelPositions, levelIndices, meshBounds, offMeshConnections, scene);

    // Update off-mesh connections helper
    offMeshConnectionsHelper.object.parent?.remove(offMeshConnectionsHelper.object);
    offMeshConnectionsHelper.dispose();
    const newHelper = createNavMeshOffMeshConnectionsHelper(navMeshState.navMesh);
    scene.add(newHelper.object);
};

/* setup GUI controls */
const gui = new GUI();
gui.add(guiSettings, 'showRapierDebug').name('Show Rapier Debug');

const navMeshFolder = gui.addFolder('NavMesh');
navMeshFolder.add(navMeshConfig, 'cellSize', 0.05, 1, 0.01).name('Cell Size').onChange(reinitializeNavMesh);
navMeshFolder.add(navMeshConfig, 'cellHeight', 0.05, 1, 0.01).name('Cell Height').onChange(reinitializeNavMesh);
navMeshFolder.add(navMeshConfig, 'tileSizeVoxels', 8, 128, 1).name('Tile Size (voxels)').onChange(reinitializeNavMesh);

const navMeshAgentFolder = navMeshFolder.addFolder('Agent');
navMeshAgentFolder.add(navMeshConfig, 'walkableRadiusWorld', 0, 2, 0.01).name('Radius').onChange(reinitializeNavMesh);
navMeshAgentFolder.add(navMeshConfig, 'walkableClimbWorld', 0, 2, 0.01).name('Climb').onChange(reinitializeNavMesh);
navMeshAgentFolder.add(navMeshConfig, 'walkableHeightWorld', 0, 2, 0.01).name('Height').onChange(reinitializeNavMesh);
navMeshAgentFolder.add(navMeshConfig, 'walkableSlopeAngleDegrees', 0, 90, 1).name('Slope (deg)').onChange(reinitializeNavMesh);

const navMeshRegionFolder = navMeshFolder.addFolder('Region');
navMeshRegionFolder.add(navMeshConfig, 'borderSize', 0, 10, 1).name('Border Size').onChange(reinitializeNavMesh);
navMeshRegionFolder.add(navMeshConfig, 'minRegionArea', 0, 50, 1).name('Min Region Area').onChange(reinitializeNavMesh);
navMeshRegionFolder.add(navMeshConfig, 'mergeRegionArea', 0, 50, 1).name('Merge Region Area').onChange(reinitializeNavMesh);

const navMeshContourFolder = navMeshFolder.addFolder('Contour');
navMeshContourFolder
    .add(navMeshConfig, 'maxSimplificationError', 0.1, 10, 0.1)
    .name('Max Simplification Error')
    .onChange(reinitializeNavMesh);
navMeshContourFolder.add(navMeshConfig, 'maxEdgeLength', 0, 50, 1).name('Max Edge Length').onChange(reinitializeNavMesh);

const navMeshPolyFolder = navMeshFolder.addFolder('PolyMesh');
navMeshPolyFolder.add(navMeshConfig, 'maxVerticesPerPoly', 3, 12, 1).name('Max Vertices/Poly').onChange(reinitializeNavMesh);

const navMeshDetailFolder = navMeshFolder.addFolder('Detail');
navMeshDetailFolder
    .add(navMeshConfig, 'detailSampleDistance', 0, 16, 1)
    .name('Sample Distance (voxels)')
    .onChange(reinitializeNavMesh);
navMeshDetailFolder.add(navMeshConfig, 'detailSampleMaxError', 0, 16, 1).name('Max Error (voxels)').onChange(reinitializeNavMesh);

const navMeshActions = {
    rebuildAll: () => reinitializeNavMesh(),
};

navMeshFolder.add(navMeshActions, 'rebuildAll').name('Rebuild All Tiles');
navMeshFolder
    .add(navMeshConfig, 'tileRebuildThrottleMs', 0, 5000, 100)
    .name('Tile Rebuild Throttle (ms)')
    .onChange(() => {
        navMeshState.config.tileRebuildThrottleMs = navMeshConfig.tileRebuildThrottleMs;
        navMeshState.tracking.throttleMs = navMeshConfig.tileRebuildThrottleMs;
    });

/* dynamic obstacles */
type PhysicsObj = {
    rigidBody: Rapier.RigidBody;
    mesh: THREE.Mesh;
    lastRespawn: number;
    // last known world position (used for swept AABB tracking)
    lastPosition: Vec3;
    // last set of tiles this object was registered with (as tileKey strings)
    lastTiles: Set<string>;
    // collision radius used to mark the compact heightfield
    radius: number;
};

type TileFlash = {
    startTime: number;
    duration: number;
};

type DynamicNavMeshState = {
    // Core navmesh
    navMesh: ReturnType<typeof createNavMesh>;
    buildCtx: ReturnType<typeof BuildContext.create>;

    // All configuration (source + derived)
    config: {
        // Source config
        cellSize: number;
        cellHeight: number;
        tileSizeVoxels: number;
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
        tileRebuildThrottleMs: number;
        // Derived values
        tileSizeWorld: number;
        walkableRadiusVoxels: number;
        walkableClimbVoxels: number;
        walkableHeightVoxels: number;
        detailSampleDistanceWorld: number;
        detailSampleMaxErrorWorld: number;
        gridSize: [number, number];
        tileWidth: number;
        tileHeight: number;
    };

    // Caches
    caches: {
        tileBounds: Map<string, [Vec3, Vec3]>;
        tileExpandedBounds: Map<string, [Vec3, Vec3]>;
        tileStaticTriangles: Map<string, number[]>;
        tileStaticHeightfields: Map<string, ReturnType<typeof createHeightfield>>;
    };

    // Dynamic tracking
    tracking: {
        physicsObjects: PhysicsObj[];
        tileToObjects: Map<string, Set<number>>;
        dirtyTiles: Set<string>;
        rebuildQueue: Array<[number, number]>;
        tileLastRebuilt: Map<string, number>;
        throttleMs: number;
    };

    // Visuals
    visuals: {
        tileHelpers: Map<string, DebugObject>;
        tileFlashes: Map<string, TileFlash>;
    };

    // Immutable input data
    levelPositions: Float32Array;
    levelIndices: Uint32Array;
    meshBounds: [Vec3, Vec3];
};

function initDynamicNavMesh(
    config: typeof navMeshConfig,
    levelPositions: Float32Array,
    levelIndices: Uint32Array,
    meshBounds: [Vec3, Vec3],
    offMeshConnections: OffMeshConnectionParams[],
    scene: THREE.Scene,
): DynamicNavMeshState {
    const buildCtx = BuildContext.create();
    const navMesh = createNavMesh();

    // Add off-mesh connections
    for (const offMeshConnection of offMeshConnections) {
        addOffMeshConnection(navMesh, offMeshConnection);
    }

    // 1. Calculate all derived values and create unified config
    const tileSizeWorld = config.tileSizeVoxels * config.cellSize;
    const walkableRadiusVoxels = Math.max(0, Math.ceil(config.walkableRadiusWorld / config.cellSize));
    const walkableClimbVoxels = Math.max(0, Math.ceil(config.walkableClimbWorld / config.cellHeight));
    const walkableHeightVoxels = Math.max(0, Math.ceil(config.walkableHeightWorld / config.cellHeight));

    const detailSampleDistanceWorld = config.detailSampleDistance < 0.9 ? 0 : config.cellSize * config.detailSampleDistance;
    const detailSampleMaxErrorWorld = config.cellHeight * config.detailSampleMaxError;

    const gridSize = calculateGridSize(vec2.create(), meshBounds, config.cellSize);
    const tileWidth = Math.max(1, Math.floor((gridSize[0] + config.tileSizeVoxels - 1) / config.tileSizeVoxels));
    const tileHeight = Math.max(1, Math.floor((gridSize[1] + config.tileSizeVoxels - 1) / config.tileSizeVoxels));

    const unifiedConfig = {
        // Source config
        ...config,
        // Derived values
        tileSizeWorld,
        walkableRadiusVoxels,
        walkableClimbVoxels,
        walkableHeightVoxels,
        detailSampleDistanceWorld,
        detailSampleMaxErrorWorld,
        gridSize,
        tileWidth,
        tileHeight,
    };

    navMesh.tileWidth = tileSizeWorld;
    navMesh.tileHeight = tileSizeWorld;
    navMesh.origin = meshBounds[0];

    // 2. Build static tile caches
    const tileBoundsCache = new Map<string, [Vec3, Vec3]>();
    const tileExpandedBoundsCache = new Map<string, [Vec3, Vec3]>();
    const tileStaticTriangles = new Map<string, number[]>();
    const tileStaticHeightfields = new Map<string, ReturnType<typeof createHeightfield>>();

    const borderOffset = config.borderSize * config.cellSize;
    const triangle = triangle3.create();

    for (let tx = 0; tx < tileWidth; tx++) {
        for (let ty = 0; ty < tileHeight; ty++) {
            const min: Vec3 = [meshBounds[0][0] + tx * tileSizeWorld, meshBounds[0][1], meshBounds[0][2] + ty * tileSizeWorld];
            const max: Vec3 = [
                meshBounds[0][0] + (tx + 1) * tileSizeWorld,
                meshBounds[1][1],
                meshBounds[0][2] + (ty + 1) * tileSizeWorld,
            ];
            const bounds: [Vec3, Vec3] = [min, max];
            const key = tileKey(tx, ty);
            tileBoundsCache.set(key, bounds);

            const expandedMin: Vec3 = [min[0] - borderOffset, min[1], min[2] - borderOffset];
            const expandedMax: Vec3 = [max[0] + borderOffset, max[1], max[2] + borderOffset];
            const expandedBounds: [Vec3, Vec3] = [expandedMin, expandedMax];
            tileExpandedBoundsCache.set(key, expandedBounds);

            const expandedBox = expandedBounds as any;
            const trianglesInBox: number[] = [];

            for (let i = 0; i < levelIndices.length; i += 3) {
                const a = levelIndices[i];
                const b = levelIndices[i + 1];
                const c = levelIndices[i + 2];

                vec3.fromBuffer(triangle[0], levelPositions, a * 3);
                vec3.fromBuffer(triangle[1], levelPositions, b * 3);
                vec3.fromBuffer(triangle[2], levelPositions, c * 3);

                if (box3.intersectsTriangle3(expandedBox, triangle)) {
                    trianglesInBox.push(a, b, c);
                }
            }

            tileStaticTriangles.set(key, trianglesInBox);
        }
    }

    // 2.5. Pre-rasterize static geometry into heightfields for each tile
    const hfSize = Math.floor(config.tileSizeVoxels + config.borderSize * 2);

    for (let tx = 0; tx < tileWidth; tx++) {
        for (let ty = 0; ty < tileHeight; ty++) {
            const key = tileKey(tx, ty);
            const expandedBounds = tileExpandedBoundsCache.get(key);
            if (!expandedBounds) continue;

            const expandedBox = expandedBounds as any;

            // create heightfield for this tile
            const heightfield = createHeightfield(hfSize, hfSize, expandedBox, config.cellSize, config.cellHeight);

            // rasterize static geometry only
            const staticTriangles = tileStaticTriangles.get(key) ?? [];
            if (staticTriangles.length > 0) {
                const staticAreaIds = new Uint8Array(staticTriangles.length / 3);
                markWalkableTriangles(levelPositions, staticTriangles, staticAreaIds, config.walkableSlopeAngleDegrees);
                rasterizeTriangles(buildCtx, heightfield, levelPositions, staticTriangles, staticAreaIds, walkableClimbVoxels);
            }

            // cache the pre-rasterized heightfield
            tileStaticHeightfields.set(key, heightfield);
        }
    }

    // 3. Create state object
    const state: DynamicNavMeshState = {
        navMesh,
        buildCtx,
        config: unifiedConfig,
        caches: {
            tileBounds: tileBoundsCache,
            tileExpandedBounds: tileExpandedBoundsCache,
            tileStaticTriangles,
            tileStaticHeightfields,
        },
        tracking: {
            physicsObjects: [],
            tileToObjects: new Map(),
            dirtyTiles: new Set(),
            rebuildQueue: [],
            tileLastRebuilt: new Map(),
            throttleMs: config.tileRebuildThrottleMs,
        },
        visuals: {
            tileHelpers: new Map(),
            tileFlashes: new Map(),
        },
        levelPositions,
        levelIndices,
        meshBounds,
    };

    // 4. Build all tiles initially
    const totalTiles = state.config.tileWidth * state.config.tileHeight;
    let builtTiles = 0;

    for (let tx = 0; tx < state.config.tileWidth; tx++) {
        for (let ty = 0; ty < state.config.tileHeight; ty++) {
            buildTileAtCoords(state, scene, tx, ty);
            builtTiles++;
        }
    }

    console.log(`Built ${builtTiles} / ${totalTiles} navmesh tiles`);

    return state;
}

function buildTileAtCoords(state: DynamicNavMeshState, scene: THREE.Scene, tx: number, ty: number): void {
    const key = tileKey(tx, ty);

    // Clone the pre-rasterized static heightfield for this tile
    const cachedHeightfield = state.caches.tileStaticHeightfields.get(key);
    if (!cachedHeightfield) {
        throw new Error(`No cached heightfield found for tile ${tx}, ${ty}`);
    }

    const heightfield = structuredClone(cachedHeightfield);

    // Rasterize dynamic obstacles (only if there are any)
    const dynamicObjects = state.tracking.tileToObjects.get(key);
    if (dynamicObjects && dynamicObjects.size > 0) {
        for (const objIndex of dynamicObjects) {
            const obj = state.tracking.physicsObjects[objIndex];
            if (!obj) continue;

            const meshData = extractMeshWorldTriangles(obj.mesh);
            if (!meshData) continue;

            const { positions, indices } = meshData;
            if (indices.length === 0) continue;

            const areaIds = new Uint8Array(indices.length / 3);
            markWalkableTriangles(positions, indices, areaIds, state.config.walkableSlopeAngleDegrees);
            rasterizeTriangles(state.buildCtx, heightfield, positions, indices, areaIds, state.config.walkableClimbVoxels);
        }
    }

    // Filter and build compact heightfield
    filterLowHangingWalkableObstacles(heightfield, state.config.walkableClimbVoxels);
    filterLedgeSpans(heightfield, state.config.walkableHeightVoxels, state.config.walkableClimbVoxels);
    filterWalkableLowHeightSpans(heightfield, state.config.walkableHeightVoxels);

    const chf = buildCompactHeightfield(
        state.buildCtx,
        state.config.walkableHeightVoxels,
        state.config.walkableClimbVoxels,
        heightfield,
    );
    erodeWalkableArea(state.config.walkableRadiusVoxels, chf);
    buildDistanceField(chf);

    // Build regions and contours
    buildRegions(state.buildCtx, chf, state.config.borderSize, state.config.minRegionArea, state.config.mergeRegionArea);

    const contourSet = buildContours(
        state.buildCtx,
        chf,
        state.config.maxSimplificationError,
        state.config.maxEdgeLength,
        ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
    );

    // Build poly mesh
    const polyMesh = buildPolyMesh(state.buildCtx, contourSet, state.config.maxVerticesPerPoly);

    for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
        if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
            polyMesh.areas[polyIndex] = 0;
        }

        if (polyMesh.areas[polyIndex] === 0) {
            polyMesh.flags[polyIndex] = 1;
        }
    }

    // Build detail mesh
    const polyMeshDetail = buildPolyMeshDetail(
        state.buildCtx,
        polyMesh,
        chf,
        state.config.detailSampleDistanceWorld,
        state.config.detailSampleMaxErrorWorld,
    );

    const tilePolys = polyMeshToTilePolys(polyMesh);
    const tileDetail = polyMeshDetailToTileDetailMesh(tilePolys.polys, polyMeshDetail);

    // Create tile parameters
    const tileParams = {
        bounds: polyMesh.bounds,
        vertices: tilePolys.vertices,
        polys: tilePolys.polys,
        detailMeshes: tileDetail.detailMeshes,
        detailVertices: tileDetail.detailVertices,
        detailTriangles: tileDetail.detailTriangles,
        tileX: tx,
        tileY: ty,
        tileLayer: 0,
        cellSize: state.config.cellSize,
        cellHeight: state.config.cellHeight,
        walkableHeight: state.config.walkableHeightWorld,
        walkableRadius: state.config.walkableRadiusWorld,
        walkableClimb: state.config.walkableClimbWorld,
    } as any;

    const tile = buildTile(tileParams);

    // Remove old tile and add new one
    removeTile(state.navMesh, tx, ty, 0);
    addTile(state.navMesh, tile);

    // Update visual helper
    const tileKeyStr = tileKey(tx, ty);
    const oldTileHelper = state.visuals.tileHelpers.get(tileKeyStr);
    if (oldTileHelper) {
        scene.remove(oldTileHelper.object);
        oldTileHelper.dispose();
        state.visuals.tileHelpers.delete(tileKeyStr);
    }

    for (const tileId in state.navMesh.tiles) {
        const t = state.navMesh.tiles[tileId];
        if (t.tileX === tx && t.tileY === ty) {
            const newTileHelper = createNavMeshTileHelper(t);
            newTileHelper.object.position.y += 0.05;
            scene.add(newTileHelper.object);
            state.visuals.tileHelpers.set(tileKeyStr, newTileHelper);

            state.visuals.tileFlashes.set(tileKeyStr, {
                startTime: performance.now(),
                duration: 1500,
            });

            break;
        }
    }
}

function enqueueTile(state: DynamicNavMeshState, x: number, y: number): void {
    if (x < 0 || y < 0 || x >= state.config.tileWidth || y >= state.config.tileHeight) return;
    const key = tileKey(x, y);
    if (state.tracking.dirtyTiles.has(key)) return;
    state.tracking.dirtyTiles.add(key);
    state.tracking.rebuildQueue.push([x, y]);
}

function processRebuildQueue(state: DynamicNavMeshState, scene: THREE.Scene, maxPerFrame: number): void {
    let processed = 0;

    for (let i = 0; i < state.tracking.rebuildQueue.length; i++) {
        if (processed >= maxPerFrame) break;

        const tile = state.tracking.rebuildQueue.shift();
        if (!tile) return;
        const [tx, ty] = tile;
        const key = tileKey(tx, ty);

        // if this tile was rebuilt recently, skip and re-enqueue
        const last = state.tracking.tileLastRebuilt.get(key) ?? 0;
        const now = performance.now();
        if (now - last < state.tracking.throttleMs) {
            state.tracking.rebuildQueue.push([tx, ty]);
            continue;
        }

        // we are rebuilding this tile now, remove from dirty set
        state.tracking.dirtyTiles.delete(key);

        try {
            buildTileAtCoords(state, scene, tx, ty);

            // record rebuild time
            state.tracking.tileLastRebuilt.set(key, performance.now());

            // count this as a processed tile
            processed++;
        } catch (err) {
            // log and continue
            console.error('Tile build failed', err);
            processed++;
        }
    }
}

function tilesForAABB(state: DynamicNavMeshState, min: Vec3, max: Vec3): Array<[number, number]> {
    if (state.config.tileWidth <= 0 || state.config.tileHeight <= 0 || state.config.tileSizeWorld <= 0) {
        return [];
    }

    const rawMinX = Math.floor((min[0] - state.meshBounds[0][0]) / state.config.tileSizeWorld);
    const rawMinY = Math.floor((min[2] - state.meshBounds[0][2]) / state.config.tileSizeWorld);
    const rawMaxX = Math.floor((max[0] - state.meshBounds[0][0]) / state.config.tileSizeWorld);
    const rawMaxY = Math.floor((max[2] - state.meshBounds[0][2]) / state.config.tileSizeWorld);

    const clampIndex = (value: number, maxValue: number) => Math.min(Math.max(value, 0), maxValue);

    const minX = clampIndex(rawMinX, state.config.tileWidth - 1);
    const minY = clampIndex(rawMinY, state.config.tileHeight - 1);
    const maxX = clampIndex(rawMaxX, state.config.tileWidth - 1);
    const maxY = clampIndex(rawMaxY, state.config.tileHeight - 1);

    if (minX > maxX || minY > maxY) return [];

    const out: Array<[number, number]> = [];
    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            out.push([x, y]);
        }
    }
    return out;
}

function updateObjectTiles(state: DynamicNavMeshState, objIndex: number, newTiles: Set<string>): void {
    const obj = state.tracking.physicsObjects[objIndex];
    if (!obj) return;

    // compute tiles to remove (in lastTiles but not in newTiles)
    for (const oldKey of obj.lastTiles) {
        if (!newTiles.has(oldKey)) {
            const s = state.tracking.tileToObjects.get(oldKey);
            if (s) {
                s.delete(objIndex);
                if (s.size === 0) state.tracking.tileToObjects.delete(oldKey);
            }
        }
    }

    // compute tiles to add (in newTiles but not in lastTiles)
    for (const newKey of newTiles) {
        if (!obj.lastTiles.has(newKey)) {
            let s = state.tracking.tileToObjects.get(newKey);
            if (!s) {
                s = new Set<number>();
                state.tracking.tileToObjects.set(newKey, s);
            }
            s.add(objIndex);
        }
    }

    // replace lastTiles with newTiles
    obj.lastTiles = newTiles;
}

function updateDynamicNavMesh(
    state: DynamicNavMeshState,
    scene: THREE.Scene,
    options: {
        maxTilesPerFrame: number;
    },
): void {
    // Schedule tiles based on movements of physics objects between tiles
    for (let i = 0; i < state.tracking.physicsObjects.length; i++) {
        const obj = state.tracking.physicsObjects[i];
        const posNow = obj.rigidBody.translation();
        const curPos: Vec3 = [posNow.x, posNow.y, posNow.z];

        // Compute swept AABB between lastPosition and curPos expanded by radius
        const r = obj.radius;
        const min: Vec3 = [
            Math.min(obj.lastPosition[0], curPos[0]) - r,
            Math.min(obj.lastPosition[1], curPos[1]) - r,
            Math.min(obj.lastPosition[2], curPos[2]) - r,
        ];
        const max: Vec3 = [
            Math.max(obj.lastPosition[0], curPos[0]) + r,
            Math.max(obj.lastPosition[1], curPos[1]) + r,
            Math.max(obj.lastPosition[2], curPos[2]) + r,
        ];

        const tiles = tilesForAABB(state, min, max);
        const newTiles = new Set<string>();
        for (const [tx, ty] of tiles) {
            newTiles.add(tileKey(tx, ty));
        }

        const isSleeping = obj.rigidBody.isSleeping();

        // Rebuild tiles we left (object no longer present, needs removal)
        for (const oldKey of obj.lastTiles) {
            if (!newTiles.has(oldKey)) {
                const parts = oldKey.split('_');
                const tx = parseInt(parts[0], 10);
                const ty = parseInt(parts[1], 10);
                enqueueTile(state, tx, ty);
            }
        }

        // Rebuild current tiles only if object is awake (moving/settling)
        if (!isSleeping) {
            for (const newKey of newTiles) {
                const parts = newKey.split('_');
                const tx = parseInt(parts[0], 10);
                const ty = parseInt(parts[1], 10);
                enqueueTile(state, tx, ty);
            }
        }

        // Update object tile registrations
        updateObjectTiles(state, i, newTiles);

        // Save current position for next frame
        obj.lastPosition = curPos;
    }

    // Process tile rebuilds
    processRebuildQueue(state, scene, options.maxTilesPerFrame);
}

function updateNavMeshVisuals(state: DynamicNavMeshState, _scene: THREE.Scene, now: number): void {
    const flashesToRemove: string[] = [];

    for (const [key, flash] of state.visuals.tileFlashes) {
        const elapsed = now - flash.startTime;
        const t = Math.min(elapsed / flash.duration, 1.0); // normalized time [0, 1]

        const tileHelper = state.visuals.tileHelpers.get(key);
        if (tileHelper) {
            const fadeAmount = (1.0 - t) ** 3;

            tileHelper.object.traverse((child) => {
                if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) {
                    const material = child.material as THREE.MeshBasicMaterial;

                    const baseColor = 0x222222;
                    const flashColor = 0x005500;

                    const baseR = (baseColor >> 16) & 0xff;
                    const baseG = (baseColor >> 8) & 0xff;
                    const baseB = baseColor & 0xff;

                    const flashR = (flashColor >> 16) & 0xff;
                    const flashG = (flashColor >> 8) & 0xff;
                    const flashB = flashColor & 0xff;

                    const r = Math.round(flashR * fadeAmount + baseR * (1 - fadeAmount));
                    const g = Math.round(flashG * fadeAmount + baseG * (1 - fadeAmount));
                    const b = Math.round(flashB * fadeAmount + baseB * (1 - fadeAmount));

                    const color = (r << 16) | (g << 8) | b;
                    material.color.setHex(color);
                    material.vertexColors = false;
                }
            });
        }

        if (t >= 1.0) {
            flashesToRemove.push(key);
        }
    }

    for (const key of flashesToRemove) {
        state.visuals.tileFlashes.delete(key);
    }
}

/* create physics world */
const physicsWorld = new Rapier.World(new Rapier.Vector3(0, -9.81, 0));

/* create fixed trimesh collider for level */
const levelColliderDesc = Rapier.ColliderDesc.trimesh(new Float32Array(levelPositions), new Uint32Array(levelIndices));
levelColliderDesc.setMass(0);

const levelRigidBodyDesc = Rapier.RigidBodyDesc.fixed();
const levelRigidBody = physicsWorld.createRigidBody(levelRigidBodyDesc);

physicsWorld.createCollider(levelColliderDesc, levelRigidBody);

/* rapier debug rendering */
let rapierDebugLineSegments: THREE.LineSegments | null = null;

const renderRapierDebug = (): void => {
    if (guiSettings.showRapierDebug) {
        const debugFn = physicsWorld.debugRender;
        if (typeof debugFn === 'function') {
            if (!rapierDebugLineSegments) {
                const geo = new THREE.BufferGeometry();
                const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
                rapierDebugLineSegments = new THREE.LineSegments(geo, mat);
                rapierDebugLineSegments.renderOrder = 999;
                scene.add(rapierDebugLineSegments);
            }

            const { vertices, colors } = debugFn.call(physicsWorld);
            const vertCount = (vertices?.length ?? 0) / 3;
            const geo = rapierDebugLineSegments.geometry as THREE.BufferGeometry;

            if (vertCount > 0) {
                const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
                if (!posAttr || posAttr.count !== vertCount) {
                    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
                } else {
                    (posAttr.array as Float32Array).set(vertices);
                    posAttr.needsUpdate = true;
                }

                const colorLen = colors?.length ?? 0;
                const expected = vertCount * 4;
                const rgb = new Float32Array(vertCount * 3);
                if (colorLen >= expected) {
                    for (let i = 0; i < vertCount; i++) {
                        rgb[i * 3 + 0] = colors[i * 4 + 0];
                        rgb[i * 3 + 1] = colors[i * 4 + 1];
                        rgb[i * 3 + 2] = colors[i * 4 + 2];
                    }
                } else {
                    for (let i = 0; i < vertCount * 3; i++) rgb[i] = 0.75;
                }
                const colAttr = geo.getAttribute('color') as THREE.BufferAttribute;
                if (!colAttr || colAttr.count !== vertCount) {
                    geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
                } else {
                    (colAttr.array as Float32Array).set(rgb);
                    colAttr.needsUpdate = true;
                }

                rapierDebugLineSegments.visible = true;
            } else if (rapierDebugLineSegments) {
                rapierDebugLineSegments.visible = false;
            }
        }
    } else if (rapierDebugLineSegments) {
        rapierDebugLineSegments.visible = false;
    }
};

/* create a bunch of dynamic boxes */
for (let i = 0; i < 20; i++) {
    // visual
    const boxSizeX = 0.4 + Math.random() * 0.6;
    const boxSizeZ = 0.4 + Math.random() * 0.6;
    const minHeight = 0.25;
    const maxHeight = 1.6;
    const boxHeight = minHeight + Math.random() * (maxHeight - minHeight);

    const boxGeometry = new THREE.BoxGeometry(boxSizeX, boxHeight, boxSizeZ);
    const boxMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);

    scene.add(boxMesh);
    raycastTargets.push(boxMesh);

    // physics
    const boxColliderDesc = Rapier.ColliderDesc.cuboid(boxSizeX / 2, boxHeight / 2, boxSizeZ / 2);
    boxColliderDesc.setRestitution(0.1);
    boxColliderDesc.setFriction(0.5);
    boxColliderDesc.setDensity(1.0);
    const boxRigidBodyDesc = Rapier.RigidBodyDesc.dynamic().setTranslation(
        (Math.random() - 0.5) * 8,
        10 + i * 2 + boxHeight,
        (Math.random() - 0.5) * 8,
    );

    const boxRigidBody = physicsWorld.createRigidBody(boxRigidBodyDesc);

    physicsWorld.createCollider(boxColliderDesc, boxRigidBody);

    // compute approximate radius from geometry bounding sphere
    const geom = (boxMesh as any).geometry as THREE.BufferGeometry;
    if (!geom.boundingSphere) geom.computeBoundingSphere();
    const bs = geom.boundingSphere!;
    const worldRadius = bs.radius * (boxMesh.scale.x || 1) || 0.5;

    // find current tiles overlapping the object's bounding box
    const pos = boxMesh.position;
    const r = worldRadius;
    const min: Vec3 = [pos.x - r, pos.y - r, pos.z - r];
    const max: Vec3 = [pos.x + r, pos.y + r, pos.z + r];

    const tiles = tilesForAABB(navMeshState, min, max);
    const tilesSet = new Set<string>();
    for (const [tx, ty] of tiles) {
        const k = tileKey(tx, ty);
        tilesSet.add(k);
        let s = navMeshState.tracking.tileToObjects.get(k);
        if (!s) {
            s = new Set<number>();
            navMeshState.tracking.tileToObjects.set(k, s);
        }
        s.add(i);
        enqueueTile(navMeshState, tx, ty);
    }

    // add the physics object
    const physicsObject: PhysicsObj = {
        rigidBody: boxRigidBody,
        mesh: boxMesh,
        lastRespawn: performance.now(),
        lastPosition: [boxRigidBody.translation().x, boxRigidBody.translation().y, boxRigidBody.translation().z],
        lastTiles: tilesSet,
        radius: worldRadius,
    };

    navMeshState.tracking.physicsObjects.push(physicsObject);
}

/* Agent visuals */
type AgentVisuals = {
    capsule: THREE.Mesh;
    targetMesh: THREE.Mesh;
    color: number;
};

const createAgentVisuals = (position: Vec3, scene: THREE.Scene, color: number, radius: number, height: number): AgentVisuals => {
    // Create capsule geometry
    const capsuleGeometry = new THREE.CapsuleGeometry(radius, height - radius * 2, 4, 8);
    const capsuleMaterial = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.2,
        roughness: 0.7,
        metalness: 0.3,
    });
    const capsule = new THREE.Mesh(capsuleGeometry, capsuleMaterial);
    capsule.position.set(position[0], position[1] + height / 2, position[2]);
    capsule.castShadow = true;
    scene.add(capsule);

    // Create target indicator
    const targetGeometry = new THREE.SphereGeometry(0.1);
    const targetMaterial = new THREE.MeshBasicMaterial({ color });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    scene.add(targetMesh);

    return {
        capsule,
        targetMesh,
        color,
    };
};

const updateAgentVisuals = (agent: crowd.Agent, visuals: AgentVisuals): void => {
    // Update capsule position
    visuals.capsule.position.set(agent.position[0], agent.position[1] + agentParams.height / 2, agent.position[2]);

    // Rotate capsule to face movement direction
    const velocity = vec3.length(agent.velocity);
    if (velocity > 0.1) {
        const direction = vec3.normalize([0, 0, 0], agent.velocity);
        const targetAngle = Math.atan2(direction[0], direction[2]);
        visuals.capsule.rotation.y = targetAngle;
    }

    // update target mesh position
    visuals.targetMesh.position.fromArray(agent.targetPosition);
    visuals.targetMesh.position.y += 0.1;
};

/* create crowd and agents */
const catsCrowd = crowd.create(1);

console.log(catsCrowd);

const agentParams: crowd.AgentParams = {
    radius: 0.3,
    height: 1,
    maxAcceleration: 15.0,
    maxSpeed: 3.5,
    collisionQueryRange: 2,
    separationWeight: 0.5,
    updateFlags:
        crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
        crowd.CrowdUpdateFlags.SEPARATION |
        crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
        crowd.CrowdUpdateFlags.OPTIMIZE_TOPO |
        crowd.CrowdUpdateFlags.OPTIMIZE_VIS,
    queryFilter: DEFAULT_QUERY_FILTER,
    autoTraverseOffMeshConnections: true,
    obstacleAvoidance: crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
};

// create agents at different positions
const agentPositions: Vec3[] = Array.from({ length: 2 }).map((_, i) => [-2 + i * -0.05, 0.5, 3]) as Vec3[];

const agentColors = [0x0000ff, 0x00ff00];

const agentVisuals: Record<string, AgentVisuals> = {};

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i % agentColors.length];

    // add agent to crowd
    const agentId = crowd.addAgent(catsCrowd, navMeshState.navMesh, position, agentParams);
    console.log(`Creating agent ${i} at position:`, position);

    // create visuals for the agent
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, agentParams.radius, agentParams.height);
}

// mouse interaction for setting agent targets
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

const onPointerDown = (event: MouseEvent) => {
    if (event.button !== 0) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(raycastTargets, true);

    if (intersects.length === 0) return;

    const intersectionPoint = intersects[0].point;
    const targetPosition: Vec3 = [intersectionPoint.x, intersectionPoint.y, intersectionPoint.z];

    const halfExtents: Vec3 = [1, 1, 1];
    const nearestResult = findNearestPoly(
        createFindNearestPolyResult(),
        navMeshState.navMesh,
        targetPosition,
        halfExtents,
        DEFAULT_QUERY_FILTER,
    );

    if (!nearestResult.success) return;

    for (const agentId in catsCrowd.agents) {
        crowd.requestMoveTarget(catsCrowd, agentId, nearestResult.nodeRef, nearestResult.position);
    }

    console.log('target position:', targetPosition);
};

renderer.domElement.addEventListener('pointerdown', onPointerDown);

/* loop */
let prevTime = performance.now();

function update() {
    requestAnimationFrame(update);

    const time = performance.now();
    const deltaTime = (time - prevTime) / 1000;
    const clampedDeltaTime = Math.min(deltaTime, 0.1);
    prevTime = time;

    // update crowd
    crowd.update(catsCrowd, navMeshState.navMesh, clampedDeltaTime);

    // update physics
    physicsWorld.timestep = clampedDeltaTime;
    physicsWorld.step();

    // update physics object transforms
    for (const obj of navMeshState.tracking.physicsObjects) {
        const position = obj.rigidBody.translation();
        const rotation = obj.rigidBody.rotation();

        obj.mesh.position.set(position.x, position.y, position.z);
        obj.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }

    // respawn boxes that fall below certain height OR every 10 seconds since last respawn
    const RESPAWN_INTERVAL_MS = 10000;
    for (let i = 0; i < navMeshState.tracking.physicsObjects.length; i++) {
        const obj = navMeshState.tracking.physicsObjects[i];
        const position = obj.rigidBody.translation();
        const nowMs = performance.now();

        const fellOut = position.y < -10;
        const periodic = nowMs - (obj.lastRespawn ?? 0) >= RESPAWN_INTERVAL_MS;

        if (fellOut || periodic) {
            const x = (Math.random() - 0.5) * 8;
            const y = 10;
            const z = (Math.random() - 0.5) * 8;

            // teleport and clear velocities
            obj.rigidBody.setTranslation({ x, y, z }, true);
            obj.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            obj.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

            // update per-object tracking (tiles and lastPosition)
            const r = obj.radius ?? 0.5;
            const min: Vec3 = [x - r, y - r, z - r];
            const max: Vec3 = [x + r, y + r, z + r];
            const tiles = tilesForAABB(navMeshState, min, max);
            const newTiles = new Set<string>();
            for (const [tx, ty] of tiles) {
                newTiles.add(tileKey(tx, ty));
            }

            updateObjectTiles(navMeshState, i, newTiles);

            obj.lastPosition[0] = x;
            obj.lastPosition[1] = y;
            obj.lastPosition[2] = z;
            obj.lastRespawn = nowMs;
        }
    }

    // Update dynamic navmesh (track physics objects and rebuild tiles)
    console.time('tick updateDynamicNavMesh');
    updateDynamicNavMesh(navMeshState, scene, { maxTilesPerFrame: 1 });
    console.timeEnd('tick updateDynamicNavMesh');

    // Update navmesh visuals (tile flash animations)
    updateNavMeshVisuals(navMeshState, scene, performance.now());

    // Rapier debug rendering (lines)
    renderRapierDebug();

    // update agent visuals
    const agents = Object.keys(catsCrowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = catsCrowd.agents[agentId];
        const visuals = agentVisuals[agentId];

        if (visuals) {
            updateAgentVisuals(agent, visuals);
        }
    }

    // update controls
    orbitControls.update(clampedDeltaTime);

    // render
    renderer.render(scene, camera);
}

update();
