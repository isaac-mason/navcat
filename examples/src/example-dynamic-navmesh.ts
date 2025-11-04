import Rapier from '@dimforge/rapier3d-compat';
import { GUI } from 'lil-gui';
import { box3, triangle3, vec2, type Vec3, vec3 } from 'mathcat';
import {
    addOffMeshConnection,
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
import {
    createNavMeshOffMeshConnectionsHelper,
    createNavMeshTileHelper,
    type DebugObject,
    getPositionsAndIndices,
} from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';
import { crowd, pathCorridor } from 'navcat/blocks';

/* init rapier */
await Rapier.init();

/* controls */
const guiSettings = {
    showPathLine: true,
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

const gui = new GUI();
gui.add(guiSettings, 'showPathLine').name('Show Path Line');
gui.add(guiSettings, 'showRapierDebug').name('Show Rapier Debug');

const navMeshFolder = gui.addFolder('NavMesh');
navMeshFolder.add(navMeshConfig, 'cellSize', 0.05, 1, 0.01).name('Cell Size');
navMeshFolder.add(navMeshConfig, 'cellHeight', 0.05, 1, 0.01).name('Cell Height');
navMeshFolder.add(navMeshConfig, 'tileSizeVoxels', 8, 128, 1).name('Tile Size (voxels)');

const navMeshAgentFolder = navMeshFolder.addFolder('Agent');
navMeshAgentFolder.add(navMeshConfig, 'walkableRadiusWorld', 0, 2, 0.01).name('Radius');
navMeshAgentFolder.add(navMeshConfig, 'walkableClimbWorld', 0, 2, 0.01).name('Climb');
navMeshAgentFolder.add(navMeshConfig, 'walkableHeightWorld', 0, 2, 0.01).name('Height');
navMeshAgentFolder.add(navMeshConfig, 'walkableSlopeAngleDegrees', 0, 90, 1).name('Slope (deg)');

const navMeshRegionFolder = navMeshFolder.addFolder('Region');
navMeshRegionFolder.add(navMeshConfig, 'borderSize', 0, 10, 1).name('Border Size');
navMeshRegionFolder.add(navMeshConfig, 'minRegionArea', 0, 50, 1).name('Min Region Area');
navMeshRegionFolder.add(navMeshConfig, 'mergeRegionArea', 0, 50, 1).name('Merge Region Area');

const navMeshContourFolder = navMeshFolder.addFolder('Contour');
navMeshContourFolder.add(navMeshConfig, 'maxSimplificationError', 0.1, 10, 0.1).name('Max Simplification Error');
navMeshContourFolder.add(navMeshConfig, 'maxEdgeLength', 0, 50, 1).name('Max Edge Length');

const navMeshPolyFolder = navMeshFolder.addFolder('PolyMesh');
navMeshPolyFolder.add(navMeshConfig, 'maxVerticesPerPoly', 3, 12, 1).name('Max Vertices/Poly');

const navMeshDetailFolder = navMeshFolder.addFolder('Detail');
navMeshDetailFolder.add(navMeshConfig, 'detailSampleDistance', 0, 16, 1).name('Sample Distance (voxels)');
navMeshDetailFolder.add(navMeshConfig, 'detailSampleMaxError', 0, 16, 1).name('Max Error (voxels)');

const navMeshActions = {
    rebuildAll: () => rebuildAllTiles(true),
};

navMeshFolder.add(navMeshActions, 'rebuildAll').name('Rebuild All Tiles');
navMeshFolder
    .add(navMeshConfig, 'tileRebuildThrottleMs', 0, 5000, 100)
    .name('Tile Rebuild Throttle (ms)')
    .onChange(() => {
        TILE_REBUILD_THROTTLE_MS.current = Math.max(0, navMeshConfig.tileRebuildThrottleMs);
    });

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

// load cat model for agents
const catModel = await loadGLTF('./models/cat.gltf');
const catAnimations = catModel.animations;

/* get walkable level geometry */
const walkableMeshes: THREE.Mesh[] = [];
const raycastTargets: THREE.Object3D[] = [];

scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
        raycastTargets.push(object);
    }
});

