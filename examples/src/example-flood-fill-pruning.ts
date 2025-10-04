import type { NavMesh, NodeRef } from 'navcat';
import { getNodeRefType, NodeType, serPolyNodeRef } from 'navcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createNavMeshPolyHelper, type DebugObject } from './common/debug';
import { createExample } from './common/example-base';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from './common/generate-tiled-nav-mesh';
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

let currentResult: ReturnType<typeof generateTiledNavMesh> | null = null;
let originalNavMesh: any = null; // backup of original navmesh before pruning
let hasBeenPruned = false;

// mouse interaction setup
const mouse = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

// poly visuals
type PolyHelper = {
    helper: DebugObject;
    polyRef: NodeRef;
};

const polyHelpers = new Map<NodeRef, PolyHelper>();

const createPolyHelpers = (navMesh: NavMesh): void => {
    // create helpers for all polygons in the navmesh
    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const polyRef = serPolyNodeRef(tile.id, tile.salt, polyIndex);

            const helper = createNavMeshPolyHelper(navMesh, polyRef, [0.3, 0.8, 0.3]);

            // initially visible with normal appearance
            helper.object.position.y += 0.1; // adjust height for visibility
            scene.add(helper.object);

            polyHelpers.set(polyRef, {
                helper,
                polyRef,
            });
        }
    }
};

const setPolyColor = (polyRef: NodeRef, color: number, transparent: boolean, opacity: number): void => {
    const helperInfo = polyHelpers.get(polyRef);
    if (!helperInfo) return;

    helperInfo.helper.object.traverse((child: any) => {
        if (child instanceof THREE.Mesh && child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];

            materials.forEach((mat) => {
                if ('color' in mat) {
                    mat.color.setHex(color);
                    mat.transparent = transparent;
                    mat.opacity = opacity;
                }
            });
        }
    });
};

const clearPolyHelpers = (): void => {
    for (const helperInfo of polyHelpers.values()) {
        scene.remove(helperInfo.helper.object);
        helperInfo.helper.dispose();
    }
    polyHelpers.clear();
};

function updateNavMeshVisualization() {
    if (!currentResult) return;

    const { navMesh } = currentResult;

    // clear existing helpers
    clearPolyHelpers();

    // create poly helpers
    createPolyHelpers(navMesh);

    // if pruned, update colors
    if (hasBeenPruned) {
        for (const tileId in navMesh.tiles) {
            const tile = navMesh.tiles[tileId];
            for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
                const polyRef = serPolyNodeRef(tile.id, tile.salt, polyIndex);
                const poly = tile.polys[polyIndex];

                if (poly.flags === 0) {
                    setPolyColor(polyRef, 0xff0000, true, 0.3); // red, semi-transparent
                } else {
                    setPolyColor(polyRef, 0x00ff00, false, 1.0); // green, opaque
                }
            }
        }
    }
}

function applyFloodFillPruning(startRef?: NodeRef) {
    if (!currentResult || !originalNavMesh) return;

    // reset navmesh to original state
    currentResult.navMesh = JSON.parse(JSON.stringify(originalNavMesh));

    // apply flood fill pruning using navMesh.nodes and navMesh.links
    const selectedStartRef = startRef || getRandomPolyRef();

    if (selectedStartRef) {
        floodFillPruneNavMesh(currentResult.navMesh, selectedStartRef as NodeRef);

        hasBeenPruned = true;
    }

    updateNavMeshVisualization();
}

