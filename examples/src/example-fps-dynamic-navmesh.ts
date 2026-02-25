import Rapier from '@dimforge/rapier3d-compat';
import { GUI } from 'lil-gui';
import { box3, type Box3, vec2, type Vec3, vec3 } from 'mathcat';
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
import { PointerLockControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';
import { crowd } from 'navcat/blocks';

/* init rapier */
await Rapier.init();

/* controls */
const guiSettings = {
    showRapierDebug: false,
};

const navMeshConfig = {
    cellSize: 0.3,
    cellHeight: 0.3,
    tileSizeVoxels: 32,
    walkableRadiusWorld: 0.15,
    walkableClimbWorld: 0.6,
    walkableHeightWorld: 1.0,
    walkableSlopeAngleDegrees: 60,
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

// pointer lock controls
const pointerLockControls = new PointerLockControls(camera, renderer.domElement);

// click to lock pointer
const instructionsDiv = document.createElement('div');
instructionsDiv.style.position = 'absolute';
instructionsDiv.style.top = '50%';
instructionsDiv.style.left = '50%';
instructionsDiv.style.transform = 'translate(-50%, -50%)';
instructionsDiv.style.padding = '20px';
instructionsDiv.style.background = 'rgba(0, 0, 0, 0.8)';
instructionsDiv.style.color = 'white';
instructionsDiv.style.fontFamily = 'monospace';
instructionsDiv.style.fontSize = '14px';
instructionsDiv.style.borderRadius = '8px';
instructionsDiv.style.textAlign = 'center';
instructionsDiv.style.pointerEvents = 'auto';
instructionsDiv.style.cursor = 'pointer';
instructionsDiv.innerHTML = `
    <h2 style="margin-top: 0;">Click to Play</h2>
    <p style="margin-bottom: 0;">
        WASD - Move<br>
        Mouse - Look<br>
        Q - Swap Tool<br>
        ESC - Exit
    </p>
`;
container.appendChild(instructionsDiv);

instructionsDiv.addEventListener('click', () => {
    pointerLockControls.lock();
});

pointerLockControls.addEventListener('lock', () => {
    instructionsDiv.style.display = 'none';
});

pointerLockControls.addEventListener('unlock', () => {
    instructionsDiv.style.display = 'block';
});

// crosshair
const crosshairDiv = document.createElement('div');
crosshairDiv.style.position = 'absolute';
crosshairDiv.style.top = '50%';
crosshairDiv.style.left = '50%';
crosshairDiv.style.transform = 'translate(-50%, -50%)';
crosshairDiv.style.width = '4px';
crosshairDiv.style.height = '4px';
crosshairDiv.style.background = 'white';
crosshairDiv.style.borderRadius = '50%';
crosshairDiv.style.pointerEvents = 'none';
crosshairDiv.style.display = 'none';
container.appendChild(crosshairDiv);

pointerLockControls.addEventListener('lock', () => {
    crosshairDiv.style.display = 'block';
});

pointerLockControls.addEventListener('unlock', () => {
    crosshairDiv.style.display = 'none';
});

// bottom bar palette
const paletteDiv = document.createElement('div');
paletteDiv.style.position = 'absolute';
paletteDiv.style.bottom = '20px';
paletteDiv.style.left = '50%';
paletteDiv.style.transform = 'translateX(-50%)';
paletteDiv.style.display = 'flex';
paletteDiv.style.gap = '10px';
paletteDiv.style.padding = '15px 20px';
paletteDiv.style.background = 'rgba(0, 0, 0, 0.7)';
paletteDiv.style.borderRadius = '12px';
paletteDiv.style.fontFamily = 'monospace';
paletteDiv.style.fontSize = '14px';
paletteDiv.style.pointerEvents = 'auto';
paletteDiv.style.display = 'none'; // hidden until pointer lock
container.appendChild(paletteDiv);

type PlaceableType = 'box' | 'ramp' | 'platform' | 'delete';
let selectedPlaceable: PlaceableType = 'box';

const placeableTypes: Array<{ type: PlaceableType; label: string; emoji: string }> = [
    { type: 'box', label: 'Box', emoji: '📦' },
    { type: 'ramp', label: 'Ramp', emoji: '📐' },
    { type: 'platform', label: 'Platform', emoji: '🟦' },
    { type: 'delete', label: 'Delete', emoji: '🗑️' },
];

placeableTypes.forEach(({ type, label, emoji }) => {
    const button = document.createElement('button');
    button.style.padding = '10px 15px';
    button.style.background = 'rgba(255, 255, 255, 0.1)';
    button.style.border = '2px solid rgba(255, 255, 255, 0.3)';
    button.style.borderRadius = '8px';
    button.style.color = 'white';
    button.style.cursor = 'pointer';
    button.style.fontFamily = 'monospace';
    button.style.fontSize = '14px';
    button.style.transition = 'all 0.2s';
    button.innerHTML = `${emoji} ${label}`;
    
    const updateButtonStyle = () => {
        if (selectedPlaceable === type) {
            button.style.background = 'rgba(255, 255, 255, 0.3)';
            button.style.borderColor = 'rgba(255, 255, 255, 0.8)';
        } else {
            button.style.background = 'rgba(255, 255, 255, 0.1)';
            button.style.borderColor = 'rgba(255, 255, 255, 0.3)';
        }
    };
    
    button.addEventListener('mouseenter', () => {
        if (selectedPlaceable !== type) {
            button.style.background = 'rgba(255, 255, 255, 0.2)';
        }
    });
    
    button.addEventListener('mouseleave', updateButtonStyle);
    
    button.addEventListener('click', () => {
        selectedPlaceable = type;
        paletteDiv.querySelectorAll('button').forEach((btn) => {
            const btnType = placeableTypes.find(p => btn.innerHTML.includes(p.emoji))?.type;
            if (btnType === type) {
                btn.style.background = 'rgba(255, 255, 255, 0.3)';
                (btn as HTMLButtonElement).style.borderColor = 'rgba(255, 255, 255, 0.8)';
            } else {
                btn.style.background = 'rgba(255, 255, 255, 0.1)';
                (btn as HTMLButtonElement).style.borderColor = 'rgba(255, 255, 255, 0.3)';
            }
        });
    });
    
    updateButtonStyle();
    paletteDiv.appendChild(button);
});

pointerLockControls.addEventListener('lock', () => {
    paletteDiv.style.display = 'flex';
});

pointerLockControls.addEventListener('unlock', () => {
    paletteDiv.style.display = 'none';
});

/* Input state */
type InputState = {
    // Movement
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    
    // Actions (triggered once per press)
    primary: boolean;
    swapTool: boolean;
    jump: boolean;
    
    // Internal state for action detection
    _primaryPressed: boolean;
    _swapToolPressed: boolean;
    _jumpPressed: boolean;
};

const inputState: InputState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    primary: false,
    swapTool: false,
    jump: false,
    _primaryPressed: false,
    _swapToolPressed: false,
    _jumpPressed: false,
};

// Reset action flags (called each frame after processing)
function resetInputActions(input: InputState): void {
    input.primary = false;
    input.swapTool = false;
    input.jump = false;
}

const onKeyDown = (event: KeyboardEvent) => {
    switch (event.code) {
        case 'KeyW':
            inputState.forward = true;
            break;
        case 'KeyS':
            inputState.backward = true;
            break;
        case 'KeyA':
            inputState.left = true;
            break;
        case 'KeyD':
            inputState.right = true;
            break;
        case 'KeyQ':
            if (!inputState._swapToolPressed) {
                inputState.swapTool = true;
                inputState._swapToolPressed = true;
            }
            break;
        case 'Space':
            if (!inputState._jumpPressed) {
                inputState.jump = true;
                inputState._jumpPressed = true;
            }
            break;
    }
};

const onKeyUp = (event: KeyboardEvent) => {
    switch (event.code) {
        case 'KeyW':
            inputState.forward = false;
            break;
        case 'KeyS':
            inputState.backward = false;
            break;
        case 'KeyA':
            inputState.left = false;
            break;
        case 'KeyD':
            inputState.right = false;
            break;
        case 'KeyQ':
            inputState._swapToolPressed = false;
            break;
        case 'Space':
            inputState._jumpPressed = false;
            break;
    }
};

const onPointerDown = (event: MouseEvent) => {
    if (event.button === 0 && !inputState._primaryPressed) {
        inputState.primary = true;
        inputState._primaryPressed = true;
    }
};

const onPointerUp = (event: MouseEvent) => {
    if (event.button === 0) {
        inputState._primaryPressed = false;
    }
};

document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);
renderer.domElement.addEventListener('pointerdown', onPointerDown);
renderer.domElement.addEventListener('pointerup', onPointerUp);