const [levelPositions, levelIndices] = getPositionsAndIndices(walkableMeshes);

/* navmesh generation state */
const meshBounds = calculateMeshBounds(box3.create(), levelPositions, levelIndices);

let tileSizeWorld = 0;
let walkableRadiusVoxels = 0;
let walkableClimbVoxels = 0;
let walkableHeightVoxels = 0;
let detailSampleDistance = 0;
let detailSampleMaxError = 0;

let gridSize = vec2.create();
let tileWidth = 0;
let tileHeight = 0;

const tileBoundsCache = new Map<string, [Vec3, Vec3]>();
const tileExpandedBoundsCache = new Map<string, [Vec3, Vec3]>();
const tileStaticTriangles = new Map<string, number[]>();

const tileKey = (x: number, y: number) => `${x}_${y}`;

const updateNavMeshDerivedValues = () => {
    tileSizeWorld = navMeshConfig.tileSizeVoxels * navMeshConfig.cellSize;
    walkableRadiusVoxels = Math.max(0, Math.ceil(navMeshConfig.walkableRadiusWorld / navMeshConfig.cellSize));
    walkableClimbVoxels = Math.max(0, Math.ceil(navMeshConfig.walkableClimbWorld / navMeshConfig.cellHeight));
    walkableHeightVoxels = Math.max(0, Math.ceil(navMeshConfig.walkableHeightWorld / navMeshConfig.cellHeight));

    detailSampleDistance =
        navMeshConfig.detailSampleDistance < 0.9 ? 0 : navMeshConfig.cellSize * navMeshConfig.detailSampleDistance;
    detailSampleMaxError = navMeshConfig.cellHeight * navMeshConfig.detailSampleMaxError;

    gridSize = calculateGridSize(vec2.create(), meshBounds, navMeshConfig.cellSize);
    tileWidth = Math.max(1, Math.floor((gridSize[0] + navMeshConfig.tileSizeVoxels - 1) / navMeshConfig.tileSizeVoxels));
    tileHeight = Math.max(1, Math.floor((gridSize[1] + navMeshConfig.tileSizeVoxels - 1) / navMeshConfig.tileSizeVoxels));

    navMesh.tileWidth = tileSizeWorld;
    navMesh.tileHeight = tileSizeWorld;
    navMesh.origin = meshBounds[0];
};

const rebuildStaticTileCaches = () => {
    tileBoundsCache.clear();
    tileExpandedBoundsCache.clear();
    tileStaticTriangles.clear();

    const borderOffset = navMeshConfig.borderSize * navMeshConfig.cellSize;
    const triangle = triangle3.create();

    for (let tx = 0; tx < tileWidth; tx++) {
        for (let ty = 0; ty < tileHeight; ty++) {
            const min: Vec3 = [
                meshBounds[0][0] + tx * tileSizeWorld,
                meshBounds[0][1],
                meshBounds[0][2] + ty * tileSizeWorld,
            ];
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
};

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

// create an empty navmesh and build context; we'll build tiles via the queue
const buildCtx = BuildContext.create();
const navMesh = createNavMesh();

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

for (const offMeshConnection of offMeshConnections) {
    addOffMeshConnection(navMesh, offMeshConnection);
}

const offMeshConnectionsHelper = createNavMeshOffMeshConnectionsHelper(navMesh);
scene.add(offMeshConnectionsHelper.object);

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

const physicsObjects: PhysicsObj[] = [];
const tileToObjects = new Map<string, Set<number>>();

const dirtyTiles = new Set<string>();
const rebuildQueue: Array<[number, number]> = [];

// per-tile debug helpers (so we can update visuals only for tiles that changed)
const tileHelpers = new Map<string, DebugObject>();

// per-tile last rebuild timestamp (ms)
const tileLastRebuilt = new Map<string, number>();

// per-tile flash effect tracking
type TileFlash = {
    startTime: number;
    duration: number;
};
const tileFlashes = new Map<string, TileFlash>();

// throttle in ms
const TILE_REBUILD_THROTTLE_MS = { current: navMeshConfig.tileRebuildThrottleMs };

const enqueueTile = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= tileWidth || y >= tileHeight) return;
    const key = tileKey(x, y);
    if (dirtyTiles.has(key)) return;
    dirtyTiles.add(key);
    rebuildQueue.push([x, y]);
};

