import GUI from 'lil-gui';
import { type Vec3, vec3 } from 'mathcat';
import {
    createFindNearestPolyResult,
    createGetPolyHeightResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    getPolyHeight,
    getTileAndPolyByRef,
    raycast,
    raycastWithCosts,
} from 'navcat';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import { createNavMeshHelper, createNavMeshPolyHelper, getPositionsAndIndices } from 'navcat/three';
import * as THREE from 'three';
import { LineGeometry, OrbitControls } from 'three/examples/jsm/Addons.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from 'three/webgpu';
import { createExample } from './common/example-base';
import { loadGLTF } from './common/load-gltf';

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

orbitControls.target.set(0, 0, 4);
camera.position.set(0, 5, 8);

const navTestModel = await loadGLTF('./models/nav-test.glb');
scene.add(navTestModel.scene);

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

const navMeshResult = generateTiledNavMesh(navMeshInput, navMeshConfig);
const navMesh = navMeshResult.navMesh;

const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

// state for raycast (with defaults)
let clickedStart: Vec3 | null = [-0.8, 0.27, 5.1];
let clickedEnd: Vec3 | null = [0.53, 0.26, 3.59];

// resolved positions and polys from findNearestPoly
let startNodeRef: number | null = null;
let startPosition: Vec3 | null = null;
let endNodeRef: number | null = null;
let endPosition: Vec3 | null = null;

// raycast results
let raycastHitPos: Vec3 | null = null;
let raycastHitPoly: number | null = null;
let raycastReachedEnd = false;
let raycastPathCost = 0;
let raycastPathLength = 0;
let raycastRayLength = 0;

const params = {
    calculateCosts: false,
};

type Visual = { object: THREE.Object3D; dispose: () => void };
let visuals: Visual[] = [];

// GUI
const gui = new GUI();
gui.add(params, 'calculateCosts')
    .name('Calculate Costs')
    .onChange(() => {
        performRaycast();
    });

// Info panel
const controlsDiv = document.createElement('div');
controlsDiv.style.position = 'absolute';
controlsDiv.style.top = '10px';
controlsDiv.style.left = '10px';
controlsDiv.style.padding = '10px';
controlsDiv.style.background = 'rgba(0, 0, 0, 0.7)';
controlsDiv.style.color = 'white';
controlsDiv.style.fontFamily = 'monospace';
controlsDiv.style.fontSize = '14px';
controlsDiv.style.borderRadius = '4px';
controlsDiv.style.pointerEvents = 'auto';

const infoPanelTitle = document.createElement('div');
infoPanelTitle.textContent = 'RAYCAST\n2D in XZ plane\nfollows the navmesh surface)';
infoPanelTitle.style.whiteSpace = 'pre';
infoPanelTitle.style.opacity = '0.6';
infoPanelTitle.style.marginBottom = '8px';
controlsDiv.appendChild(infoPanelTitle);

const infoPanelContent = document.createElement('div');
controlsDiv.appendChild(infoPanelContent);

container.appendChild(controlsDiv);

// initial raycast with defaults
performRaycast();

function clearVisuals() {
    for (const visual of visuals) {
        scene.remove(visual.object);
        visual.dispose();
    }
    visuals = [];
}

function addVisual(visual: Visual) {
    visuals.push(visual);
    scene.add(visual.object);
}

