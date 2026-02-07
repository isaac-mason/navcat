import type { NavMesh, NodeRef } from 'navcat';
import { getNodeByTileAndPoly, getNodeRefIndex } from 'navcat';
import { floodFillNavMesh, generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { createNavMeshPolyHelper, type DebugObject, getPositionsAndIndices } from 'navcat/three';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createExample } from './common/example-base';
import { loadGLTF } from './common/load-gltf';

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const navTestModel = await loadGLTF('./models/nav-test.glb');
scene.add(navTestModel.scene);

/* navmesh generation parameters */

const cellSize = 0.15;
const cellHeight = 0.15;

const tileSizeVoxels = 64;
const tileSizeWorld = tileSizeVoxels * cellSize;

const walkableRadiusWorld = 0.1;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 0.25;
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

const navMeshConfig: TiledNavMeshOptions = {
    cellSize,
    cellHeight,
    tileSizeVoxels,
    tileSizeWorld,
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

let currentResult: ReturnType<typeof generateTiledNavMesh> | null = null;
let originalNavMesh: any = null; // backup of original navmesh before pruning
let hasBeenPruned = false;

// mouse interaction setup
const mouse = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

// poly visuals
type PolyHelper = {
    helper: DebugObject;
    nodeRef: NodeRef;
};

const polyHelpers = new Map<NodeRef, PolyHelper>();

const createPolyHelpers = (navMesh: NavMesh): void => {
    // create helpers for all polygons in the navmesh
    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const node = getNodeByTileAndPoly(navMesh, tile, polyIndex);

            const helper = createNavMeshPolyHelper(navMesh, node.ref, [0.3, 0.8, 0.3]);

            // initially visible with normal appearance
            helper.object.position.y += 0.1; // adjust height for visibility
            scene.add(helper.object);

            polyHelpers.set(node.ref, {
                helper,
                nodeRef: node.ref,
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
                const polyRef = getNodeByTileAndPoly(navMesh, tile, polyIndex).ref;
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
    const selectedStartRef = startRef ?? getRandomPolyRef();

    if (selectedStartRef) {
        floodFillPruneNavMesh(currentResult.navMesh, [selectedStartRef as NodeRef]);

        hasBeenPruned = true;
    }

    updateNavMeshVisualization();
}

function floodFillPruneNavMesh(navMesh: NavMesh, startNodeRefs: NodeRef[]) {
    // flood fill from startRefs to find reachable and unreachable polygons
    const { reachable, unreachable } = floodFillNavMesh(navMesh, startNodeRefs);

    // disable unreachable polygons
    for (const nodeRef of unreachable) {
        const nodeIndex = getNodeRefIndex(nodeRef);
        const node = navMesh.nodes[nodeIndex];

        // disable the poly by setting its node's flags to 0
        node.flags = 0;

        // also set the flag in the source tile data, useful if we want to persist the tile
        const tile = navMesh.tiles[node.tileId];
        const polyIndex = node.polyIndex;
        tile.polys[polyIndex].flags = 0;
    }

    console.log('flood fill result', { reachable, unreachable });
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
                closestPolyRef = getNodeByTileAndPoly(navMesh, tile, polyIndex).ref;
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
