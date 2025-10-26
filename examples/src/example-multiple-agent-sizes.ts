import { GUI } from 'lil-gui';
import { box3, createMulberry32Generator, vec2, type Vec3, vec3 } from 'mathcat';
import {
    addOffMeshConnection,
    addTile,
    ANY_QUERY_FILTER,
    buildCompactHeightfield,
    BuildContext,
    type BuildContextState,
    buildContours,
    buildDistanceField,
    buildPolyMesh,
    buildPolyMeshDetail,
    buildRegionsMonotone,
    buildTile,
    calculateGridSize,
    calculateMeshBounds,
    type CompactHeightfield,
    ContourBuildFlags,
    type ContourSet,
    createFindNearestPolyResult,
    createHeightfield,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    erodeAndMarkWalkableAreas,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    findNearestPoly,
    findRandomPoint,
    getNodeByRef,
    getNodeByTileAndPoly,
    type Heightfield,
    markWalkableTriangles,
    medianFilterWalkableArea,
    type NavMesh,
    type NavMeshTileParams,
    type NodeRef,
    OffMeshConnectionDirection,
    type OffMeshConnectionParams,
    type PolyMesh,
    type PolyMeshDetail,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    type QueryFilter,
    rasterizeTriangles,
    WALKABLE_AREA,
} from 'navcat';
import type { TiledNavMeshInput } from 'navcat/blocks';
import {
    createCompactHeightfieldDistancesHelper,
    createCompactHeightfieldRegionsHelper,
    createCompactHeightfieldSolidHelper,
    createHeightfieldHelper,
    createNavMeshBvTreeHelper,
    createNavMeshHelper,
    createNavMeshOffMeshConnectionsHelper,
    createNavMeshPolyHelper,
    createPolyMeshDetailHelper,
    createPolyMeshHelper,
    createRawContoursHelper,
    createSimplifiedContoursHelper,
    createTriangleAreaIdsHelper,
    type DebugObject,
    getPositionsAndIndices,
} from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';
import { crowd, pathCorridor } from 'navcat/blocks';

const random = createMulberry32Generator(42);

enum AreaId {
    WALKABLE = 1,
    WALKABLE_NARROW = 2,
}

type SoloNavMeshInput = {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
};

