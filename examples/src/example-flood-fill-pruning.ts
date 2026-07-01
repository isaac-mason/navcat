import type { NavMesh, NavMeshPoly, NavMeshPolyDetail, NavMeshTile, NavMeshTileParams, NodeRef, Vec3 } from 'navcat';
import { addTile, buildTile, createNavMesh, getNodeByTileAndPoly, POLY_NEIS_FLAG_EXT_LINK } from 'navcat';
import { floodFillNavMesh, generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { createNavMeshPolyHelper, type DebugObject, getPositionsAndIndices } from 'navcat/three';
import GUI from 'lil-gui';
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

/* -------------------------------------------------------------------------- */
/*  Tile sanitization + navmesh re-assembly                                   */
/*                                                                            */
/*  These use only the public navcat API, so they can later be lifted into    */
/*  `navcat/blocks` or core `navcat` unchanged.                                */
/* -------------------------------------------------------------------------- */

/**
 * Produces sanitized params for `tile` containing only the polys whose
 * `keep[polyIndex]` is true. Removed polys are physically dropped: vertices,
 * detail meshes and adjacency are compacted and made internally consistent.
 * Portal edges (links to adjacent tiles) are preserved and re-stitched when the
 * tile is added back to a navmesh.
 *
 * Returns `null` if no polys survive, signalling the caller to drop the tile.
 */
function sanitizeTilePolys(tile: NavMeshTile, keep: boolean[]): NavMeshTileParams | null {
    // old poly index -> new poly index (-1 == removed)
    const polyRemap = new Array<number>(tile.polys.length).fill(-1);
    const survivors: number[] = [];
    for (let i = 0; i < tile.polys.length; i++) {
        if (keep[i]) {
            polyRemap[i] = survivors.length;
            survivors.push(i);
        }
    }

    if (survivors.length === 0) return null;

    // compact the vertices referenced by surviving polys
    const vertexRemap = new Map<number, number>();
    const vertices: number[] = [];
    const remapVertex = (oldVert: number): number => {
        let newVert = vertexRemap.get(oldVert);
        if (newVert === undefined) {
            newVert = vertices.length / 3;
            vertexRemap.set(oldVert, newVert);
            vertices.push(tile.vertices[oldVert * 3], tile.vertices[oldVert * 3 + 1], tile.vertices[oldVert * 3 + 2]);
        }
        return newVert;
    };

    const polys: NavMeshPoly[] = [];
    const detailMeshes: NavMeshPolyDetail[] = [];
    const detailVertices: number[] = [];
    const detailTriangles: number[] = [];

    for (const oldPoly of survivors) {
        const poly = tile.polys[oldPoly];

        polys.push({
            vertices: poly.vertices.map(remapVertex),
            neis: poly.neis.map((nei) => {
                if (nei === 0) return 0; // boundary edge
                if (nei & POLY_NEIS_FLAG_EXT_LINK) return nei; // portal to adjacent tile
                const newNeighbour = polyRemap[nei - 1]; // internal edge (1-based)
                return newNeighbour === -1 ? 0 : newNeighbour + 1; // removed neighbour -> boundary
            }),
            flags: poly.flags,
            area: poly.area,
        });

        // copy this poly's detail block. detail triangle indices are poly-local
        // (they reference the poly's own verts + its detail-vert block), so the
        // indices stay valid and only the base offsets change.
        const detail = tile.detailMeshes[oldPoly];
        const verticesBase = detailVertices.length / 3;
        const trianglesBase = detailTriangles.length / 4;

        for (let v = 0; v < detail.verticesCount; v++) {
            const src = (detail.verticesBase + v) * 3;
            detailVertices.push(tile.detailVertices[src], tile.detailVertices[src + 1], tile.detailVertices[src + 2]);
        }
        for (let t = 0; t < detail.trianglesCount; t++) {
            const src = (detail.trianglesBase + t) * 4;
            detailTriangles.push(
                tile.detailTriangles[src],
                tile.detailTriangles[src + 1],
                tile.detailTriangles[src + 2],
                tile.detailTriangles[src + 3],
            );
        }

        detailMeshes.push({ verticesBase, verticesCount: detail.verticesCount, trianglesBase, trianglesCount: detail.trianglesCount });
    }

    // reuse the original tile bounds: the BV tree quantizes relative to the
    // tile's min corner and queries dequantize against the same stored bounds,
    // so reusing them is self-consistent and always in range.
    return {
        tileX: tile.tileX,
        tileY: tile.tileY,
        tileLayer: tile.tileLayer,
        bounds: [...tile.bounds] as NavMeshTileParams['bounds'],
        vertices,
        polys,
        detailMeshes,
        detailVertices,
        detailTriangles,
        cellSize: tile.cellSize,
        cellHeight: tile.cellHeight,
        walkableHeight: tile.walkableHeight,
        walkableRadius: tile.walkableRadius,
        walkableClimb: tile.walkableClimb,
    };
}

/**
 * Re-assembles a brand-new navmesh containing only the polys whose node ref is
 * in `keep`; every other poly is pruned. Each surviving tile is cleaned up via
 * {@link sanitizeTilePolys} (removed polys are physically dropped, fully-emptied
 * tiles are skipped) and `addTile` rebuilds the internal + cross-tile portal
 * links from scratch.
 */
function pruneNavMesh(navMesh: NavMesh, keep: Set<NodeRef>): NavMesh {
    const result = createNavMesh();
    // preserve the global tile layout so tile positions and portals line up
    result.origin = [...navMesh.origin] as Vec3;
    result.tileWidth = navMesh.tileWidth;
    result.tileHeight = navMesh.tileHeight;

    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        const keepPoly = tile.polyNodes.map((nodeIndex) => keep.has(navMesh.nodes[nodeIndex].ref));
        const params = sanitizeTilePolys(tile, keepPoly);
        if (params) addTile(result, buildTile(params));
    }

    return result;
}

