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
    type CompactHeightfield,
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
    markCylinderArea,
    markWalkableTriangles,
    NULL_AREA,
    OffMeshConnectionDirection,
    type OffMeshConnectionParams,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    rasterizeTriangles,
    removeTile,
    WALKABLE_AREA,
} from 'navcat';
import { createNavMeshOffMeshConnectionsHelper, createNavMeshTileHelper, type DebugObject, getPositionsAndIndices } from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import {
    addAgent,
    type Agent,
    type AgentParams,
    createCrowd,
    CrowdUpdateFlags,
    requestMoveTarget,
    updateCrowd,
} from './common/crowd';
import { loadGLTF } from './common/load-gltf';
import { findCorridorCorners } from './common/path-corridor';

/* init rapier */
await Rapier.init();

/* controls */
const guiSettings = {
    showPathLine: false,
};

const gui = new GUI();
gui.add(guiSettings, 'showPathLine').name('Show Path Line');

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
const levelModel = await loadGLTF('/models/nav-test.glb');
scene.add(levelModel.scene);

// load cat model for agents
const catModel = await loadGLTF('/models/cat.gltf');
const catAnimations = catModel.animations;

/* get walkable level geometry */
const walkableMeshes: THREE.Mesh[] = [];

scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [levelPositions, levelIndices] = getPositionsAndIndices(walkableMeshes);

/* navmesh generation config */
const cellSize = 0.15;
const cellHeight = 0.15;

const tileSizeVoxels = 32;
const tileSizeWorld = tileSizeVoxels * cellSize;

const walkableRadiusWorld = 0.15;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 1;
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

// calculate bounds and grid size
const meshBounds = calculateMeshBounds(box3.create(), levelPositions, levelIndices);
const gridSize = calculateGridSize(vec2.create(), meshBounds, cellSize);

// create an empty navmesh and build context; we'll build tiles via the queue
const buildCtx = BuildContext.create();
const navMesh = createNavMesh();
navMesh.tileWidth = tileSizeWorld;
navMesh.tileHeight = tileSizeWorld;
navMesh.origin = meshBounds[0];

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

const tileWidth = Math.floor((gridSize[0] + tileSizeVoxels - 1) / tileSizeVoxels);
const tileHeight = Math.floor((gridSize[1] + tileSizeVoxels - 1) / tileSizeVoxels);

const tileKey = (x: number, y: number) => `${x}_${y}`;

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
const TILE_REBUILD_THROTTLE_MS = 1000;

const enqueueTile = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= tileWidth || y >= tileHeight) return;
    const key = tileKey(x, y);
    if (dirtyTiles.has(key)) return;
    dirtyTiles.add(key);
    rebuildQueue.push([x, y]);
};

// enqueue all tiles initially so the queue will build the whole navmesh
for (let tx = 0; tx < tileWidth; tx++) {
    for (let ty = 0; ty < tileHeight; ty++) {
        enqueueTile(tx, ty);
    }
}

const getTileBounds = (x: number, y: number) => {
    const min: Vec3 = [meshBounds[0][0] + x * tileSizeWorld, meshBounds[0][1], meshBounds[0][2] + y * tileSizeWorld];
    const max: Vec3 = [meshBounds[0][0] + (x + 1) * tileSizeWorld, meshBounds[1][1], meshBounds[0][2] + (y + 1) * tileSizeWorld];
    return [min, max] as [Vec3, Vec3];
};

// Precomputed compact heightfields for each tile (from static level geometry)
const tileCompactHFs = new Map<string, CompactHeightfield>();