type SoloNavMeshOptions = {
    cellSize: number;
    cellHeight: number;
    walkableRadiusVoxels: number;
    walkableRadiusWorld: number;
    walkableRadiusThresholds: Array<{ areaId: number; walkableRadiusVoxels: number }>;
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

type SoloNavMeshIntermediates = {
    buildContext: BuildContextState;
    input: SoloNavMeshInput;
    triAreaIds: Uint8Array;
    heightfield: Heightfield;
    compactHeightfield: CompactHeightfield;
    contourSet: ContourSet;
    polyMesh: PolyMesh;
    polyMeshDetail: PolyMeshDetail;
};

type SoloNavMeshResult = {
    navMesh: NavMesh;
    intermediates: SoloNavMeshIntermediates;
};

function generateSoloNavMesh(input: SoloNavMeshInput, options: SoloNavMeshOptions): SoloNavMeshResult {
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

    /* 1. input positions and indices are already provided */
    BuildContext.start(ctx, 'mark walkable triangles');

    /* 2. mark walkable triangles */
    const triAreaIds = new Uint8Array(indices.length / 3).fill(0);
    markWalkableTriangles(positions, indices, triAreaIds, walkableSlopeAngleDegrees);

    BuildContext.end(ctx, 'mark walkable triangles');

    /* 3. rasterize the triangles to a voxel heightfield */
    BuildContext.start(ctx, 'rasterize triangles');

    const bounds = calculateMeshBounds(box3.create(), positions, indices);
    const [heightfieldWidth, heightfieldHeight] = calculateGridSize(vec2.create(), bounds, cellSize);

    const heightfield = createHeightfield(heightfieldWidth, heightfieldHeight, bounds, cellSize, cellHeight);

    rasterizeTriangles(ctx, heightfield, positions, indices, triAreaIds, walkableClimbVoxels);

    BuildContext.end(ctx, 'rasterize triangles');

    /* 4. filter walkable surfaces */
    BuildContext.start(ctx, 'filter walkable surfaces');

    filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
    filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
    filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

    BuildContext.end(ctx, 'filter walkable surfaces');

    /* 5. compact the heightfield */
    BuildContext.start(ctx, 'build compact heightfield');

    const compactHeightfield = buildCompactHeightfield(ctx, walkableHeightVoxels, walkableClimbVoxels, heightfield);

    BuildContext.end(ctx, 'build compact heightfield');

    /* 6. erode walkable area and mark restricted areas for multi-agent support */
    BuildContext.start(ctx, 'erode and mark walkable areas');

    // Erode with smallest agent radius and mark narrow areas as restricted for larger agents
    // This computes the distance field once for better performance
    erodeAndMarkWalkableAreas(walkableRadiusVoxels, options.walkableRadiusThresholds, compactHeightfield);

    BuildContext.end(ctx, 'erode and mark walkable areas');

    medianFilterWalkableArea(compactHeightfield);

    /* 7. prepare for region partitioning by calculating a distance field along the walkable surface */
    BuildContext.start(ctx, 'build compact heightfield distance field');

    buildDistanceField(compactHeightfield);

    BuildContext.end(ctx, 'build compact heightfield distance field');

    /* 8. partition the walkable surface into simple regions without holes */
    BuildContext.start(ctx, 'build compact heightfield regions');

    // NOTE: buildRegionsMonotone provides a better result than buildRegions for this use case, given we have marked lots of smaller areas
    buildRegionsMonotone(compactHeightfield, borderSize, minRegionArea, mergeRegionArea);

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

    // Process poly areas and flags
    for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
        // Convert WALKABLE_AREA (63) to our custom area IDs
        if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
            // Default to area 1 (WALKABLE) if not already marked as restricted
            polyMesh.areas[polyIndex] = AreaId.WALKABLE;
        }

        // Set flags for all walkable polys (both WALKABLE and WALKABLE_NARROW)
        if (polyMesh.areas[polyIndex] !== 0) {
            polyMesh.flags[polyIndex] = 1;
        }
    }

    BuildContext.end(ctx, 'build polygons mesh from contours');

    /* 11. create detail mesh which allows to access approximate height on each polygon */
    BuildContext.start(ctx, 'build detail mesh from contours');

    const polyMeshDetail = buildPolyMeshDetail(ctx, polyMesh, compactHeightfield, detailSampleDistance, detailSampleMaxError);

    BuildContext.end(ctx, 'build detail mesh from contours');

    BuildContext.end(ctx, 'navmesh generation');

    /* store intermediates for debugging */
    const intermediates: SoloNavMeshIntermediates = {
        buildContext: ctx,
        input: {
            positions,
            indices,
        },
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
/* controls */
const guiSettings = {
    showVelocityVectors: true,
    showPathLine: false,
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
    showOffMeshConnections: true,
};

const gui = new GUI();

const agentFolder = gui.addFolder('Agent Display');
agentFolder.add(guiSettings, 'showVelocityVectors').name('Show Velocity Vectors');
agentFolder.add(guiSettings, 'showPathLine').name('Show Path Line');
agentFolder.open();

const debugFolder = gui.addFolder('Debug Helpers');
debugFolder
    .add(guiSettings, 'showMesh')
    .name('Show Mesh')
    .onChange(() => {
        levelModel.scene.visible = guiSettings.showMesh;
    });
debugFolder.add(guiSettings, 'showTriangleAreaIds').name('Triangle Area IDs').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showHeightfield').name('Heightfield').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showCompactHeightfieldSolid').name('Compact Heightfield Solid').onChange(updateDebugHelpers);
debugFolder
    .add(guiSettings, 'showCompactHeightfieldDistances')
    .name('Compact Heightfield Distances')
    .onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showCompactHeightfieldRegions').name('Compact Heightfield Regions').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showRawContours').name('Raw Contours').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showSimplifiedContours').name('Simplified Contours').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showPolyMesh').name('Poly Mesh').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showPolyMeshDetail').name('Poly Mesh Detail').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showNavMeshBvTree').name('NavMesh BV Tree').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showNavMesh').name('NavMesh').onChange(updateDebugHelpers);