// load level model
const levelModel = await loadGLTF('./models/lowpoly__fps__tdm__game__map_by_resoforge.glb');
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

const serTileKey = (x: number, y: number) => `${x}_${y}`;

const desTileKey = (out: [number, number], key: string): [number, number] => {
    const parts = key.split('_');
    out[0] = parseInt(parts[0], 10);
    out[1] = parseInt(parts[1], 10);
    return out;
};

// Reusable tuple for desTileKey
const _tileCoords: [number, number] = [0, 0];

/* dynamic NavMesh state */
let navMeshState: DynamicNavMeshState;

const _extractMeshWorldTriangles_position = new THREE.Vector3();

const extractMeshWorldTriangles = (mesh: THREE.Mesh) => {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (!geometry) return null;

    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr) return null;

    mesh.updateMatrixWorld();

    const positions = new Float32Array(positionAttr.count * 3);
    for (let i = 0; i < positionAttr.count; i++) {
        const position = _extractMeshWorldTriangles_position;
        position.set(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
        position.applyMatrix4(mesh.matrixWorld);
        positions[i * 3 + 0] = position.x;
        positions[i * 3 + 1] = position.y;
        positions[i * 3 + 2] = position.z;
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
        start: [-2.997126927323623, 4.200000002980238, -24.900715969043745],
        end: [-3.1817298705067922, 4.9569690329294436e-15, -22.32420388958813],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        flags: 0xffffff,
        area: 0x000000,
    },
    {
        start: [-11.412625930873357, 4.200000002980238, -25.209792275623663],
        end: [-11.636344760114076, 5.055820018452261e-15, -22.7693891511539],
        direction: OffMeshConnectionDirection.START_TO_END,
        radius: 0.5,
        flags: 0xffffff,
        area: 0x000000,
    },
];

/* Initialize physics */
const physicsState = initPhysics(levelPositions, levelIndices);

/* create player character controller */
const playerState = initPlayer(physicsState.world, new THREE.Vector3(0, 2, 5));

/* Initialize dynamic navmesh */
navMeshState = initDynamicNavMesh(navMeshConfig, levelPositions, levelIndices, meshBounds, offMeshConnections, physicsState, scene);

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
    navMeshState = initDynamicNavMesh(navMeshConfig, levelPositions, levelIndices, meshBounds, offMeshConnections, physicsState, scene);
    
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
navMeshContourFolder.add(navMeshConfig, 'maxSimplificationError', 0.1, 10, 0.1).name('Max Simplification Error').onChange(reinitializeNavMesh);
navMeshContourFolder.add(navMeshConfig, 'maxEdgeLength', 0, 50, 1).name('Max Edge Length').onChange(reinitializeNavMesh);

const navMeshPolyFolder = navMeshFolder.addFolder('PolyMesh');
navMeshPolyFolder.add(navMeshConfig, 'maxVerticesPerPoly', 3, 12, 1).name('Max Vertices/Poly').onChange(reinitializeNavMesh);

const navMeshDetailFolder = navMeshFolder.addFolder('Detail');
navMeshDetailFolder.add(navMeshConfig, 'detailSampleDistance', 0, 16, 1).name('Sample Distance (voxels)').onChange(reinitializeNavMesh);
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

/* Physics state and types */
type PhysicsObj = {
    id: number;
    rigidBody: Rapier.RigidBody;
    mesh: THREE.Mesh;
    lastRespawn: number;
    // last known world position (used for swept AABB tracking)
    lastPosition: Vec3;
    // last set of tiles this object was registered with (as tileKey strings)
    lastTiles: Set<string>;
    // collision radius used to mark the compact heightfield
    radius: number;
    // whether this is a static/fixed object (doesn't move after placement)
    isStatic: boolean;
};

type PhysicsState = {
    world: Rapier.World;
    objects: Map<number, PhysicsObj>;
    nextObjectId: number;
    levelRigidBody: Rapier.RigidBody;
    levelCollider: Rapier.Collider;
};

type TileFlash = {
    startTime: number;
    duration: number;
};

function initPhysics(
    levelPositions: Float32Array,
    levelIndices: Uint32Array,
): PhysicsState {
    // Create physics world
    const world = new Rapier.World(new Rapier.Vector3(0, -9.81, 0));
    
    // Create fixed trimesh collider for level
    const levelColliderDesc = Rapier.ColliderDesc.trimesh(
        new Float32Array(levelPositions),
        new Uint32Array(levelIndices)
    );
    levelColliderDesc.setMass(0);
    
    const levelRigidBodyDesc = Rapier.RigidBodyDesc.fixed();
    const levelRigidBody = world.createRigidBody(levelRigidBodyDesc);
    const levelCollider = world.createCollider(levelColliderDesc, levelRigidBody);
    
    return {
        world,
        objects: new Map(),
        nextObjectId: 1,
        levelRigidBody,
        levelCollider,
    };
}