const getTileBounds = (x: number, y: number) => {
    const cached = tileBoundsCache.get(tileKey(x, y));
    if (cached) return cached;

    const min: Vec3 = [meshBounds[0][0] + x * tileSizeWorld, meshBounds[0][1], meshBounds[0][2] + y * tileSizeWorld];
    const max: Vec3 = [meshBounds[0][0] + (x + 1) * tileSizeWorld, meshBounds[1][1], meshBounds[0][2] + (y + 1) * tileSizeWorld];
    const bounds: [Vec3, Vec3] = [min, max];
    tileBoundsCache.set(tileKey(x, y), bounds);
    return bounds;
};

const getExpandedTileBounds = (x: number, y: number) => {
    const cached = tileExpandedBoundsCache.get(tileKey(x, y));
    if (cached) return cached;

    const base = getTileBounds(x, y);
    const borderOffset = navMeshConfig.borderSize * navMeshConfig.cellSize;
    const expandedMin: Vec3 = [base[0][0] - borderOffset, base[0][1], base[0][2] - borderOffset];
    const expandedMax: Vec3 = [base[1][0] + borderOffset, base[1][1], base[1][2] + borderOffset];
    const expanded: [Vec3, Vec3] = [expandedMin, expandedMax];
    tileExpandedBoundsCache.set(tileKey(x, y), expanded);
    return expanded;
};