function performRaycast() {
    clearVisuals();
    if (!clickedStart || !clickedEnd) return;

    // find nearest poly for start position
    const startNearestPolyResult = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        clickedStart,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER,
    );

    if (!startNearestPolyResult.success) return;

    startNodeRef = startNearestPolyResult.nodeRef;
    startPosition = vec3.clone(startNearestPolyResult.position);

    // find nearest poly for end position
    const endNearestPolyResult = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        clickedEnd,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER,
    );

    if (!endNearestPolyResult.success) return;

    endNodeRef = endNearestPolyResult.nodeRef;
    endPosition = vec3.clone(endNearestPolyResult.position);

    // perform raycast from start to end
    const raycastResult = params.calculateCosts
        ? raycastWithCosts(navMesh, startNodeRef, startPosition, endPosition, DEFAULT_QUERY_FILTER, 0)
        : raycast(navMesh, startNodeRef, startPosition, endPosition, DEFAULT_QUERY_FILTER);

    // raycast reached end if t is MAX_VALUE (no wall hit)
    raycastReachedEnd = raycastResult.t === Number.MAX_VALUE;
    raycastPathCost = raycastResult.pathCost || 0;
    raycastPathLength = raycastResult.path.length;

    // calculate raycast hit position
    if (raycastResult.t === Number.MAX_VALUE) {
        // ray reached the end without hitting a wall
        raycastHitPos = vec3.clone(endPosition);
        raycastHitPoly = raycastResult.path[raycastResult.path.length - 1] || endNodeRef;
    } else {
        // ray hit a wall at parameter t
        raycastHitPos = vec3.create();
        vec3.lerp(raycastHitPos, startPosition, endPosition, raycastResult.t);
        raycastHitPoly = raycastResult.path[raycastResult.path.length - 1] || startNodeRef;
    }
    raycastRayLength = vec3.distance(startPosition, raycastHitPos);

    // if hit poly is different from end poly, get the actual height on the hit poly
    let actualHitPosOnPoly: Vec3 | null = null;
    if (raycastReachedEnd && raycastHitPoly !== endNodeRef && raycastHitPoly !== null) {
        const tileAndPoly = getTileAndPolyByRef(raycastHitPoly, navMesh);
        if (tileAndPoly.success) {
            const heightResult = getPolyHeight(
                createGetPolyHeightResult(),
                tileAndPoly.tile,
                tileAndPoly.poly,
                tileAndPoly.polyIndex,
                raycastHitPos,
            );
            if (heightResult.success) {
                actualHitPosOnPoly = vec3.fromValues(raycastHitPos[0], heightResult.height, raycastHitPos[2]);
            }
        }
    }

    // Update info panel with comprehensive metadata
    const formatVec = (v: Vec3) => `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})`;

    let infoHtml = '<div style="display: grid; gap: 4px;">';

    // Start position info
    infoHtml += '<div style="color: #66ff66;">Start:</div>';
    infoHtml += `<div style="padding-left: 8px; opacity: 0.8;">Poly: ${startNodeRef}</div>`;
    infoHtml += `<div style="padding-left: 8px; opacity: 0.8;">Pos: ${formatVec(startPosition)}</div>`;

    // End target info
    infoHtml += '<div style="color: #6699ff; margin-top: 4px;">End Target:</div>';
    infoHtml += `<div style="padding-left: 8px; opacity: 0.8;">Poly: ${endNodeRef}</div>`;
    infoHtml += `<div style="padding-left: 8px; opacity: 0.8;">Pos: ${formatVec(endPosition)}</div>`;

    // Raycast hit info - determine the status
    let statusText: string;
    let statusColor: string;
    let hitColor: string;

    if (raycastReachedEnd && raycastHitPoly === endNodeRef) {
        // truly reached the end target poly
        statusText = 'REACHED END ✓';
        statusColor = '#66ff66';
        hitColor = '#66ff66';
    } else if (raycastReachedEnd && raycastHitPoly !== endNodeRef) {
        // reached XZ position but different poly (vertically separated)
        statusText = 'REACHED XZ (Different Poly) ⚠';
        statusColor = '#ffaa00';
        hitColor = '#ffaa00';
    } else {
        // blocked by wall
        statusText = 'BLOCKED ✗';
        statusColor = '#ff6666';
        hitColor = '#ff6666';
    }

    infoHtml += `<div style="color: ${hitColor}; margin-top: 4px;">Raycast Hit:</div>`;
    infoHtml += `<div style="padding-left: 8px; opacity: 0.8;">Poly: ${raycastHitPoly}</div>`;
    infoHtml += `<div style="padding-left: 8px; opacity: 0.8;">Pos: ${formatVec(raycastHitPos)}</div>`;

    // show actual hit position on poly if different
    if (actualHitPosOnPoly) {
        infoHtml += '<div style="color: #ffff00; margin-top: 4px;">Actual Pos on Hit Poly:</div>';
        infoHtml += `<div style="padding-left: 8px; opacity: 0.8;">Pos: ${formatVec(actualHitPosOnPoly)}</div>`;
    }

    // status
    infoHtml += `<div style="margin-top: 8px; color: ${statusColor};">${statusText}</div>`;

    // optional cost/metrics info
    if (params.calculateCosts) {
        infoHtml += '<div style="margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">';
        infoHtml += `<div>Path Cost: ${raycastPathCost.toFixed(3)}</div>`;
        infoHtml += `<div>Ray Length: ${raycastRayLength.toFixed(3)}</div>`;
        infoHtml += `<div>Polys Traversed: ${raycastPathLength}</div>`;
        infoHtml += '</div>';
    }

    infoHtml += '</div>';
    infoPanelContent.innerHTML = infoHtml;

    // visualize the start position (green sphere)
    const startMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 20, 20),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('green') }),
    );
    startMesh.position.fromArray(startPosition);
    startMesh.position.y += 0.5;
    addVisual({
        object: startMesh,
        dispose: () => {
            startMesh.geometry?.dispose();
            startMesh.material?.dispose?.();
        },
    });

    // visualize the end target position (blue sphere)
    const endMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('blue') }),
    );
    endMesh.position.fromArray(endPosition);
    endMesh.position.y += 0.5;
    addVisual({
        object: endMesh,
        dispose: () => {
            endMesh.geometry?.dispose();
            endMesh.material?.dispose?.();
        },
    });

    // visualize the raycast hit position with appropriate color
    let hitMeshColor: string;
    if (raycastReachedEnd && raycastHitPoly === endNodeRef) {
        hitMeshColor = 'green';
    } else if (raycastReachedEnd && raycastHitPoly !== endNodeRef) {
        hitMeshColor = 'orange';
    } else {
        hitMeshColor = 'red';
    }

    const hitMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(hitMeshColor) }),
    );
    hitMesh.position.fromArray(raycastHitPos);
    hitMesh.position.y += 0.5;
    addVisual({
        object: hitMesh,
        dispose: () => {
            hitMesh.geometry?.dispose();
            hitMesh.material?.dispose?.();
        },
    });

    // visualize the actual hit position on the hit poly (if different from end poly)
    if (actualHitPosOnPoly) {
        const actualHitMesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.08, 16, 16),
            new THREE.MeshBasicMaterial({ color: new THREE.Color('yellow') }),
        );
        actualHitMesh.position.fromArray(actualHitPosOnPoly);
        actualHitMesh.position.y += 0.5;
        addVisual({
            object: actualHitMesh,
            dispose: () => {
                actualHitMesh.geometry?.dispose();
                actualHitMesh.material?.dispose?.();
            },
        });
    }

    // visualize the raycast as two arrows: green (start to hit), red (hit to end if blocked)
    const startVec = new THREE.Vector3(...startPosition);
    const hitVec = new THREE.Vector3(...raycastHitPos);
    const endVec = new THREE.Vector3(...endPosition);

    // use actual hit position on poly if available, otherwise use raycastHitPos
    const actualHitVec = actualHitPosOnPoly ? new THREE.Vector3(...actualHitPosOnPoly) : hitVec;

    const toHit = new THREE.Vector3().subVectors(actualHitVec, startVec);
    const toEnd = new THREE.Vector3().subVectors(endVec, hitVec);
    const toHitLen = toHit.length();
    const toEndLen = toEnd.length();

    if (toHitLen > 0.01) {
        const arrowGreen = new THREE.ArrowHelper(
            toHit.clone().normalize(),
            startVec.clone().setY(startVec.y + 0.5),
            toHitLen,
            0x00ff00,
            0.18,
            0.09,
        );
        addVisual({
            object: arrowGreen,
            dispose: () => {
                arrowGreen.dispose();
            },
        });
    }

    // only draw the red arrow if the raycast didn't reach the end
    if (!raycastReachedEnd && toEndLen > 0.01) {
        const arrowRed = new THREE.ArrowHelper(
            toEnd.clone().normalize(),
            hitVec.clone().setY(hitVec.y + 0.5),
            toEndLen,
            0xff0000,
            0.18,
            0.09,
        );
        addVisual({
            object: arrowRed,
            dispose: () => {
                arrowRed.dispose();
            },
        });
    }

    // visualize hit normal if we hit a wall
    if (raycastResult.t < Number.MAX_VALUE && vec3.length(raycastResult.hitNormal) > 0) {
        const normalEnd = vec3.create();
        vec3.scaleAndAdd(normalEnd, raycastHitPos, raycastResult.hitNormal, 0.5);

        const normalLineGeometry = new LineGeometry();
        normalLineGeometry.setFromPoints([new THREE.Vector3(...raycastHitPos), new THREE.Vector3(...normalEnd)]);
        const normalLineMaterial = new Line2NodeMaterial({
            color: 'yellow',
            linewidth: 0.08,
            worldUnits: true,
        });
        const normalLine = new Line2(normalLineGeometry, normalLineMaterial);
        normalLine.position.y += 0.5;
        addVisual({
            object: normalLine,
            dispose: () => {
                normalLine.geometry?.dispose();
                normalLine.material?.dispose?.();
            },
        });
    }

    // highlight start poly (green)
    const startPolyHelper = createNavMeshPolyHelper(navMesh, startNodeRef, [0, 1, 0]);
    startPolyHelper.object.position.y += 0.25;
    addVisual(startPolyHelper);

    // highlight end target poly (blue)
    const endPolyHelper = createNavMeshPolyHelper(navMesh, endNodeRef, [0, 0, 1]);
    endPolyHelper.object.position.y += 0.25;
    addVisual(endPolyHelper);

    // highlight raycast hit poly (yellow/orange) if different from end poly
    if (raycastHitPoly && raycastHitPoly !== endNodeRef) {
        const hitPolyHelper = createNavMeshPolyHelper(navMesh, raycastHitPoly, [1, 0.6, 0]);
        hitPolyHelper.object.position.y += 0.25;
        addVisual(hitPolyHelper);
    }

    // visualize the visited polygons from raycast (gradient)
    // exclude start, end, and raycast hit polys as they're already highlighted
    for (let i = 0; i < raycastResult.path.length; i++) {
        const poly = raycastResult.path[i];

        // skip if this poly is already highlighted
        if (poly === startNodeRef || poly === endNodeRef || poly === raycastHitPoly) {
            continue;
        }

        const hslColor = new THREE.Color().setHSL(0.8, 0.9, 0.4 + (i / raycastResult.path.length) * 0.3);
        const polyHelper = createNavMeshPolyHelper(navMesh, poly, hslColor.toArray() as [number, number, number]);
        polyHelper.object.position.y += 0.35;
        addVisual(polyHelper);
    }
}

/* interaction */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function getPointOnNavMesh(event: PointerEvent): Vec3 | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(walkableMeshes, true);
    if (intersects.length > 0) {
        const p = intersects[0].point;
        return [p.x, p.y, p.z];
    }
    return null;
}

renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    const point = getPointOnNavMesh(event);
    if (!point) return;
    if (event.button === 0) {
        // left click: set start
        clickedStart = point;
    } else if (event.button === 2) {
        // right click: set end
        clickedEnd = point;
    }
    performRaycast();
});

/* start loop */
function update() {
    requestAnimationFrame(update);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