function countPolys(navMesh: NavMesh): number {
    let count = 0;
    for (const tileId in navMesh.tiles) {
        count += navMesh.tiles[tileId].polys.length;
    }
    return count;
}

/* -------------------------------------------------------------------------- */
/*  Demo                                                                       */
/* -------------------------------------------------------------------------- */

let currentResult: ReturnType<typeof generateTiledNavMesh> | null = null;
let prunedNavMesh: NavMesh | null = null; // latest re-assembled (sanitized) navmesh

const COLOR_KEPT = 0x33cc33; // reachable - survives the prune
const COLOR_PRUNED = 0xcc3333; // unreachable - removed by the prune

// info overlay (top-left)
const info = document.createElement('div');
info.style.cssText =
    'position:absolute;top:10px;left:10px;padding:8px 10px;font:12px/1.6 monospace;color:#fff;background:rgba(0,0,0,0.6);border-radius:4px;pointer-events:none;white-space:pre;';
container.appendChild(info);

function showFullInfo() {
    if (!currentResult) return;
    const navMesh = currentResult.navMesh;
    info.textContent = [
        `tiles: ${Object.keys(navMesh.tiles).length}`,
        `polys: ${countPolys(navMesh)}`,
        '',
        'click a poly to prune everything',
        'unreachable from it',
    ].join('\n');
}

function showPrunedInfo(fullNavMesh: NavMesh, pruned: NavMesh) {
    const totalPolys = countPolys(fullNavMesh);
    const keptPolys = countPolys(pruned);
    info.textContent = [
        `tiles:  ${Object.keys(fullNavMesh.tiles).length} -> ${Object.keys(pruned.tiles).length}`,
        `polys:  ${totalPolys} -> ${keptPolys}`,
        '',
        `kept (green):  ${keptPolys}`,
        `removed (red): ${totalPolys - keptPolys}`,
    ].join('\n');
}

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
    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const node = getNodeByTileAndPoly(navMesh, tile, polyIndex);

            const helper = createNavMeshPolyHelper(navMesh, node.ref, [0.3, 0.8, 0.3]);
            helper.object.position.y += 0.1; // lift for visibility
            scene.add(helper.object);

            polyHelpers.set(node.ref, { helper, nodeRef: node.ref });
        }
    }
};

const clearPolyHelpers = (): void => {
    for (const helperInfo of polyHelpers.values()) {
        scene.remove(helperInfo.helper.object);
        helperInfo.helper.dispose();
    }
    polyHelpers.clear();
};