debugFolder.add(guiSettings, 'showOffMeshConnections').name('Off-Mesh Connections').onChange(updateDebugHelpers);

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

/* load level model */
const levelModel = await loadGLTF('/models/nav-test.glb');
scene.add(levelModel.scene);

/* generate navmesh */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = getPositionsAndIndices(walkableMeshes);

const navMeshInput: TiledNavMeshInput = {
    positions,
    indices,
};

const cellSize = 0.05;
const cellHeight = 0.2;

const walkableRadiusWorld = 0.15;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);

const smallAgentRadiusWorld = walkableRadiusWorld;
const largeAgentRadiusWorld = 0.45;

const walkableRadiusThresholds = [
    {
        areaId: AreaId.WALKABLE_NARROW,
        walkableRadiusVoxels: Math.ceil(largeAgentRadiusWorld / cellSize),
    },
];

const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 1;
const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);
const walkableSlopeAngleDegrees = 45;

const borderSize = 4;
const minRegionArea = 4;
const mergeRegionArea = 20;

const maxSimplificationError = 1.3;
const maxEdgeLength = 12;

const maxVerticesPerPoly = 5;

const detailSampleDistanceVoxels = 6;
const detailSampleDistance = detailSampleDistanceVoxels < 0.9 ? 0 : cellSize * detailSampleDistanceVoxels;

const detailSampleMaxErrorVoxels = 1;
const detailSampleMaxError = cellHeight * detailSampleMaxErrorVoxels;

const navMeshConfig: SoloNavMeshOptions = {
    cellSize,
    cellHeight,
    walkableRadiusThresholds,
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

const navMeshResult = generateSoloNavMesh(navMeshInput, navMeshConfig);
const navMesh = navMeshResult.navMesh;

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
    offMeshConnections: DebugObject | null;
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
    offMeshConnections: null,
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
    debugHelpers.offMeshConnections = null;
}

function updateDebugHelpers() {
    // Clear existing helpers
    clearDebugHelpers();

    const { intermediates } = navMeshResult;

    // Create debug helpers based on current config
    if (guiSettings.showTriangleAreaIds) {
        debugHelpers.triangleAreaIds = createTriangleAreaIdsHelper(intermediates.input, intermediates.triAreaIds);
        scene.add(debugHelpers.triangleAreaIds.object);
    }

    if (guiSettings.showHeightfield) {
        debugHelpers.heightfield = createHeightfieldHelper(intermediates.heightfield);
        scene.add(debugHelpers.heightfield.object);
    }

    if (guiSettings.showCompactHeightfieldSolid) {
        debugHelpers.compactHeightfieldSolid = createCompactHeightfieldSolidHelper(intermediates.compactHeightfield);
        scene.add(debugHelpers.compactHeightfieldSolid.object);
    }

    if (guiSettings.showCompactHeightfieldDistances) {
        debugHelpers.compactHeightfieldDistances = createCompactHeightfieldDistancesHelper(intermediates.compactHeightfield);
        scene.add(debugHelpers.compactHeightfieldDistances.object);
    }

    if (guiSettings.showCompactHeightfieldRegions) {
        debugHelpers.compactHeightfieldRegions = createCompactHeightfieldRegionsHelper(intermediates.compactHeightfield);
        scene.add(debugHelpers.compactHeightfieldRegions.object);
    }

    if (guiSettings.showRawContours) {
        debugHelpers.rawContours = createRawContoursHelper(intermediates.contourSet);
        scene.add(debugHelpers.rawContours.object);
    }

    if (guiSettings.showSimplifiedContours) {
        debugHelpers.simplifiedContours = createSimplifiedContoursHelper(intermediates.contourSet);
        scene.add(debugHelpers.simplifiedContours.object);
    }

    if (guiSettings.showPolyMesh) {
        debugHelpers.polyMesh = createPolyMeshHelper(intermediates.polyMesh);
        scene.add(debugHelpers.polyMesh.object);
    }

    if (guiSettings.showPolyMeshDetail) {
        debugHelpers.polyMeshDetail = createPolyMeshDetailHelper(intermediates.polyMeshDetail);
        scene.add(debugHelpers.polyMeshDetail.object);
    }

    if (guiSettings.showNavMeshBvTree) {
        debugHelpers.navMeshBvTree = createNavMeshBvTreeHelper(navMesh);
        scene.add(debugHelpers.navMeshBvTree.object);
    }

    if (guiSettings.showNavMesh) {
        debugHelpers.navMesh = createNavMeshHelper(navMesh);
        debugHelpers.navMesh.object.position.y += 0.1;
        scene.add(debugHelpers.navMesh.object);
    }

    if (guiSettings.showOffMeshConnections) {
        debugHelpers.offMeshConnections = createNavMeshOffMeshConnectionsHelper(navMesh);
        scene.add(debugHelpers.offMeshConnections.object);
    }
}