function updatePhysics(
    physicsState: PhysicsState,
    deltaTime: number,
): void {
    // Step physics simulation
    physicsState.world.timestep = deltaTime;
    physicsState.world.step();
    
    // Update mesh transforms from rigid bodies
    for (const [_, obj] of physicsState.objects) {
        const position = obj.rigidBody.translation();
        const rotation = obj.rigidBody.rotation();
        
        obj.mesh.position.set(position.x, position.y, position.z);
        obj.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
}

type PlayerState = {
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    noclipSpeed: number;
    moveSpeed: number;
    sprintMultiplier: number;
    jumpSpeed: number;
    isGrounded: boolean;
    noclip: boolean;
    characterController: Rapier.KinematicCharacterController | null;
    rigidBody: Rapier.RigidBody | null;
    collider: Rapier.Collider | null;
};

function initPlayer(
    physicsWorld: Rapier.World,
    initialPosition: THREE.Vector3,
): PlayerState {
    const playerRadius = 0.3;
    const playerHeight = 1.8;

    // Create kinematic character controller
    const characterController = physicsWorld.createCharacterController(0.01);
    characterController.enableAutostep(0.5, 0.2, true);
    characterController.enableSnapToGround(0.5);
    characterController.setMaxSlopeClimbAngle(45 * Math.PI / 180);
    characterController.setMinSlopeSlideAngle(30 * Math.PI / 180);

    // Create capsule collider for player
    const playerColliderDesc = Rapier.ColliderDesc.capsule(playerHeight / 2 - playerRadius, playerRadius);
    const playerRigidBodyDesc = Rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        initialPosition.x,
        initialPosition.y,
        initialPosition.z
    );

    const rigidBody = physicsWorld.createRigidBody(playerRigidBodyDesc);
    const collider = physicsWorld.createCollider(playerColliderDesc, rigidBody);

    return {
        position: initialPosition.clone(),
        velocity: new THREE.Vector3(0, 0, 0),
        noclipSpeed: 20,
        moveSpeed: 8,
        sprintMultiplier: 1.5,
        jumpSpeed: 8,
        isGrounded: false,
        noclip: false,
        characterController,
        rigidBody,
        collider,
    };
}

function updatePlayer(
    state: PlayerState,
    camera: THREE.Camera,
    input: InputState,
    isControlsLocked: boolean,
    deltaTime: number,
): void {
    if (!isControlsLocked) {
        return;
    }

    // Compute horizontal movement from input
    _moveDirection.set(0, 0, 0);
    
    if (input.forward) _moveDirection.z -= 1;
    if (input.backward) _moveDirection.z += 1;
    if (input.left) _moveDirection.x -= 1;
    if (input.right) _moveDirection.x += 1;
    
    if (_moveDirection.length() > 0) {
        _moveDirection.normalize();
    }
    
    // Transform direction to camera space
    camera.getWorldDirection(_cameraDirection);
    
    if (state.noclip) {
        // Noclip mode: free flying movement
        const speed = state.noclipSpeed;
        
        _cameraRight.crossVectors(camera.up, _cameraDirection).normalize();
        
        _moveVector.set(0, 0, 0);
        _moveVector.addScaledVector(_cameraDirection, -_moveDirection.z);
        _moveVector.addScaledVector(_cameraRight, -_moveDirection.x);
        
        // Apply movement directly
        state.position.addScaledVector(_moveVector, speed * deltaTime);
        
        // Update rigid body position (even though collision is disabled)
        if (state.rigidBody) {
            state.rigidBody.setTranslation(state.position, true);
        }
    } else {
        // Normal physics-based movement
        if (!state.characterController || !state.collider) {
            return;
        }

        const controller = state.characterController;
        const collider = state.collider;
        
        _horizontalVelocity.set(0, 0, 0);
        
        if (_moveDirection.length() > 0) {
            // Transform direction to camera space (horizontal only)
            _cameraDirection.y = 0;
            _cameraDirection.normalize();
            
            _cameraRight.crossVectors(camera.up, _cameraDirection).normalize();
            
            _moveVector.set(0, 0, 0);
            _moveVector.addScaledVector(_cameraDirection, -_moveDirection.z);
            _moveVector.addScaledVector(_cameraRight, -_moveDirection.x);
            _moveVector.normalize();
            
            const speed = state.moveSpeed;
            _horizontalVelocity.copy(_moveVector.multiplyScalar(speed));
        }
        
        // Apply gravity to vertical velocity
        const gravity = -20.0;
        state.velocity.y += gravity * deltaTime;
        
        // Combine horizontal and vertical velocity
        _desiredMovement.set(
            _horizontalVelocity.x * deltaTime,
            state.velocity.y * deltaTime,
            _horizontalVelocity.z * deltaTime
        );
        
        // Compute collision-corrected movement
        controller.computeColliderMovement(
            collider,
            _desiredMovement,
            Rapier.QueryFilterFlags.EXCLUDE_SENSORS,
            undefined
        );
        
        const correctedMovement = controller.computedMovement();
        
        // Update player position
        state.position.x += correctedMovement.x;
        state.position.y += correctedMovement.y;
        state.position.z += correctedMovement.z;
        
        // Update rigid body position
        if (state.rigidBody) {
            state.rigidBody.setTranslation(state.position, true);
        }
        
        // Check if grounded
        state.isGrounded = controller.computedGrounded();
        
        // Reset vertical velocity if grounded
        if (state.isGrounded && state.velocity.y < 0) {
            state.velocity.y = 0;
        }
    }
    
    // Update camera position (eye height)
    camera.position.copy(state.position);
    camera.position.y += 0.6; // eye offset from center
}