// Precompute compact heightfields for every tile from static geometry
for (let tx = 0; tx < tileWidth; tx++) {
    for (let ty = 0; ty < tileHeight; ty++) {
        const tileBounds = getTileBounds(tx, ty);

        // expand bounds by border size like buildNavMeshTile does
        const expanded = box3.clone(tileBounds as any);
        expanded[0][0] -= borderSize * cellSize;
        expanded[0][2] -= borderSize * cellSize;
        expanded[1][0] += borderSize * cellSize;
        expanded[1][2] += borderSize * cellSize;

        // collect triangles overlapping expanded bounds
        const trianglesInBox: number[] = [];
        const triangle = triangle3.create();

        for (let i = 0; i < levelIndices.length; i += 3) {
            const a = levelIndices[i];
            const b = levelIndices[i + 1];
            const c = levelIndices[i + 2];

            vec3.fromBuffer(triangle[0], levelPositions, a * 3);
            vec3.fromBuffer(triangle[1], levelPositions, b * 3);
            vec3.fromBuffer(triangle[2], levelPositions, c * 3);

            if (box3.intersectsTriangle3(expanded as any, triangle)) {
                trianglesInBox.push(a, b, c);
            }
        }

        // mark walkable triangles
        const triAreaIds = new Uint8Array(trianglesInBox.length / 3).fill(0);
        markWalkableTriangles(levelPositions, trianglesInBox, triAreaIds, walkableSlopeAngleDegrees);

        // create heightfield for tile (with border)
        const hfW = Math.floor(tileSizeVoxels + borderSize * 2);
        const hfH = Math.floor(tileSizeVoxels + borderSize * 2);
        const heightfield = createHeightfield(hfW, hfH, expanded as any, cellSize, cellHeight);

        rasterizeTriangles(buildCtx, heightfield, levelPositions, trianglesInBox, triAreaIds, walkableClimbVoxels);

        // filter and build compact heightfield from static geometry
        filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
        filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
        filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

        const compactHeightfield = buildCompactHeightfield(buildCtx, walkableHeightVoxels, walkableClimbVoxels, heightfield);
        erodeWalkableArea(walkableRadiusVoxels, compactHeightfield);
        buildDistanceField(compactHeightfield);

        // store the compact heightfield
        tileCompactHFs.set(tileKey(tx, ty), compactHeightfield);
    }
}

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
        if (now - last < TILE_REBUILD_THROTTLE_MS) {
            rebuildQueue.push([tx, ty]);
            continue;
        }

        // we are rebuilding this tile now, remove from dirty set
        dirtyTiles.delete(key);

        const tileBounds = getTileBounds(tx, ty);

        try {
            // we precomputed compact heightfields for all tiles using static level geometry
            const precomputedCompactHeightfield = tileCompactHFs.get(key);

            if (!precomputedCompactHeightfield) {
                console.error('No precomputed compact heightfield for tile', key);
                continue;
            }

            // clone the compact heightfield (it's a regular JSON-serialisable object)
            const chf = structuredClone(precomputedCompactHeightfield);

            // use tileToObjects mapping to only mark objects that influence this tile.
            const influencing = tileToObjects.get(key);

            if (influencing && influencing.size > 0) {
                for (const objIndex of influencing) {
                    const obj = physicsObjects[objIndex];
                    if (!obj) continue;

                    const pos = obj.mesh.position;
                    const worldRadius = obj.radius;

                    // quick AABB check: skip if sphere center outside the tile bounds (with radius)
                    const min = tileBounds[0];
                    const max = tileBounds[1];
                    if (
                        pos.x + worldRadius < min[0] ||
                        pos.x - worldRadius > max[0] ||
                        pos.y + worldRadius < min[1] ||
                        pos.y - worldRadius > max[1] ||
                        pos.z + worldRadius < min[2] ||
                        pos.z - worldRadius > max[2]
                    ) {
                        continue;
                    }

                    markCylinderArea([pos.x, pos.y - worldRadius, pos.z], worldRadius, worldRadius, NULL_AREA, chf);
                }
            } else {
                // fallback: if mapping empty, conservatively mark all dynamic objects overlapping the tile
                for (const obj of physicsObjects) {
                    const pos = obj.mesh.position;
                    const worldRadius = obj.radius ?? 0.5;
                    const min = tileBounds[0];
                    const max = tileBounds[1];
                    if (
                        pos.x + worldRadius < min[0] ||
                        pos.x - worldRadius > max[0] ||
                        pos.y + worldRadius < min[1] ||
                        pos.y - worldRadius > max[1] ||
                        pos.z + worldRadius < min[2] ||
                        pos.z - worldRadius > max[2]
                    ) {
                        continue;
                    }
                    markCylinderArea([pos.x, pos.y - worldRadius, pos.z], worldRadius, worldRadius, NULL_AREA, chf);
                }
            }

            // after marking dynamic obstacles, run region/contour/poly build steps from the compact heightfield
            buildRegions(buildCtx, chf, borderSize, minRegionArea, mergeRegionArea);

            const contourSet = buildContours(
                buildCtx,
                chf,
                maxSimplificationError,
                maxEdgeLength,
                ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
            );

            const polyMesh = buildPolyMesh(buildCtx, contourSet, maxVerticesPerPoly);

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
                cellSize,
                cellHeight,
                walkableHeight: walkableHeightWorld,
                walkableRadius: walkableRadiusWorld,
                walkableClimb: walkableClimbWorld,
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

const buildAllTiles = () => {
    while (rebuildQueue.length > 0) {
        processRebuildQueue(64);
    }
};

// compute the list of tiles overlapping an AABB (min/max Vec3)
const tilesForAABB = (min: Vec3, max: Vec3) => {
    const minX = Math.floor((min[0] - meshBounds[0][0]) / tileSizeWorld);
    const minY = Math.floor((min[2] - meshBounds[0][2]) / tileSizeWorld);
    const maxX = Math.floor((max[0] - meshBounds[0][0]) / tileSizeWorld);
    const maxY = Math.floor((max[2] - meshBounds[0][2]) / tileSizeWorld);

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
buildAllTiles();

/* create physics world */
const physicsWorld = new Rapier.World(new Rapier.Vector3(0, -9.81, 0));

/* create fixed trimesh collider for level */
const levelColliderDesc = Rapier.ColliderDesc.trimesh(new Float32Array(levelPositions), new Uint32Array(levelIndices));
levelColliderDesc.setMass(0);

const levelRigidBodyDesc = Rapier.RigidBodyDesc.fixed();
const levelRigidBody = physicsWorld.createRigidBody(levelRigidBodyDesc);

physicsWorld.createCollider(levelColliderDesc, levelRigidBody);

/* create a bunch of dynamic boxes */
for (let i = 0; i < 20; i++) {
    // visual
    const boxSize = 0.5;
    const boxGeometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
    const boxMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);

    scene.add(boxMesh);

    // physics
    const boxColliderDesc = Rapier.ColliderDesc.cuboid(boxSize / 2, boxSize / 2, boxSize / 2);
    boxColliderDesc.setRestitution(0.1);
    boxColliderDesc.setFriction(0.5);
    boxColliderDesc.setDensity(1.0);
    const boxRigidBodyDesc = Rapier.RigidBodyDesc.dynamic().setTranslation(
        (Math.random() - 0.5) * 8,
        10 + i * 2,
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
    agent: Agent,
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
        const targetDirection = vec3.subtract([0, 0, 0], agent.targetPos, agent.position);
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
    visuals.targetMesh.position.fromArray(agent.targetPos);
    visuals.targetMesh.position.y += 0.1;

    // path line visualization
    if (options.showPathLine) {
        const corners = findCorridorCorners(agent.corridor, navMesh, 3);

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
const crowd = createCrowd(1);

console.log(crowd);

const agentParams: AgentParams = {
    radius: 0.3,
    height: 0.6,
    maxAcceleration: 15.0,
    maxSpeed: 3.5,
    collisionQueryRange: 2,
    separationWeight: 0.5,
    updateFlags: CrowdUpdateFlags.ANTICIPATE_TURNS | CrowdUpdateFlags.SEPARATION | CrowdUpdateFlags.OBSTACLE_AVOIDANCE,
    queryFilter: DEFAULT_QUERY_FILTER,
    obstacleAvoidance: {
        velBias: 0.4,
        weightDesVel: 2.0,
        weightCurVel: 0.75,
        weightSide: 0.75,
        weightToi: 2.5,
        horizTime: 2.5,
        gridSize: 33,
        adaptiveDivs: 7,
        adaptiveRings: 2,
        adaptiveDepth: 5,
    },
};

// create agents at different positions
const agentPositions: Vec3[] = Array.from({ length: 2 }).map((_, i) => [-2 + i * -0.05, 0.5, 3]) as Vec3[];

const agentColors = [0x0000ff, 0x00ff00];

const agentVisuals: Record<string, AgentVisuals> = {};

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i % agentColors.length];

    // add agent to crowd
    const agentId = addAgent(crowd, position, agentParams);
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

    const intersects = raycaster.intersectObjects(walkableMeshes, true);

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

    for (const agentId in crowd.agents) {
        requestMoveTarget(crowd, agentId, nearestResult.ref, nearestResult.point);
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
    updateCrowd(crowd, navMesh, clampedDeltaTime);

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
                    const flashColor = 0x555555;

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

    // update agent visuals
    const agents = Object.keys(crowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = crowd.agents[agentId];

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