// Initialize debug helpers
updateDebugHelpers();

/* Visuals */
type AgentVisuals = {
    mesh: THREE.Mesh; // capsule debug mesh
    color: number;

    targetMesh: THREE.Mesh;
    pathLine: THREE.Line | null;
    velocityArrow: THREE.ArrowHelper;
    desiredVelocityArrow: THREE.ArrowHelper;
};

type AgentVisualsOptions = {
    showPathLine?: boolean;
    showVelocityVectors?: boolean;
};

// poly visuals
type PolyHelper = {
    helper: DebugObject;
    polyRef: NodeRef;
};

const polyHelpers = new Map<NodeRef, PolyHelper>();

const createPolyHelpers = (navMesh: NavMesh, scene: THREE.Scene): void => {
    // create helpers for all polygons in the navmesh
    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const polyRef = getNodeByTileAndPoly(navMesh, tile, polyIndex).ref;

            const helper = createNavMeshPolyHelper(navMesh, polyRef, [0.3, 0.3, 1]);

            // initially hidden and semi-transparent
            helper.object.visible = false;
            helper.object.traverse((child: any) => {
                if (child instanceof THREE.Mesh && child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach((mat) => {
                            if (mat instanceof THREE.Material) {
                                mat.transparent = true;
                                mat.opacity = 0.5;
                            }
                        });
                    } else if (child.material instanceof THREE.Material) {
                        child.material.transparent = true;
                        child.material.opacity = 0.5;
                    }
                }
            });

            helper.object.position.y += 0.15; // adjust height for visibility
            scene.add(helper.object);

            polyHelpers.set(polyRef, {
                helper,
                polyRef,
            });
        }
    }
};

const createAgentVisuals = (position: Vec3, scene: THREE.Scene, color: number, radius: number, height: number): AgentVisuals => {
    // Create capsule debug mesh
    // CapsuleGeometry is centered, so we need to offset it up by (height/2 + radius)
    const geometry = new THREE.CapsuleGeometry(radius, height, 4, 8);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1] + height / 2 + radius, position[2]);
    scene.add(mesh);

    // create velocity arrows (initially hidden)
    const velocityArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1), // default direction
        new THREE.Vector3(position[0], position[1] + 0.5, position[2]), // origin
        0.5, // length
        0x00ff00, // green for actual velocity
        0.2, // head length
        0.1, // head width
    );
    velocityArrow.visible = false;
    scene.add(velocityArrow);

    const desiredVelocityArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1), // default direction
        new THREE.Vector3(position[0], position[1] + 0.6, position[2]), // origin
        0.5, // length
        0xff0000, // red for desired velocity
        0.2, // head length
        0.1, // head width
    );
    desiredVelocityArrow.visible = false;
    scene.add(desiredVelocityArrow);

    // target mesh
    const targetGeometry = new THREE.SphereGeometry(0.1, 8, 8);
    const targetMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    targetMesh.position.set(position[0], position[1] + 0.1, position[2]);
    scene.add(targetMesh);

    return {
        mesh,
        color,
        velocityArrow,
        desiredVelocityArrow,
        targetMesh,
        pathLine: null,
    };
};