function spawnBox(
    navMeshState: DynamicNavMeshState,
    scene: THREE.Scene,
    position: THREE.Vector3,
    yRotation: number,
    raycastTargets: THREE.Object3D[],
): PhysicsObj {
    // Create mesh
    const boxGeometry = createBoxGeometry();
    const boxMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
    boxMesh.position.copy(position);
    boxMesh.rotation.set(0, yRotation, 0);

    scene.add(boxMesh);
    raycastTargets.push(boxMesh);

    // Create physics body
    const boxColliderDesc = Rapier.ColliderDesc.cuboid(BOX_SIZE_X / 2, BOX_HEIGHT / 2, BOX_SIZE_Z / 2);
    boxColliderDesc.setRestitution(0.1);
    boxColliderDesc.setFriction(0.5);
    boxColliderDesc.setDensity(1.0);
    
    const boxRigidBodyDesc = Rapier.RigidBodyDesc.dynamic().setTranslation(
        position.x,
        position.y,
        position.z,
    );
    
    // Apply rotation to rigid body
    const quaternion = new THREE.Quaternion();
    quaternion.setFromEuler(new THREE.Euler(0, yRotation, 0));
    boxRigidBodyDesc.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });

    const boxRigidBody = navMeshState.physics.world.createRigidBody(boxRigidBodyDesc);
    navMeshState.physics.world.createCollider(boxColliderDesc, boxRigidBody);

    // Compute approximate radius from geometry bounding sphere
    const geom = boxMesh.geometry as THREE.BufferGeometry;
    if (!geom.boundingSphere) geom.computeBoundingSphere();
    const bs = geom.boundingSphere!;
    const worldRadius = bs.radius * (boxMesh.scale.x || 1) || 0.5;

    // Find current tiles overlapping the object's bounding box
    const pos = boxMesh.position;
    const r = worldRadius;
    const min: Vec3 = [pos.x - r, pos.y - r, pos.z - r];
    const max: Vec3 = [pos.x + r, pos.y + r, pos.z + r];

    const tiles = tilesForAABB(navMeshState, min, max);
    const tilesSet = new Set<string>();
    
    // Get next ID and increment counter
    const objId = navMeshState.physics.nextObjectId++;
    
    for (const [tx, ty] of tiles) {
        const k = serTileKey(tx, ty);
        tilesSet.add(k);
        let s = navMeshState.tracking.tileToObjects.get(k);
        if (!s) {
            s = new Set<number>();
            navMeshState.tracking.tileToObjects.set(k, s);
        }
        s.add(objId);
        enqueueTile(navMeshState, tx, ty);
    }

    // Create physics object
    const physicsObject: PhysicsObj = {
        id: objId,
        rigidBody: boxRigidBody,
        mesh: boxMesh,
        lastRespawn: performance.now(),
        lastPosition: [boxRigidBody.translation().x, boxRigidBody.translation().y, boxRigidBody.translation().z],
        lastTiles: tilesSet,
        radius: worldRadius,
        isStatic: false, // Box is dynamic
    };

    navMeshState.physics.objects.set(objId, physicsObject);
    
    return physicsObject;
}

function spawnRamp(
    navMeshState: DynamicNavMeshState,
    scene: THREE.Scene,
    position: THREE.Vector3,
    yRotation: number,
    raycastTargets: THREE.Object3D[],
): PhysicsObj {
    // Create mesh
    const rampGeometry = createRampGeometry();
    const rampMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const rampMesh = new THREE.Mesh(rampGeometry, rampMaterial);
    rampMesh.position.copy(position);
    rampMesh.rotation.set(0, yRotation, 0);

    scene.add(rampMesh);
    raycastTargets.push(rampMesh);
    
    // Update world matrix to ensure bounding calculations are correct
    rampMesh.updateMatrixWorld(true);

    // Create convex hull collider for physics (Rapier will compute it from the mesh)
    const meshPositions = [];
    const posAttr = rampGeometry.getAttribute('position');
    for (let i = 0; i < posAttr.count; i++) {
        meshPositions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    }
    
    const rampColliderDesc = Rapier.ColliderDesc.convexHull(new Float32Array(meshPositions));
    if (!rampColliderDesc) {
        // Fallback to cuboid if convex hull fails
        console.warn('Failed to create convex hull, using cuboid');
        const rampColliderDesc = Rapier.ColliderDesc.cuboid(RAMP_WIDTH / 2, RAMP_HEIGHT / 2, RAMP_DEPTH / 2);
        rampColliderDesc.setRestitution(0.1);
        rampColliderDesc.setFriction(0.8);
        rampColliderDesc.setDensity(100.0); // Heavy to prevent tipping
    } else {
        rampColliderDesc.setRestitution(0.1);
        rampColliderDesc.setFriction(0.8);
        rampColliderDesc.setDensity(100.0); // Heavy to prevent tipping
    }
    
    const rampRigidBodyDesc = Rapier.RigidBodyDesc.fixed() // Make it fixed (static) instead of dynamic
        .setTranslation(position.x, position.y, position.z);
    
    // Apply rotation to rigid body
    const quaternion = new THREE.Quaternion();
    quaternion.setFromEuler(new THREE.Euler(0, yRotation, 0));
    rampRigidBodyDesc.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });

    const rampRigidBody = navMeshState.physics.world.createRigidBody(rampRigidBodyDesc);
    navMeshState.physics.world.createCollider(rampColliderDesc!, rampRigidBody);

    // Compute approximate radius from geometry bounding sphere
    const geom = rampMesh.geometry as THREE.BufferGeometry;
    if (!geom.boundingSphere) geom.computeBoundingSphere();
    const bs = geom.boundingSphere!;
    const worldRadius = bs.radius * Math.max(rampMesh.scale.x, rampMesh.scale.y, rampMesh.scale.z) || 1.5;

    // Find current tiles overlapping the object's bounding box
    const pos = rampMesh.position;
    const r = worldRadius;
    const min: Vec3 = [pos.x - r, pos.y - r, pos.z - r];
    const max: Vec3 = [pos.x + r, pos.y + r, pos.z + r];

    const tiles = tilesForAABB(navMeshState, min, max);
    const tilesSet = new Set<string>();
    
    // Get next ID and increment counter
    const objId = navMeshState.physics.nextObjectId++;
    
    for (const [tx, ty] of tiles) {
        const k = serTileKey(tx, ty);
        tilesSet.add(k);
        let s = navMeshState.tracking.tileToObjects.get(k);
        if (!s) {
            s = new Set<number>();
            navMeshState.tracking.tileToObjects.set(k, s);
        }
        s.add(objId);
        enqueueTile(navMeshState, tx, ty);
    }

    // Create physics object
    const physicsObject: PhysicsObj = {
        id: objId,
        rigidBody: rampRigidBody,
        mesh: rampMesh,
        lastRespawn: performance.now(),
        lastPosition: [rampRigidBody.translation().x, rampRigidBody.translation().y, rampRigidBody.translation().z],
        lastTiles: tilesSet,
        radius: worldRadius,
        isStatic: true, // Ramp is static/fixed
    };

    navMeshState.physics.objects.set(objId, physicsObject);
    
    return physicsObject;
}