const processRebuildQueue = (maxPerFrame: number) => {
    let processed = 0;

    for (let i = 0; i < rebuildQueue.length; i++) {
        if (processed >= maxPerFrame) break;

        const tile = rebuildQueue.shift();
        if (!tile) return;
        const [tx, ty] = tile;
        const key = tileKey(tx, ty);

        // if this tile was rebuilt recently, skip and re-enqueue
        const last = tileLastRebuilt.get(key) ?? 0;
        const now = performance.now();
        if (now - last < TILE_REBUILD_THROTTLE_MS.current) {
            rebuildQueue.push([tx, ty]);
            continue;
        }

        // we are rebuilding this tile now, remove from dirty set
        dirtyTiles.delete(key);

        try {
            const expandedBounds = getExpandedTileBounds(tx, ty);
            const expandedBox = expandedBounds as any;

            const hfSize = Math.floor(navMeshConfig.tileSizeVoxels + navMeshConfig.borderSize * 2);
            const heightfield = createHeightfield(
                hfSize,
                hfSize,
                expandedBox,
                navMeshConfig.cellSize,
                navMeshConfig.cellHeight,
            );

            const staticTriangles = tileStaticTriangles.get(key) ?? [];
            if (staticTriangles.length > 0) {
                const staticAreaIds = new Uint8Array(staticTriangles.length / 3);
                markWalkableTriangles(
                    levelPositions,
                    staticTriangles,
                    staticAreaIds,
                    navMeshConfig.walkableSlopeAngleDegrees,
                );
                rasterizeTriangles(
                    buildCtx,
                    heightfield,
                    levelPositions,
                    staticTriangles,
                    staticAreaIds,
                    walkableClimbVoxels,
                );
            }

            const influencing = tileToObjects.get(key);
            if (influencing && influencing.size > 0) {
                for (const objIndex of influencing) {
                    const obj = physicsObjects[objIndex];
                    if (!obj) continue;

                    const meshData = extractMeshWorldTriangles(obj.mesh);
                    if (!meshData) continue;

                    const { positions, indices } = meshData;
                    if (indices.length === 0) continue;

                    const areaIds = new Uint8Array(indices.length / 3);
                    markWalkableTriangles(
                        positions,
                        indices,
                        areaIds,
                        navMeshConfig.walkableSlopeAngleDegrees,
                    );
                    rasterizeTriangles(buildCtx, heightfield, positions, indices, areaIds, walkableClimbVoxels);
                }
            }

            filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
            filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
            filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

            const chf = buildCompactHeightfield(buildCtx, walkableHeightVoxels, walkableClimbVoxels, heightfield);
            erodeWalkableArea(walkableRadiusVoxels, chf);
            buildDistanceField(chf);

            buildRegions(buildCtx, chf, navMeshConfig.borderSize, navMeshConfig.minRegionArea, navMeshConfig.mergeRegionArea);

            const contourSet = buildContours(
                buildCtx,
                chf,
                navMeshConfig.maxSimplificationError,
                navMeshConfig.maxEdgeLength,
                ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
            );

            const polyMesh = buildPolyMesh(buildCtx, contourSet, navMeshConfig.maxVerticesPerPoly);

            for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
                if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
                    polyMesh.areas[polyIndex] = 0;
                }

                if (polyMesh.areas[polyIndex] === 0) {
                    polyMesh.flags[polyIndex] = 1;
                }
            }

            const polyMeshDetail = buildPolyMeshDetail(buildCtx, polyMesh, chf, detailSampleDistance, detailSampleMaxError);

            const tilePolys = polyMeshToTilePolys(polyMesh);
            const tileDetail = polyMeshDetailToTileDetailMesh(tilePolys.polys, polyMeshDetail);

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
                cellSize: navMeshConfig.cellSize,
                cellHeight: navMeshConfig.cellHeight,
                walkableHeight: navMeshConfig.walkableHeightWorld,
                walkableRadius: navMeshConfig.walkableRadiusWorld,
                walkableClimb: navMeshConfig.walkableClimbWorld,
            } as any;

            const tile = buildTile(tileParams);

            // remove any old tile at this location
            removeTile(navMesh, tx, ty, 0);

            // add the new tile
            addTile(navMesh, tile);

            // recreate the tile debug helper
            const tileKeyStr = tileKey(tx, ty);
            const oldTileHelper = tileHelpers.get(tileKeyStr);
            if (oldTileHelper) {
                scene.remove(oldTileHelper.object);
                oldTileHelper.dispose();
                tileHelpers.delete(tileKeyStr);
            }

            for (const tileId in navMesh.tiles) {
                const t = navMesh.tiles[tileId];
                if (t.tileX === tx && t.tileY === ty) {
                    const newTileHelper = createNavMeshTileHelper(t);
                    newTileHelper.object.position.y += 0.05;
                    scene.add(newTileHelper.object);
                    tileHelpers.set(tileKeyStr, newTileHelper);

                    tileFlashes.set(tileKeyStr, {
                        startTime: performance.now(),
                        duration: 1500,
                    });

                    break;
                }
            }

            // record rebuild time
            tileLastRebuilt.set(key, performance.now());

            // count this as a processed tile
            processed++;
        } catch (err) {
            // log and continue
            console.error('Tile build failed', err);
            processed++;
        }
    }
};

const buildAllTiles = (batchSize = 64) => {
    while (rebuildQueue.length > 0) {
        processRebuildQueue(batchSize);
    }
};

const clearTileHelpers = () => {
    for (const helper of tileHelpers.values()) {
        scene.remove(helper.object);
        helper.dispose();
    }
    tileHelpers.clear();
};

const removeAllNavMeshTiles = () => {
    const existingTiles = Object.values(navMesh.tiles ?? {});
    for (const tile of existingTiles) {
        if (!tile) continue;
        removeTile(navMesh, tile.tileX, tile.tileY, tile.tileLayer ?? 0);
    }
};

const repopulateTileObjectMapping = () => {
    tileToObjects.clear();

    for (let i = 0; i < physicsObjects.length; i++) {
        const obj = physicsObjects[i];
        if (!obj) continue;

        const translation = obj.rigidBody.translation();
        const radius = obj.radius ?? 0.5;
        const min: Vec3 = [translation.x - radius, translation.y - radius, translation.z - radius];
        const max: Vec3 = [translation.x + radius, translation.y + radius, translation.z + radius];

        const tiles = tilesForAABB(min, max);
        const newTiles = new Set<string>();

        for (const [tx, ty] of tiles) {
            if (tx < 0 || ty < 0 || tx >= tileWidth || ty >= tileHeight) continue;
            const k = tileKey(tx, ty);
            newTiles.add(k);

            let set = tileToObjects.get(k);
            if (!set) {
                set = new Set<number>();
                tileToObjects.set(k, set);
            }
            set.add(i);
        }

        obj.lastTiles = newTiles;
        obj.lastPosition = [translation.x, translation.y, translation.z];
    }
};