const updateAgentVisuals = (agent: crowd.Agent, visuals: AgentVisuals, scene: THREE.Scene, options: AgentVisualsOptions = {}): void => {
    // Update agent mesh position (capsule debug)
    // CapsuleGeometry is centered, so offset up by (height/2 + radius)
    visuals.mesh.position.fromArray(agent.position);
    visuals.mesh.position.y += agent.params.height / 2 + agent.params.radius;

    // update target mesh position
    visuals.targetMesh.position.fromArray(agent.targetPosition);
    visuals.targetMesh.position.y += 0.1;

    // handle path line visualization
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

    // handle velocity vectors visualization
    if (options.showVelocityVectors) {
        // update actual velocity arrow
        const velLength = vec3.length(agent.velocity);
        if (velLength > 0.01) {
            const velDirection = vec3.normalize([0, 0, 0], agent.velocity);
            const origin = new THREE.Vector3(agent.position[0], agent.position[1] + 0.5, agent.position[2]);
            const direction = new THREE.Vector3(velDirection[0], velDirection[1], velDirection[2]);

            visuals.velocityArrow.position.copy(origin);
            visuals.velocityArrow.setDirection(direction);
            visuals.velocityArrow.setLength(velLength * 0.5, 0.2, 0.1);
            visuals.velocityArrow.visible = true;
        } else {
            // hide arrow if velocity is too small
            visuals.velocityArrow.visible = false;
        }

        // update desired velocity arrow
        const desiredVelLength = vec3.length(agent.desiredVelocity);
        if (desiredVelLength > 0.01) {
            const desiredVelDirection = vec3.normalize([0, 0, 0], agent.desiredVelocity);
            const origin = new THREE.Vector3(agent.position[0], agent.position[1] + 0.6, agent.position[2]);
            const direction = new THREE.Vector3(desiredVelDirection[0], desiredVelDirection[1], desiredVelDirection[2]);

            visuals.desiredVelocityArrow.position.copy(origin);
            visuals.desiredVelocityArrow.setDirection(direction);
            visuals.desiredVelocityArrow.setLength(desiredVelLength * 0.5, 0.2, 0.1);
            visuals.desiredVelocityArrow.visible = true;
        } else {
            // hide arrow if desired velocity is too small
            visuals.desiredVelocityArrow.visible = false;
        }
    } else {
        // hide arrows when velocity vectors are disabled
        visuals.velocityArrow.visible = false;
        visuals.desiredVelocityArrow.visible = false;
    }
};

/* create all polygon helpers for the navmesh */
createPolyHelpers(navMesh, scene);

/* create crowd and agents */
const mixedCrowd = crowd.create(1);

// small agents can traverse all areas
const SMALL_AGENT_QUERY_FILTER: QueryFilter = {
    getCost: (pa, pb, navMesh, prevRef, curRef, nextRef) => {
        return DEFAULT_QUERY_FILTER.getCost(pa, pb, navMesh, prevRef, curRef, nextRef);
    },
    passFilter: (_ref, _navMesh) => {
        return true;
    },
};