const setPolyColor = (polyRef: NodeRef, color: number, opacity: number): void => {
    const helperInfo = polyHelpers.get(polyRef);
    if (!helperInfo) return;

    helperInfo.helper.object.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of materials) {
                if ('color' in mat) {
                    mat.color.setHex(color);
                    mat.transparent = opacity < 1;
                    mat.opacity = opacity;
                }
            }
        }
    });
};

function updateNavMeshVisualization() {
    if (!currentResult) return;

    clearPolyHelpers();
    createPolyHelpers(currentResult.navMesh);
}

/**
 * Colours the navmesh polys in place: those whose node ref is in `reachable`
 * green (kept), the rest red (removed by the prune).
 */
function colourByReachability(navMesh: NavMesh, reachable: Set<NodeRef>) {
    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const ref = getNodeByTileAndPoly(navMesh, tile, polyIndex).ref;
            const kept = reachable.has(ref);
            setPolyColor(ref, kept ? COLOR_KEPT : COLOR_PRUNED, kept ? 1 : 0.35);
        }
    }
}

function generate() {
    clearPolyHelpers();

    const walkableMeshes: THREE.Mesh[] = [];
    scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
            walkableMeshes.push(object);
        }
    });

    const [positions, indices] = getPositionsAndIndices(walkableMeshes);

    const navMeshInput: TiledNavMeshInput = { positions, indices };

    currentResult = generateTiledNavMesh(navMeshInput, navMeshConfig);
    prunedNavMesh = null;

    updateNavMeshVisualization();
}

/** Clear the prune and show the full navmesh again. */
function reset() {
    if (!currentResult) return;

    prunedNavMesh = null;
    updateNavMeshVisualization();
    showFullInfo();
}

// click a poly to prune everything unreachable from it: the navmesh is
// re-assembled (kept polys only) and the removed polys are shown as red ghosts
renderer.domElement.addEventListener('click', onMouseClick);

function onMouseClick(event: MouseEvent) {
    if (!currentResult) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const clickedPolyRef = findClickedPolygon(raycaster);
    if (!clickedPolyRef) return;

    // the full navmesh stays put so you can keep clicking around to re-seed
    const navMesh = currentResult.navMesh;

    // one flood fill: which polys are reachable from the clicked poly?
    const reachable = new Set<NodeRef>(floodFillNavMesh(navMesh, [clickedPolyRef]).reachable);

    // colour in place (kept = green, removed = red ghosts)...
    colourByReachability(navMesh, reachable);

    // ...and re-assemble a pruned navmesh containing only the reachable polys
    prunedNavMesh = pruneNavMesh(navMesh, reachable);

    showPrunedInfo(navMesh, prunedNavMesh);
}

function findClickedPolygon(raycaster: THREE.Raycaster): NodeRef | null {
    if (!currentResult) return null;

    const { navMesh } = currentResult;
    let closestDistance = Infinity;
    let closestPolyRef: NodeRef | null = null;

    for (const tile of Object.values(navMesh.tiles)) {
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const poly = tile.polys[polyIndex];

            const vertices: number[] = [];
            const indices: number[] = [];

            for (let i = 0; i < poly.vertices.length; i++) {
                const vertIndex = poly.vertices[i] * 3;
                vertices.push(tile.vertices[vertIndex], tile.vertices[vertIndex + 1] + 0.1, tile.vertices[vertIndex + 2]);
            }

            // fan triangulation
            for (let i = 1; i < poly.vertices.length - 1; i++) {
                indices.push(0, i, i + 1);
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
            geometry.setIndex(indices);

            const material = new THREE.MeshBasicMaterial();
            const mesh = new THREE.Mesh(geometry, material);

            const intersects = raycaster.intersectObject(mesh);
            if (intersects.length > 0 && intersects[0].distance < closestDistance) {
                closestDistance = intersects[0].distance;
                closestPolyRef = getNodeByTileAndPoly(navMesh, tile, polyIndex).ref;
            }

            geometry.dispose();
            material.dispose();
        }
    }

    return closestPolyRef;
}

generate();
showFullInfo();

/* gui */
const gui = new GUI();
gui.add({ reset }, 'reset').name('Reset navmesh');

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