const queueAllTiles = () => {
    for (let tx = 0; tx < tileWidth; tx++) {
        for (let ty = 0; ty < tileHeight; ty++) {
            enqueueTile(tx, ty);
        }
    }
};

function rebuildAllTiles(immediate = true) {
    updateNavMeshDerivedValues();
    rebuildStaticTileCaches();

    clearTileHelpers();
    tileLastRebuilt.clear();
    tileFlashes.clear();
    dirtyTiles.clear();
    rebuildQueue.length = 0;

    removeAllNavMeshTiles();
    repopulateTileObjectMapping();

    queueAllTiles();

    if (immediate) {
        buildAllTiles();
    }
}

// compute the list of tiles overlapping an AABB (min/max Vec3)
const tilesForAABB = (min: Vec3, max: Vec3) => {
    if (tileWidth <= 0 || tileHeight <= 0 || tileSizeWorld <= 0) return [];

    const rawMinX = Math.floor((min[0] - meshBounds[0][0]) / tileSizeWorld);
    const rawMinY = Math.floor((min[2] - meshBounds[0][2]) / tileSizeWorld);
    const rawMaxX = Math.floor((max[0] - meshBounds[0][0]) / tileSizeWorld);
    const rawMaxY = Math.floor((max[2] - meshBounds[0][2]) / tileSizeWorld);

    const clampIndex = (value: number, maxValue: number) => Math.min(Math.max(value, 0), maxValue);

    const minX = clampIndex(rawMinX, tileWidth - 1);
    const minY = clampIndex(rawMinY, tileHeight - 1);
    const maxX = clampIndex(rawMaxX, tileWidth - 1);
    const maxY = clampIndex(rawMaxY, tileHeight - 1);

    if (minX > maxX || minY > maxY) return [];

    const out: Array<[number, number]> = [];
    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            out.push([x, y]);
        }
    }
    return out;
};

// helper: update tile registrations for a single physics object index based on newTiles
const updateObjectTiles = (objIndex: number, newTiles: Set<string>) => {
    const obj = physicsObjects[objIndex];
    if (!obj) return;

    // compute tiles to remove (in lastTiles but not in newTiles)
    for (const oldKey of obj.lastTiles) {
        if (!newTiles.has(oldKey)) {
            const s = tileToObjects.get(oldKey);
            if (s) {
                s.delete(objIndex);
                if (s.size === 0) tileToObjects.delete(oldKey);
            }
        }
    }

    // compute tiles to add (in newTiles but not in lastTiles)
    for (const newKey of newTiles) {
        if (!obj.lastTiles.has(newKey)) {
            let s = tileToObjects.get(newKey);
            if (!s) {
                s = new Set<number>();
                tileToObjects.set(newKey, s);
            }
            s.add(objIndex);
        }
    }

    // replace lastTiles with newTiles
    obj.lastTiles = newTiles;
};

/* perform initial synchronous build of all tiles */
rebuildAllTiles();

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

    const tiles = tilesForAABB(min, max);
    const tilesSet = new Set<string>();
    for (const [tx, ty] of tiles) {
        const k = tileKey(tx, ty);
        tilesSet.add(k);
        let s = tileToObjects.get(k);
        if (!s) {
            s = new Set<number>();
            tileToObjects.set(k, s);
        }
        s.add(i);
        enqueueTile(tx, ty);
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

    physicsObjects.push(physicsObject);
}

/* Agent visuals */
type AgentVisuals = {
    group: THREE.Group; // cat model group
    mixer: THREE.AnimationMixer; // animation mixer for cat
    idleAction: THREE.AnimationAction;
    walkAction: THREE.AnimationAction;
    runAction: THREE.AnimationAction;
    currentAnimation: 'idle' | 'walk' | 'run';
    currentRotation: number; // current Y rotation for lerping
    targetRotation: number; // target Y rotation
    color: number;

    targetMesh: THREE.Mesh;
    pathLine: THREE.Line | null;
};