// large agents cannot traverse WALKABLE_NARROW areas
const LARGE_AGENT_QUERY_FILTER: QueryFilter = {
    getCost: (pa, pb, navMesh, prevRef, curRef, nextRef) => {
        return DEFAULT_QUERY_FILTER.getCost(pa, pb, navMesh, prevRef, curRef, nextRef);
    },
    passFilter: (ref, navMesh) => {
        const node = getNodeByRef(navMesh, ref);
        if (!node) return false;

        return node.area !== AreaId.WALKABLE_NARROW;
    },
};

// create agents
const agentPositions = Array.from({ length: 10 }, () => {
    return findRandomPoint(navMesh, LARGE_AGENT_QUERY_FILTER, random).position;
});

const agentColors = [0x0000ff, 0x00ff00, 0xff0000, 0xffff00, 0xff00ff, 0x00ffff, 0xffa500, 0x800080, 0xffc0cb, 0x90ee90];
const agentSizes = ['s', 's', 's', 's', 's', 's', 'l', 'l', 'l', 'l'];
const agentVisuals: Record<string, AgentVisuals> = {};

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i % agentColors.length];
    const agentSize = agentSizes[i % agentSizes.length];

    const radius = agentSize === 's' ? smallAgentRadiusWorld : largeAgentRadiusWorld;
    const queryFilter = agentSize === 's' ? SMALL_AGENT_QUERY_FILTER : LARGE_AGENT_QUERY_FILTER;

    // add agent to crowd
    const agentParams: crowd.AgentParams = {
        radius,
        height: 0.6,
        maxAcceleration: 15.0,
        maxSpeed: 3.5,
        collisionQueryRange: 2,
        separationWeight: 0.5,
        updateFlags: crowd.CrowdUpdateFlags.ANTICIPATE_TURNS | crowd.CrowdUpdateFlags.SEPARATION | crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE,
        queryFilter,
        autoTraverseOffMeshConnections: true,
        obstacleAvoidance: crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
    };

    const agentId = crowd.addAgent(mixedCrowd, position, agentParams);
    console.log(`Creating agent ${i} at position:`, position);

    // create visuals for the agent
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, radius, agentParams.height);
}

const scatterCats = () => {
    for (const agentId in mixedCrowd.agents) {
        const randomPointResult = findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, random);

        if (!randomPointResult.success) continue;

        crowd.requestMoveTarget(mixedCrowd, agentId, randomPointResult.nodeRef, randomPointResult.position);
    }
};

scatterCats();

// mouse interaction for setting agent targets
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// timer for auto-scatter
let lastInteractionTime = performance.now();
let lastScatterTime = performance.now();
const scatterTimeoutMs = 5000;

const onPointerDown = (event: MouseEvent) => {
    if (event.button !== 0) return;

    // update interaction timer
    lastInteractionTime = performance.now();

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(walkableMeshes, true);
    if (intersects.length === 0) return;

    const intersectionPoint = intersects[0].point;
    const targetPosition: Vec3 = [intersectionPoint.x, intersectionPoint.y, intersectionPoint.z];

    const halfExtents: Vec3 = [1, 1, 1];
    const nearestResult = findNearestPoly(createFindNearestPolyResult(), navMesh, targetPosition, halfExtents, ANY_QUERY_FILTER);

    if (!nearestResult.success) return;

    for (const agentId in mixedCrowd.agents) {
        crowd.requestMoveTarget(mixedCrowd, agentId, nearestResult.nodeRef, nearestResult.position);
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

    // check if we should scatter cats due to inactivity
    if (time - lastInteractionTime > scatterTimeoutMs && time - lastScatterTime > scatterTimeoutMs) {
        scatterCats();
        lastScatterTime = time;
    }

    // update crowd
    crowd.update(mixedCrowd, navMesh, clampedDeltaTime);

    const agents = Object.keys(mixedCrowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = mixedCrowd.agents[agentId];
        if (agentVisuals[agentId]) {
            updateAgentVisuals(agent, agentVisuals[agentId], scene, {
                showPathLine: guiSettings.showPathLine,
                showVelocityVectors: guiSettings.showVelocityVectors,
            });
        }
    }

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