function floodFillPruneNavMesh(navMesh: NavMesh, startRef: NodeRef) {
    const visited = new Set<NodeRef>();
    const queue: NodeRef[] = [startRef];
    const reachablePolys = new Set<NodeRef>();

    // bfs from starting polygon to find all reachable polygons
    while (queue.length > 0) {
        const currentRef = queue.shift()!;

        if (visited.has(currentRef)) continue;
        visited.add(currentRef);
        reachablePolys.add(currentRef);

        // get links for this polygon using navMesh.nodes
        const node = navMesh.nodes[currentRef];
        if (!node) continue;

        // follow all links to neighboring polygons
        for (const linkIndex of node.links) {
            const link = navMesh.links[linkIndex];

            const neighborRef = link.neighbourRef;
            if (!neighborRef || visited.has(neighborRef)) continue;

            // only consider ground polygons (not off-mesh connections)
            const nodeType = getNodeRefType(neighborRef);
            if (nodeType === NodeType.POLY) {
                queue.push(neighborRef);
            }
        }
    }

    // count all polygons and disable those not reachable
    let disabledCount = 0;

    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            // const polyRef = `0,${tileId},${polyIndex}` as NodeRef;
            const polyRef = serPolyNodeRef(tile.id, tile.salt, polyIndex, )

            if (!reachablePolys.has(polyRef)) {
                // this polygon is not reachable from the start, disable it by setting flags to 0
                tile.polys[polyIndex].flags = 0;
                disabledCount++;
            }
        }
    }

    return disabledCount;
}

function getRandomPolyRef(): string | null {
    if (!currentResult) return null;

    // Find a random polygon from the navmesh to use as starting point
    const tileIds = Object.keys(currentResult.navMesh.tiles);
    if (tileIds.length === 0) return null;

    const randomTileId = tileIds[Math.floor(Math.random() * tileIds.length)];
    const tile = currentResult.navMesh.tiles[randomTileId];

    if (tile.polys.length === 0) return null;

    const randomPolyIndex = Math.floor(Math.random() * tile.polys.length);
    return `0,${randomTileId},${randomPolyIndex}`;
}

function generate() {
    /* clear helpers */
    clearPolyHelpers();

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

    const tileSizeWorld = config.tileSizeVoxels * config.cellSize;
    const walkableRadiusVoxels = Math.ceil(config.walkableRadiusWorld / config.cellSize);
    const walkableClimbVoxels = Math.ceil(config.walkableClimbWorld / config.cellHeight);
    const walkableHeightVoxels = Math.ceil(config.walkableHeightWorld / config.cellHeight);

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

    // Store backup of original navmesh
    originalNavMesh = JSON.parse(JSON.stringify(currentResult.navMesh));

    /* update visuals */
    updateNavMeshVisualization();
}

// Add mouse click event listener
renderer.domElement.addEventListener('click', onMouseClick);

function onMouseClick(event: MouseEvent) {
    if (!currentResult || !originalNavMesh) return;

    // Calculate mouse position in normalized device coordinates (-1 to +1)
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Cast ray from camera through mouse position
    raycaster.setFromCamera(mouse, camera);

    // Find the clicked polygon
    const clickedPolyRef = findClickedPolygon(raycaster);

    if (clickedPolyRef) {
        applyFloodFillPruning(clickedPolyRef);
    }
}

function findClickedPolygon(raycaster: THREE.Raycaster): NodeRef | null {
    if (!currentResult) return null;

    const { navMesh } = currentResult;
    let closestDistance = Infinity;
    let closestPolyRef: NodeRef | null = null;

    // Check all polygons in all tiles
    for (const tile of Object.values(navMesh.tiles)) {
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const poly = tile.polys[polyIndex];

            // Create a temporary geometry for this polygon
            const vertices: number[] = [];
            const indices: number[] = [];

            // Get polygon vertices
            for (let i = 0; i < poly.vertices.length; i++) {
                const vertIndex = poly.vertices[i] * 3;
                vertices.push(
                    tile.vertices[vertIndex],
                    tile.vertices[vertIndex + 1] + 0.1, // Slightly elevated
                    tile.vertices[vertIndex + 2],
                );
            }

            // Triangulate polygon (simple fan triangulation)
            for (let i = 1; i < poly.vertices.length - 1; i++) {
                indices.push(0, i, i + 1);
            }

            // Create temporary geometry
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
            geometry.setIndex(indices);

            // Create temporary mesh
            const material = new THREE.MeshBasicMaterial();
            const mesh = new THREE.Mesh(geometry, material);

            // Test intersection
            const intersects = raycaster.intersectObject(mesh);

            if (intersects.length > 0 && intersects[0].distance < closestDistance) {
                closestDistance = intersects[0].distance;
                closestPolyRef = serPolyNodeRef(tile.id, tile.salt, polyIndex);
            }

            // Clean up
            geometry.dispose();
            material.dispose();
        }
    }

    return closestPolyRef;
}

generate();

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