type AgentVisualsOptions = {
    showPathLine?: boolean;
};

const cloneCatModel = (color?: number): THREE.Group => {
    const clone = catModel.scene.clone(true);

    const patchMaterial = (material: THREE.Material): THREE.Material => {
        if (
            color !== undefined &&
            (material instanceof THREE.MeshLambertMaterial ||
                material instanceof THREE.MeshStandardMaterial ||
                material instanceof THREE.MeshPhongMaterial)
        ) {
            const clonedMat = material.clone();

            clonedMat.color.setHex(color);
            clonedMat.color.multiplyScalar(2);

            if (clonedMat instanceof THREE.MeshStandardMaterial) {
                clonedMat.emissive.setHex(color);
                clonedMat.emissiveIntensity = 0.1;
                clonedMat.roughness = 0.3;
                clonedMat.metalness = 0.1;
            }

            return clonedMat;
        }

        return material;
    };

    // clone SkinnedMeshes
    const skinnedMeshes: THREE.SkinnedMesh[] = [];

    clone.traverse((child) => {
        if (child instanceof THREE.SkinnedMesh) {
            skinnedMeshes.push(child);
        }

        if (child instanceof THREE.Mesh) {
            if (Array.isArray(child.material)) {
                child.material = child.material.map(patchMaterial);
            } else {
                child.material = patchMaterial(child.material);
            }
        }
    });

    // fix skeleton references for SkinnedMesh
    for (const skinnedMesh of skinnedMeshes) {
        const skeleton = skinnedMesh.skeleton;
        const bones: THREE.Bone[] = [];

        for (const bone of skeleton.bones) {
            const foundBone = clone.getObjectByName(bone.name);
            if (foundBone instanceof THREE.Bone) {
                bones.push(foundBone);
            }
        }

        skinnedMesh.bind(new THREE.Skeleton(bones, skeleton.boneInverses));
    }

    return clone;
};

const createAgentVisuals = (position: Vec3, scene: THREE.Scene, color: number, radius: number): AgentVisuals => {
    const catGroup = cloneCatModel(color);
    catGroup.position.set(position[0], position[1], position[2]);
    catGroup.scale.setScalar(radius * 1.5);
    scene.add(catGroup);

    const mixer = new THREE.AnimationMixer(catGroup);

    const idleClip = catAnimations.find((clip) => clip.name === 'Idle');
    const walkClip = catAnimations.find((clip) => clip.name === 'Walk');
    const runClip = catAnimations.find((clip) => clip.name === 'Run');

    if (!idleClip || !walkClip || !runClip) {
        throw new Error('Missing required animations in cat model');
    }

    const idleAction = mixer.clipAction(idleClip);
    const walkAction = mixer.clipAction(walkClip);
    const runAction = mixer.clipAction(runClip);

    idleAction.loop = THREE.LoopRepeat;
    walkAction.loop = THREE.LoopRepeat;
    runAction.loop = THREE.LoopRepeat;

    idleAction.play();

    const targetGeometry = new THREE.SphereGeometry(0.1);
    const targetMaterial = new THREE.MeshBasicMaterial({ color });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    scene.add(targetMesh);

    return {
        group: catGroup,
        mixer,
        idleAction,
        walkAction,
        runAction,
        currentAnimation: 'idle',
        currentRotation: 0,
        targetRotation: 0,
        color,
        targetMesh,
        pathLine: null,
    };
};