function spawnPlatform(
    navMeshState: DynamicNavMeshState,
    scene: THREE.Scene,
    position: THREE.Vector3,
    yRotation: number,
    raycastTargets: THREE.Object3D[],
): PhysicsObj {
    // Create mesh
    const platformGeometry = createPlatformGeometry();
    const platformMaterial = new THREE.MeshStandardMaterial({ color: 0x0088ff });
    const platformMesh = new THREE.Mesh(platformGeometry, platformMaterial);
    platformMesh.position.copy(position);
    platformMesh.rotation.set(0, yRotation, 0);

    scene.add(platformMesh);
    raycastTargets.push(platformMesh);
    
    // Update world matrix to ensure bounding calculations are correct
    platformMesh.updateMatrixWorld(true);

    // Create physics body (static/fixed)
    const platformColliderDesc = Rapier.ColliderDesc.cuboid(PLATFORM_WIDTH / 2, PLATFORM_HEIGHT / 2, PLATFORM_DEPTH / 2);
    platformColliderDesc.setRestitution(0.1);
    platformColliderDesc.setFriction(0.8);
    
    const platformRigidBodyDesc = Rapier.RigidBodyDesc.fixed()
        .setTranslation(position.x, position.y, position.z);
    
    // Apply rotation to rigid body
    const quaternion = new THREE.Quaternion();
    quaternion.setFromEuler(new THREE.Euler(0, yRotation, 0));
    platformRigidBodyDesc.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });

    const platformRigidBody = navMeshState.physics.world.createRigidBody(platformRigidBodyDesc);
    navMeshState.physics.world.createCollider(platformColliderDesc, platformRigidBody);

    // Compute approximate radius from geometry bounding sphere
    const geom = platformMesh.geometry as THREE.BufferGeometry;
    if (!geom.boundingSphere) geom.computeBoundingSphere();
    const bs = geom.boundingSphere!;
    const worldRadius = bs.radius * Math.max(platformMesh.scale.x, platformMesh.scale.y, platformMesh.scale.z) || 1.5;

    // Find current tiles overlapping the object's bounding box
    const pos = platformMesh.position;
    const r = worldRadius;
    const min: Vec3 = [pos.x - r, pos.y - r, pos.z - r];
    const max: Vec3 = [pos.x + r, pos.y + r, pos.z + r];

    const tiles = tilesForAABB(navMeshState, min, max);
    const tilesSet = new Set<string>();
    
    // Get next ID and increment counter
    const objId = navMeshState.physics.nextObjectId++;
    
    for (const [tx, ty] of tiles) {
        const k = serTileKey(tx, ty);
        tilesSet.add(k);
        let s = navMeshState.tracking.tileToObjects.get(k);
        if (!s) {
            s = new Set<number>();
            navMeshState.tracking.tileToObjects.set(k, s);
        }
        s.add(objId);
        enqueueTile(navMeshState, tx, ty);
    }

    // Create physics object
    const physicsObject: PhysicsObj = {
        id: objId,
        rigidBody: platformRigidBody,
        mesh: platformMesh,
        lastRespawn: performance.now(),
        lastPosition: [platformRigidBody.translation().x, platformRigidBody.translation().y, platformRigidBody.translation().z],
        lastTiles: tilesSet,
        radius: worldRadius,
        isStatic: true, // Platform is static/fixed
    };

    navMeshState.physics.objects.set(objId, physicsObject);
    
    return physicsObject;
}

function deleteObject(
    navMeshState: DynamicNavMeshState,
    scene: THREE.Scene,
    mesh: THREE.Mesh,
    raycastTargets: THREE.Object3D[],
): void {
    // Find the physics object by mesh
    let objId: number | null = null;
    for (const [id, obj] of navMeshState.physics.objects) {
        if (obj.mesh === mesh) {
            objId = id;
            break;
        }
    }
    
    if (objId === null) return;
    
    const physicsObject = navMeshState.physics.objects.get(objId)!;
    
    // Remove from physics world
    if (physicsObject.rigidBody) {
        navMeshState.physics.world.removeRigidBody(physicsObject.rigidBody);
    }
    
    // Remove from scene
    scene.remove(mesh);
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
        for (const mat of mesh.material) {
            mat.dispose();
        }
    } else {
        mesh.material.dispose();
    }
    
    // Remove from raycast targets
    const raycastIndex = raycastTargets.indexOf(mesh);
    if (raycastIndex !== -1) {
        raycastTargets.splice(raycastIndex, 1);
    }
    
    // Mark tiles for rebuild (the update loop will clean up stale references)
    for (const tileKey of physicsObject.lastTiles) {
        const [tx, ty] = desTileKey(_tileCoords, tileKey);
        enqueueTile(navMeshState, tx, ty);
    }
    
    // Remove from physics objects map
    navMeshState.physics.objects.delete(objId);
}

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
        tileBounds: Map<string, Box3>;
        tileExpandedBounds: Map<string, Box3>;
        tileStaticTriangles: Map<string, number[]>;
        tileStaticHeightfields: Map<string, ReturnType<typeof createHeightfield>>;
    };
    
    // Physics state
    physics: PhysicsState;
    
    // Dynamic tracking
    tracking: {
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
    meshBounds: Box3;
};

function initDynamicNavMesh(
    config: typeof navMeshConfig,
    levelPositions: Float32Array,
    levelIndices: Uint32Array,
    meshBounds: Box3,
    offMeshConnections: OffMeshConnectionParams[],
    physicsState: PhysicsState,
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
    box3.min(navMesh.origin, meshBounds);
    
    // 2. Build static tile caches
    const tileBoundsCache = new Map<string, Box3>();
    const tileExpandedBoundsCache = new Map<string, Box3>();
    const tileStaticTriangles = new Map<string, number[]>();
    const tileStaticHeightfields = new Map<string, ReturnType<typeof createHeightfield>>();
    
    const borderOffset = config.borderSize * config.cellSize;
    const triA: Vec3 = [0, 0, 0];
    const triB: Vec3 = [0, 0, 0];
    const triC: Vec3 = [0, 0, 0];

    for (let tx = 0; tx < tileWidth; tx++) {
        for (let ty = 0; ty < tileHeight; ty++) {
            const minX = meshBounds[0] + tx * tileSizeWorld;
            const minY = meshBounds[1];
            const minZ = meshBounds[2] + ty * tileSizeWorld;
            const maxX = meshBounds[0] + (tx + 1) * tileSizeWorld;
            const maxY = meshBounds[4];
            const maxZ = meshBounds[2] + (ty + 1) * tileSizeWorld;
            const bounds: Box3 = [minX, minY, minZ, maxX, maxY, maxZ];
            const key = serTileKey(tx, ty);
            tileBoundsCache.set(key, bounds);

            const expandedBounds: Box3 = [minX - borderOffset, minY, minZ - borderOffset, maxX + borderOffset, maxY, maxZ + borderOffset];
            tileExpandedBoundsCache.set(key, expandedBounds);

            const trianglesInBox: number[] = [];

            for (let i = 0; i < levelIndices.length; i += 3) {
                const a = levelIndices[i];
                const b = levelIndices[i + 1];
                const c = levelIndices[i + 2];

                vec3.fromBuffer(triA, levelPositions, a * 3);
                vec3.fromBuffer(triB, levelPositions, b * 3);
                vec3.fromBuffer(triC, levelPositions, c * 3);

                if (box3.intersectsTriangle3(expandedBounds, triA, triB, triC)) {
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
            const key = serTileKey(tx, ty);
            const expandedBounds = tileExpandedBoundsCache.get(key);
            if (!expandedBounds) continue;
            
            // create heightfield for this tile
            const heightfield = createHeightfield(
                hfSize,
                hfSize,
                expandedBounds,
                config.cellSize,
                config.cellHeight,
            );
            
            // rasterize static geometry only
            const staticTriangles = tileStaticTriangles.get(key) ?? [];
            if (staticTriangles.length > 0) {
                const staticAreaIds = new Uint8Array(staticTriangles.length / 3);
                markWalkableTriangles(
                    levelPositions,
                    staticTriangles,
                    staticAreaIds,
                    config.walkableSlopeAngleDegrees,
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
        physics: physicsState,
        tracking: {
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

function buildTileAtCoords(
    state: DynamicNavMeshState,
    scene: THREE.Scene,
    tx: number,
    ty: number,
): void {
    const key = serTileKey(tx, ty);
    
    // Clone the pre-rasterized static heightfield for this tile
    const cachedHeightfield = state.caches.tileStaticHeightfields.get(key);
    if (!cachedHeightfield) {
        throw new Error(`No cached heightfield found for tile ${tx}, ${ty}`);
    }
    
    const heightfield = structuredClone(cachedHeightfield);
    
    // Rasterize dynamic obstacles (only if there are any)
    const dynamicObjects = state.tracking.tileToObjects.get(key);
    if (dynamicObjects && dynamicObjects.size > 0) {
        for (const objId of dynamicObjects) {
            const obj = state.physics.objects.get(objId);
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
                state.config.walkableSlopeAngleDegrees,
            );
            rasterizeTriangles(
                state.buildCtx,
                heightfield,
                positions,
                indices,
                areaIds,
                state.config.walkableClimbVoxels,
            );
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
    const tileKeyStr = serTileKey(tx, ty);
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
    const key = serTileKey(x, y);
    if (state.tracking.dirtyTiles.has(key)) return;
    state.tracking.dirtyTiles.add(key);
    state.tracking.rebuildQueue.push([x, y]);
}

function processRebuildQueue(
    state: DynamicNavMeshState,
    scene: THREE.Scene,
    maxPerFrame: number,
): void {
    let processed = 0;
    
    for (let i = 0; i < state.tracking.rebuildQueue.length; i++) {
        if (processed >= maxPerFrame) break;
        
        const tile = state.tracking.rebuildQueue.shift();
        if (!tile) return;
        const [tx, ty] = tile;
        const key = serTileKey(tx, ty);
        
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
    if (
        state.config.tileWidth <= 0 ||
        state.config.tileHeight <= 0 ||
        state.config.tileSizeWorld <= 0
    ) {
        return [];
    }
    
    const rawMinX = Math.floor((min[0] - state.meshBounds[0]) / state.config.tileSizeWorld);
    const rawMinY = Math.floor((min[2] - state.meshBounds[2]) / state.config.tileSizeWorld);
    const rawMaxX = Math.floor((max[0] - state.meshBounds[0]) / state.config.tileSizeWorld);
    const rawMaxY = Math.floor((max[2] - state.meshBounds[2]) / state.config.tileSizeWorld);
    
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

function updateObjectTiles(
    state: DynamicNavMeshState,
    objId: number,
    newTiles: Set<string>,
): void {
    const obj = state.physics.objects.get(objId);
    if (!obj) return;
    
    // compute tiles to remove (in lastTiles but not in newTiles)
    for (const oldKey of obj.lastTiles) {
        if (!newTiles.has(oldKey)) {
            const s = state.tracking.tileToObjects.get(oldKey);
            if (s) {
                s.delete(objId);
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
            s.add(objId);
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
    // Clean up stale object references in tile tracking
    for (const [tileKey, objectIds] of state.tracking.tileToObjects) {
        for (const objId of objectIds) {
            if (!state.physics.objects.has(objId)) {
                objectIds.delete(objId);
            }
        }
        // Remove empty tile entries
        if (objectIds.size === 0) {
            state.tracking.tileToObjects.delete(tileKey);
        }
    }
    
    // schedule tiles based on movements of physics objects between tiles
    for (const [objId, obj] of state.physics.objects) {
        // skip static objects, they never move after placement
        if (obj.isStatic) {
            continue;
        }
        
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
        
        const tiles = tilesForAABB(state, min, max);
        const newTiles = new Set<string>();
        for (const [tx, ty] of tiles) {
            newTiles.add(serTileKey(tx, ty));
        }
        
        const isSleeping = obj.rigidBody.isSleeping();
        
        // Rebuild tiles we left (object no longer present, needs removal)
        for (const oldKey of obj.lastTiles) {
            if (!newTiles.has(oldKey)) {
                const [tx, ty] = desTileKey(_tileCoords, oldKey);
                enqueueTile(state, tx, ty);
            }
        }
        
        // Rebuild current tiles only if object is awake (moving/settling)
        if (!isSleeping) {
            for (const newKey of newTiles) {
                const [tx, ty] = desTileKey(_tileCoords, newKey);
                enqueueTile(state, tx, ty);
            }
        }
        
        // Update object tile registrations
        updateObjectTiles(state, objId, newTiles);
        
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

// double-tap space to toggle noclip, single tap to jump
let lastJumpPress = 0;
const DOUBLE_TAP_THRESHOLD = 250; // ms - must be quick and deliberate

function processPlayerActions(
    state: PlayerState,
    input: InputState,
    isControlsLocked: boolean,
): void {
    if (!isControlsLocked) return;
    
    // Handle jump/noclip toggle
    if (input.jump) {
        const now = performance.now();
        const timeSinceLastPress = now - lastJumpPress;
        
        if (timeSinceLastPress < DOUBLE_TAP_THRESHOLD) {
            // Double tap detected - toggle noclip
            state.noclip = !state.noclip;
            console.log(`Noclip ${state.noclip ? 'enabled' : 'disabled'}`);
            
            // Reset velocity when toggling noclip
            if (!state.noclip) {
                state.velocity.set(0, 0, 0);
            }
            
            lastJumpPress = 0; // Reset to prevent triple-tap
        } else {
            // Single tap - jump (only if not in noclip mode)
            if (!state.noclip && state.isGrounded) {
                state.velocity.y = state.jumpSpeed;
            }
            lastJumpPress = now;
        }
    }
}

/* rapier debug rendering */
let rapierDebugLineSegments: THREE.LineSegments | null = null;

const renderRapierDebug = (physicsState: PhysicsState): void => {
    if (guiSettings.showRapierDebug) {
        const debugFn = physicsState.world.debugRender;
        if (typeof debugFn === 'function') {
            if (!rapierDebugLineSegments) {
                const geo = new THREE.BufferGeometry();
                const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
                rapierDebugLineSegments = new THREE.LineSegments(geo, mat);
                rapierDebugLineSegments.renderOrder = 999;
                scene.add(rapierDebugLineSegments);
            }

            const { vertices, colors } = debugFn.call(physicsState.world);
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

/* Placeable object geometries */
const BOX_SIZE_X = 0.5;
const BOX_HEIGHT = 0.5;
const BOX_SIZE_Z = 0.5;

const RAMP_WIDTH = 1.5;
const RAMP_HEIGHT = 0.7;
const RAMP_DEPTH = 1.0;

const PLATFORM_WIDTH = 2.0;
const PLATFORM_HEIGHT = 0.2;
const PLATFORM_DEPTH = 2.0;

const createBoxGeometry = (): THREE.BoxGeometry => {
    return new THREE.BoxGeometry(BOX_SIZE_X, BOX_HEIGHT, BOX_SIZE_Z);
};

const createPlatformGeometry = (): THREE.BoxGeometry => {
    return new THREE.BoxGeometry(PLATFORM_WIDTH, PLATFORM_HEIGHT, PLATFORM_DEPTH);
};

const createRampGeometry = (): THREE.BufferGeometry => {
    const geometry = new THREE.BufferGeometry();
    
    // Define vertices for a wedge (ramp shape)
    // Ramp slopes from front (low) to back (high)
    const vertices = new Float32Array([
        // Bottom face (4 vertices)
        -RAMP_WIDTH/2, 0, RAMP_DEPTH/2,   // 0: front left bottom
        RAMP_WIDTH/2, 0, RAMP_DEPTH/2,    // 1: front right bottom
        RAMP_WIDTH/2, 0, -RAMP_DEPTH/2,   // 2: back right bottom
        -RAMP_WIDTH/2, 0, -RAMP_DEPTH/2,  // 3: back left bottom
        
        // Top face (2 vertices) - only at the back
        -RAMP_WIDTH/2, RAMP_HEIGHT, -RAMP_DEPTH/2,  // 4: back left top
        RAMP_WIDTH/2, RAMP_HEIGHT, -RAMP_DEPTH/2,   // 5: back right top
    ]);
    
    // Define triangles with counter-clockwise winding (when viewed from outside)
    const indices = new Uint16Array([
        // Bottom face (looking up from below, CCW from below)
        0, 2, 1,
        0, 3, 2,
        
        // Back face (tall end, looking from behind, CCW from behind)
        4, 5, 2,
        4, 2, 3,
        
        // Left face (looking from left side, CCW from left)
        0, 4, 3,
        
        // Right face (looking from right side, CCW from right)
        1, 2, 5,
        
        // Sloped face (the ramp surface, looking from above)
        // CCW from above so normal points up
        0, 1, 4,
        1, 5, 4,
    ]);
    
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    
    return geometry;
};

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
        metalness: 0.3
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

const updateAgentVisuals = (
    agent: crowd.Agent,
    visuals: AgentVisuals,
): void => {
    // Update capsule position
    visuals.capsule.position.set(
        agent.position[0],
        agent.position[1] + agentParams.height / 2,
        agent.position[2]
    );

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
const agentsSpawn: Vec3 = [0.15428635340626662, 2.2274933360741205e-16, -1.0031738158313672];
const agentPositions: Vec3[] = Array.from({ length: 20 }).map((_, i) => [agentsSpawn[0] + i * -0.05, agentsSpawn[1], agentsSpawn[2] + i * 0.05]) as Vec3[];

const agentColors = [0x0000ff, 0x00ff00];

const agentVisuals: Record<string, AgentVisuals> = {};
const agentLastTargetUpdate: Record<string, number> = {};

// Agent target update interval in seconds
const AGENT_TARGET_UPDATE_INTERVAL = 0.2;

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i % agentColors.length];

    // add agent to crowd
    const agentId = crowd.addAgent(catsCrowd, navMeshState.navMesh, position, agentParams);
    console.log(`Creating agent ${i} at position:`, position);

    // create visuals for the agent
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, agentParams.radius, agentParams.height);
    
    // initialize last target update time
    agentLastTargetUpdate[agentId] = 0;
}

/* Initialize tool system */
const toolState = initTools(scene);

/* Tool system state */
type ToolState = {
    previewMeshes: {
        box: THREE.Mesh;
        ramp: THREE.Mesh;
        platform: THREE.Mesh;
    };
    currentPreview: THREE.Mesh | null;
};

function initTools(scene: THREE.Scene): ToolState {
    // Create box preview mesh
    const boxGeometry = createBoxGeometry();
    const boxMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xff0000, 
        transparent: true, 
        opacity: 0.5,
        wireframe: false
    });
    const boxPreview = new THREE.Mesh(boxGeometry, boxMaterial);
    boxPreview.renderOrder = 1000;
    boxPreview.visible = false;
    scene.add(boxPreview);
    
    // Create ramp preview mesh
    const rampGeometry = createRampGeometry();
    const rampMaterial = new THREE.MeshBasicMaterial({ 
        color: 0x00ff00, 
        transparent: true, 
        opacity: 0.5,
        wireframe: false
    });
    const rampPreview = new THREE.Mesh(rampGeometry, rampMaterial);
    rampPreview.renderOrder = 1000;
    rampPreview.visible = false;
    scene.add(rampPreview);
    
    // Create platform preview mesh
    const platformGeometry = createPlatformGeometry();
    const platformMaterial = new THREE.MeshBasicMaterial({ 
        color: 0x0088ff, 
        transparent: true, 
        opacity: 0.5,
        wireframe: false
    });
    const platformPreview = new THREE.Mesh(platformGeometry, platformMaterial);
    platformPreview.renderOrder = 1000;
    platformPreview.visible = false;
    scene.add(platformPreview);
    
    return {
        previewMeshes: {
            box: boxPreview,
            ramp: rampPreview,
            platform: platformPreview,
        },
        currentPreview: null,
    };
}

function updateTools(
    toolState: ToolState,
    selectedTool: PlaceableType,
    playerPosition: THREE.Vector3,
    cameraDirection: THREE.Vector3,
    isControlsLocked: boolean,
): void {
    // Hide all previews if not in placement mode
    if (!isControlsLocked || selectedTool === 'delete') {
        if (toolState.currentPreview) {
            toolState.currentPreview.visible = false;
            toolState.currentPreview = null;
        }
        return;
    }
    
    // Select appropriate preview mesh
    let targetPreview: THREE.Mesh;
    if (selectedTool === 'box') {
        targetPreview = toolState.previewMeshes.box;
    } else if (selectedTool === 'ramp') {
        targetPreview = toolState.previewMeshes.ramp;
    } else if (selectedTool === 'platform') {
        targetPreview = toolState.previewMeshes.platform;
    } else {
        return; // delete tool already handled above
    }
    
    // Hide previous preview if different
    if (toolState.currentPreview && toolState.currentPreview !== targetPreview) {
        toolState.currentPreview.visible = false;
    }
    
    // Update current preview
    toolState.currentPreview = targetPreview;
    toolState.currentPreview.visible = true;
    
    // Position preview 2 units in front of player
    toolState.currentPreview.position.copy(playerPosition);
    toolState.currentPreview.position.addScaledVector(cameraDirection, 2);
    
    // Rotate preview to face camera direction
    let yRotation = Math.atan2(cameraDirection.x, cameraDirection.z);
    // Flip ramp 180 degrees so it ramps up towards the player
    if (selectedTool === 'ramp') {
        yRotation += Math.PI;
    }
    toolState.currentPreview.rotation.set(0, yRotation, 0);
}

// raycaster for object selection
const raycaster = new THREE.Raycaster();

// Process input actions (tool usage)
function processInputActions(
    input: InputState,
    selectedTool: PlaceableType,
    isControlsLocked: boolean,
): void {
    // Handle primary action (spawn/delete)
    if (input.primary && isControlsLocked) {
        if (selectedTool === 'delete') {
            // Raycast to find object to delete
            camera.getWorldDirection(_cameraDirection);
            raycaster.set(camera.position, _cameraDirection);
            
            const intersects = raycaster.intersectObjects(raycastTargets);
            if (intersects.length > 0) {
                const targetMesh = intersects[0].object as THREE.Mesh;
                deleteObject(navMeshState, scene, targetMesh, raycastTargets);
            }
        } else {
            // Spawn object in front of player
            camera.getWorldDirection(_cameraDirection);
            _spawnPosition
                .copy(playerState.position)
                .addScaledVector(_cameraDirection, 2); // 2 units in front
            
            // Calculate Y rotation from camera direction (horizontal plane)
            let yRotation = Math.atan2(_cameraDirection.x, _cameraDirection.z);
            
            if (selectedTool === 'box') {
                spawnBox(navMeshState, scene, _spawnPosition, yRotation, raycastTargets);
            } else if (selectedTool === 'ramp') {
                // Flip 180 degrees so ramp faces towards player (ramps up)
                yRotation += Math.PI;
                spawnRamp(navMeshState, scene, _spawnPosition, yRotation, raycastTargets);
            } else if (selectedTool === 'platform') {
                spawnPlatform(navMeshState, scene, _spawnPosition, yRotation, raycastTargets);
            }
        }
    }
    
    // Handle tool swapping
    if (input.swapTool && isControlsLocked) {
        // Cycle through placeables
        const currentIndex = placeableTypes.findIndex(p => p.type === selectedTool);
        const nextIndex = (currentIndex + 1) % placeableTypes.length;
        selectedPlaceable = placeableTypes[nextIndex].type;
        
        // Update button styles
        paletteDiv.querySelectorAll('button').forEach((btn) => {
            const btnType = placeableTypes.find(p => btn.innerHTML.includes(p.emoji))?.type;
            if (btnType === selectedPlaceable) {
                (btn as HTMLButtonElement).style.background = 'rgba(255, 255, 255, 0.3)';
                (btn as HTMLButtonElement).style.borderColor = 'rgba(255, 255, 255, 0.8)';
            } else {
                (btn as HTMLButtonElement).style.background = 'rgba(255, 255, 255, 0.1)';
                (btn as HTMLButtonElement).style.borderColor = 'rgba(255, 255, 255, 0.3)';
            }
        });
    }
}

const _moveDirection = new THREE.Vector3();
const _horizontalVelocity = new THREE.Vector3();
const _cameraDirection = new THREE.Vector3();
const _cameraRight = new THREE.Vector3();
const _moveVector = new THREE.Vector3();
const _desiredMovement = new THREE.Vector3();
const _spawnPosition = new THREE.Vector3();

/* loop */
let prevTime = performance.now();

function update() {
    requestAnimationFrame(update);

    const time = performance.now();
    const deltaTime = (time - prevTime) / 1000;
    const clampedDeltaTime = Math.min(deltaTime, 0.1);
    prevTime = time;

    // Process input actions
    processPlayerActions(playerState, inputState, pointerLockControls.isLocked);
    processInputActions(inputState, selectedPlaceable, pointerLockControls.isLocked);

    // update player character controller
    updatePlayer(playerState, camera, inputState, pointerLockControls.isLocked, clampedDeltaTime);

    // update tool preview
    camera.getWorldDirection(_cameraDirection);
    updateTools(toolState, selectedPlaceable, playerState.position, _cameraDirection, pointerLockControls.isLocked);
    
    // Reset input action flags
    resetInputActions(inputState);

    // make agents follow player (throttled per agent)
    const playerPos: Vec3 = [playerState.position.x, playerState.position.y, playerState.position.z];
    const halfExtents: Vec3 = [1, 1, 1];
    const nearestToPlayer = findNearestPoly(
        createFindNearestPolyResult(),
        navMeshState.navMesh,
        playerPos,
        halfExtents,
        DEFAULT_QUERY_FILTER,
    );

    if (nearestToPlayer.success) {
        for (const agentId in catsCrowd.agents) {
            const timeSinceLastUpdate = time / 1000 - agentLastTargetUpdate[agentId];
            
            if (timeSinceLastUpdate >= AGENT_TARGET_UPDATE_INTERVAL) {
                crowd.requestMoveTarget(catsCrowd, agentId, nearestToPlayer.nodeRef, nearestToPlayer.position);
                agentLastTargetUpdate[agentId] = time / 1000;
            }
        }
    }

    // update crowd
    crowd.update(catsCrowd, navMeshState.navMesh, clampedDeltaTime);

    // update physics
    updatePhysics(physicsState, clampedDeltaTime);

    // update dynamic navmesh
    // console.time('updateDynamicNavMesh');
    updateDynamicNavMesh(navMeshState, scene, { maxTilesPerFrame: 1 });
    // console.timeEnd('updateDynamicNavMesh');

    // update navmesh visuals
    updateNavMeshVisuals(navMeshState, scene, performance.now());

    // update rapier debug rendering
    renderRapierDebug(physicsState);

    // update agent visuals
    const agents = Object.keys(catsCrowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = catsCrowd.agents[agentId];

        if (agentVisuals[agentId]) {
            updateAgentVisuals(agent, agentVisuals[agentId]);
        }
    }

    // render
    renderer.render(scene, camera);
}

update();