const updateAgentVisuals = (
    agent: crowd.Agent,
    visuals: AgentVisuals,
    scene: THREE.Scene,
    deltaTime: number,
    options: AgentVisualsOptions = {},
): void => {
    // update animation mixer
    visuals.mixer.update(deltaTime);

    // update cat model position and rotation
    visuals.group.position.fromArray(agent.position);

    // calculate velocity and determine animation
    const velocity = vec3.length(agent.velocity);
    let targetAnimation: 'idle' | 'walk' | 'run' = 'idle';

    if (velocity > 2.5) {
        targetAnimation = 'run';
    } else if (velocity > 0.1) {
        targetAnimation = 'walk';
    }

    // handle animation transitions
    if (visuals.currentAnimation !== targetAnimation) {
        const currentAction =
            visuals.currentAnimation === 'idle'
                ? visuals.idleAction
                : visuals.currentAnimation === 'walk'
                  ? visuals.walkAction
                  : visuals.runAction;

        const targetAction =
            targetAnimation === 'idle' ? visuals.idleAction : targetAnimation === 'walk' ? visuals.walkAction : visuals.runAction;

        // cross-fade to new animation
        currentAction.fadeOut(0.3);
        targetAction.reset().fadeIn(0.3).play();

        visuals.currentAnimation = targetAnimation;
    }

    // rotate cat to face movement direction with lerping
    const minVelocityThreshold = 0.1; // minimum velocity to trigger rotation
    const rotationLerpSpeed = 5.0; // how fast to lerp towards target rotation

    if (velocity > minVelocityThreshold) {
        const direction = vec3.normalize([0, 0, 0], agent.velocity);
        const targetAngle = Math.atan2(direction[0], direction[2]);
        visuals.targetRotation = targetAngle;
    } else {
        const targetDirection = vec3.subtract([0, 0, 0], agent.targetPosition, agent.position);
        const targetDistance = vec3.length(targetDirection);

        if (targetDistance > 0.1) {
            const normalizedTarget = vec3.normalize([0, 0, 0], targetDirection);
            const targetAngle = Math.atan2(normalizedTarget[0], normalizedTarget[2]);
            visuals.targetRotation = targetAngle;
        }
    }

    // lerp current rotation towards target rotation
    let angleDiff = visuals.targetRotation - visuals.currentRotation;

    // handle angle wrapping (shortest path)
    if (angleDiff > Math.PI) {
        angleDiff -= 2 * Math.PI;
    } else if (angleDiff < -Math.PI) {
        angleDiff += 2 * Math.PI;
    }

    // apply lerp
    visuals.currentRotation += angleDiff * rotationLerpSpeed * deltaTime;

    // apply rotation to cat
    visuals.group.rotation.y = visuals.currentRotation;

    // update target mesh position
    visuals.targetMesh.position.fromArray(agent.targetPosition);
    visuals.targetMesh.position.y += 0.1;

    // path line visualization
    if (options.showPathLine) {
        const corners = pathCorridor.findCorners(agent.corridor, navMesh, 3);

        if (corners && corners.length > 1) {
            // validate coordinates
            const validPoints: THREE.Vector3[] = [];

            // add agent position
            if (Number.isFinite(agent.position[0]) && Number.isFinite(agent.position[1]) && Number.isFinite(agent.position[2])) {
                validPoints.push(new THREE.Vector3(agent.position[0], agent.position[1] + 0.2, agent.position[2]));
            }

            // add corners
            for (const corner of corners) {
                if (
                    Number.isFinite(corner.position[0]) &&
                    Number.isFinite(corner.position[1]) &&
                    Number.isFinite(corner.position[2])
                ) {
                    validPoints.push(new THREE.Vector3(corner.position[0], corner.position[1] + 0.2, corner.position[2]));
                }
            }

            if (validPoints.length > 1) {
                if (!visuals.pathLine) {
                    // create new path line
                    const geometry = new THREE.BufferGeometry().setFromPoints(validPoints);
                    const material = new THREE.LineBasicMaterial({ color: visuals.color, linewidth: 2 });
                    visuals.pathLine = new THREE.Line(geometry, material);
                    scene.add(visuals.pathLine);
                } else {
                    // update existing path line
                    const geometry = visuals.pathLine.geometry as THREE.BufferGeometry;
                    geometry.setFromPoints(validPoints);
                    visuals.pathLine.visible = true;
                }
            } else if (visuals.pathLine) {
                visuals.pathLine.visible = false;
            }
        } else if (visuals.pathLine) {
            visuals.pathLine.visible = false;
        }
    } else {
        // hide path line when disabled
        if (visuals.pathLine) {
            visuals.pathLine.visible = false;
        }
    }
};

/* create crowd and agents */
const catsCrowd = crowd.create(1);

console.log(catsCrowd);

const agentParams: crowd.AgentParams = {
    radius: 0.3,
    height: 0.6,
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
    const agentId = crowd.addAgent(catsCrowd, navMesh, position, agentParams);
    console.log(`Creating agent ${i} at position:`, position);

    // create visuals for the agent
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, agentParams.radius);
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
        navMesh,
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
    crowd.update(catsCrowd, navMesh, clampedDeltaTime);

    // update physics
    physicsWorld.timestep = clampedDeltaTime;
    physicsWorld.step();

    // update physics object transforms
    for (const obj of physicsObjects) {
        const position = obj.rigidBody.translation();
        const rotation = obj.rigidBody.rotation();

        obj.mesh.position.set(position.x, position.y, position.z);
        obj.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }

    // respawn boxes that fall below certain height OR every 10 seconds since last respawn
    const RESPAWN_INTERVAL_MS = 10000;
    for (const obj of physicsObjects) {
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
            const tiles = tilesForAABB(min, max);
            const newTiles = new Set<string>();
            for (const [tx, ty] of tiles) {
                newTiles.add(tileKey(tx, ty));
            }

            const idx = physicsObjects.indexOf(obj);
            if (idx !== -1) {
                updateObjectTiles(idx, newTiles);
            }

            obj.lastPosition[0] = x;
            obj.lastPosition[1] = y;
            obj.lastPosition[2] = z;
            obj.lastRespawn = nowMs;
        }
    }

    // schedule tiles based on movements of physics objects between tiles
    for (let i = 0; i < physicsObjects.length; i++) {
        const obj = physicsObjects[i];
        const posNow = obj.rigidBody.translation();
        const curPos: Vec3 = [posNow.x, posNow.y, posNow.z];

        // compute swept AABB between lastPosition and curPos expanded by radius
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

        const tiles = tilesForAABB(min, max);
        const newTiles = new Set<string>();
        for (const [tx, ty] of tiles) {
            newTiles.add(tileKey(tx, ty));
        }

        const isSleeping = obj.rigidBody.isSleeping();

        // rebuild tiles we left (object no longer present, needs removal)
        for (const oldKey of obj.lastTiles) {
            if (!newTiles.has(oldKey)) {
                const parts = oldKey.split('_');
                const tx = parseInt(parts[0], 10);
                const ty = parseInt(parts[1], 10);
                enqueueTile(tx, ty);
            }
        }

        // rebuild current tiles only if object is awake (moving/settling)
        if (!isSleeping) {
            for (const newKey of newTiles) {
                const parts = newKey.split('_');
                const tx = parseInt(parts[0], 10);
                const ty = parseInt(parts[1], 10);
                enqueueTile(tx, ty);
            }
        }

        // update object tile registrations
        updateObjectTiles(i, newTiles);

        // save current position for next frame
        obj.lastPosition = curPos;
    }

    // process at most 1 tile rebuild per frame
    console.time('tick processRebuildQueue');
    processRebuildQueue(1);
    console.timeEnd('tick processRebuildQueue');

    // update tile visuals
    const now = performance.now();
    const flashesToRemove: string[] = [];

    for (const [tileKey, flash] of tileFlashes) {
        const elapsed = now - flash.startTime;
        const t = Math.min(elapsed / flash.duration, 1.0); // normalized time [0, 1]

        const tileHelper = tileHelpers.get(tileKey);
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
            flashesToRemove.push(tileKey);
        }
    }

    for (const key of flashesToRemove) {
        tileFlashes.delete(key);
    }

    // Rapier debug rendering (lines)
    renderRapierDebug();

    // update agent visuals
    const agents = Object.keys(catsCrowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = catsCrowd.agents[agentId];

        if (agentVisuals[agentId]) {
            updateAgentVisuals(agent, agentVisuals[agentId], scene, clampedDeltaTime, {
                showPathLine: guiSettings.showPathLine,
            });
        }
    }

    // update controls
    orbitControls.update(clampedDeltaTime);

    // render
    renderer.render(scene, camera);
}

update();
