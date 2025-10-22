import { GUI } from 'lil-gui';
import type { Vec3 } from 'maaths';
import { createFindNearestPolyResult, DEFAULT_QUERY_FILTER, findNearestPoly, moveAlongSurface } from 'navcat';
import * as THREE from 'three';
import { createNavMeshHelper } from './common/debug';
import { createExample } from './common/example-base';
import { generateSoloNavMesh, type SoloNavMeshInput, type SoloNavMeshOptions } from 'navcat/blocks';
import { getPositionsAndIndices } from './common/get-positions-and-indices';
import { loadGLTF } from './common/load-gltf';

/* controls */
const guiSettings = {
    showNavMeshHelper: true,
    showAgentHelper: false,
    cellSize: 0.2,
    cellHeight: 0.2,
    walkableRadius: 0.3,
    walkableSlopeAngle: 45,
    walkableClimb: 0.4,
    walkableHeight: 1.5,
    walkingSpeed: 4,
    runningSpeed: 8,
    offsetAbove: 15,
    offsetBehind: 10,
};

const gui = new GUI();
const navMeshFolder = gui.addFolder('Nav Mesh');
navMeshFolder.add(guiSettings, 'showNavMeshHelper').name('Show Helper');
navMeshFolder.add(guiSettings, 'showAgentHelper').name('Show Agent Helper');
navMeshFolder.add(guiSettings, 'cellSize', 0.05, 0.3, 0.01).name('Cell Size');
navMeshFolder.add(guiSettings, 'cellHeight', 0.05, 0.3, 0.01).name('Cell Height');
navMeshFolder.add(guiSettings, 'walkableRadius', 0.1, 1, 0.1).name('Walkable Radius');
navMeshFolder.add(guiSettings, 'walkableSlopeAngle', 0, 90, 1).name('Walkable Slope Angle');
navMeshFolder.add(guiSettings, 'walkableClimb', 0.1, 1, 0.1).name('Walkable Climb');
navMeshFolder.add(guiSettings, 'walkableHeight', 0.1, 3, 0.1).name('Walkable Height');
navMeshFolder
    .add(
        {
            generateNavMesh: () => {
                console.log('Generating navmesh...');
                generateNavMesh();
            },
        },
        'generateNavMesh',
    )
    .name('Generate NavMesh');

const playerFolder = gui.addFolder('Player Speed');
playerFolder.add(guiSettings, 'walkingSpeed', 0.1, 2, 0.1).name('Walking Speed');
playerFolder.add(guiSettings, 'runningSpeed', 0.5, 3, 0.1).name('Running Speed');

const cameraFolder = gui.addFolder('Camera');
cameraFolder.add(guiSettings, 'offsetBehind', 5, 30, 1).name('Offset Behind');
cameraFolder.add(guiSettings, 'offsetAbove', 2, 15, 1).name('Offset Above');

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

// Set up camera position
camera.position.set(5, 8, 5);
camera.lookAt(0, 0, 0);

// load level model
const levelModel = await loadGLTF('/models/game-level.glb');
scene.add(levelModel.scene);

// lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
directionalLight.position.set(5, 10, 7.5);
scene.add(directionalLight);

// character model
const characterModel = await loadGLTF('/models/character.glb');

/* player setup */
const playerGroup = new THREE.Group();
playerGroup.position.set(0, 2, 0); // Start at a reasonable height
playerGroup.rotation.y = 0; // Face forward
scene.add(playerGroup);

const characterScene = characterModel.scene;

playerGroup.add(characterScene);

const agentHelper = new THREE.Mesh(
    new THREE.CapsuleGeometry(guiSettings.walkableRadius, guiSettings.walkableHeight),
    new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true }),
);
agentHelper.position.y = 0.9;
playerGroup.add(agentHelper);

const mixer = new THREE.AnimationMixer(characterScene);

const idleClip = characterModel.animations.find((clip) => clip.name === 'Idle');
const walkClip = characterModel.animations.find((clip) => clip.name === 'Walk');
const runClip = characterModel.animations.find((clip) => clip.name === 'Run');

const animations = {
    idle: idleClip ? mixer.clipAction(idleClip) : null,
    walk: walkClip ? mixer.clipAction(walkClip) : null,
    run: runClip ? mixer.clipAction(runClip) : null,
};

if (animations.idle) {
    animations.idle.loop = THREE.LoopRepeat;
    animations.idle.weight = 1;
    animations.idle.play();
}

if (animations.walk) {
    animations.walk.loop = THREE.LoopRepeat;
    animations.walk.weight = 0;
    animations.walk.timeScale = 1.5;
    animations.walk.play();
}

if (animations.run) {
    animations.run.loop = THREE.LoopRepeat;
    animations.run.weight = 0;
    animations.run.play();
}

/* input handling */
const input = {
    forward: false,
    back: false,
    left: false,
    right: false,
    sprint: false,
};

const handleKeyDown = (event: KeyboardEvent) => {
    switch (event.code) {
        case 'ArrowUp':
        case 'KeyW':
            input.forward = true;
            break;
        case 'ArrowDown':
        case 'KeyS':
            input.back = true;
            break;
        case 'ArrowLeft':
        case 'KeyA':
            input.left = true;
            break;
        case 'ArrowRight':
        case 'KeyD':
            input.right = true;
            break;
        case 'ShiftLeft':
        case 'ShiftRight':
            input.sprint = true;
            break;
    }
};

const handleKeyUp = (event: KeyboardEvent) => {
    switch (event.code) {
        case 'ArrowUp':
        case 'KeyW':
            input.forward = false;
            break;
        case 'ArrowDown':
        case 'KeyS':
            input.back = false;
            break;
        case 'ArrowLeft':
        case 'KeyA':
            input.left = false;
            break;
        case 'ArrowRight':
        case 'KeyD':
            input.right = false;
            break;
        case 'ShiftLeft':
        case 'ShiftRight':
            input.sprint = false;
            break;
    }
};

document.addEventListener('keydown', handleKeyDown);
document.addEventListener('keyup', handleKeyUp);

/* generate navmesh */
let navMesh: any;
let navMeshHelper: any;

const generateNavMesh = () => {
    console.log('Generating navmesh with current settings...');

    // clean up existing navmesh helper if it exists
    if (navMeshHelper?.object) {
        scene.remove(navMeshHelper.object);
    }

    // update agent helper geometry with current settings
    agentHelper.geometry.dispose(); // clean up old geometry
    agentHelper.geometry = new THREE.CapsuleGeometry(guiSettings.walkableRadius, guiSettings.walkableHeight);

    const walkableMeshes: THREE.Mesh[] = [];
    levelModel.scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
            walkableMeshes.push(object);
        }
    });

    const [positions, indices] = getPositionsAndIndices(walkableMeshes);

    const navMeshInput: SoloNavMeshInput = {
        positions,
        indices,
    };

    const navMeshConfig: SoloNavMeshOptions = {
        cellSize: guiSettings.cellSize,
        cellHeight: guiSettings.cellHeight,
        walkableRadiusWorld: guiSettings.walkableRadius,
        walkableRadiusVoxels: Math.ceil(guiSettings.walkableRadius / guiSettings.cellSize),
        walkableClimbWorld: guiSettings.walkableClimb,
        walkableClimbVoxels: Math.ceil(guiSettings.walkableClimb / guiSettings.cellHeight),
        walkableHeightWorld: guiSettings.walkableHeight,
        walkableHeightVoxels: Math.ceil(guiSettings.walkableHeight / guiSettings.cellHeight),
        walkableSlopeAngleDegrees: guiSettings.walkableSlopeAngle,
        borderSize: 4,
        minRegionArea: 12,
        mergeRegionArea: 20,
        maxSimplificationError: 1.3,
        maxEdgeLength: 12,
        maxVerticesPerPoly: 6,
        detailSampleDistance: 6,
        detailSampleMaxError: 1,
    };

    const navMeshResult = generateSoloNavMesh(navMeshInput, navMeshConfig);
    navMesh = navMeshResult.navMesh;

    // create new helper and add to scene
    navMeshHelper = createNavMeshHelper(navMesh);
    navMeshHelper.object.position.y += 0.15;
    scene.add(navMeshHelper.object);

    console.log('Navmesh generated successfully!');
};

// generate initial navmesh
generateNavMesh();

/* position player on navmesh */

// find a good starting position on the navmesh
const startPosition: Vec3 = [0, 1, 0];
const nearestPolyResult = findNearestPoly(
    createFindNearestPolyResult(),
    navMesh,
    startPosition,
    [5, 5, 5], // Large search area
    DEFAULT_QUERY_FILTER,
);

if (nearestPolyResult.success) {
    playerGroup.position.fromArray(nearestPolyResult.point);
    console.log('Positioned player at:', nearestPolyResult.point);
} else {
    console.warn('Could not find starting position on navmesh');
}

/* movement and animation state */
const movement = {
    vector: new THREE.Vector3(),
    sprinting: false,
};

let firstPositionUpdate = true;

const movementTarget = new THREE.Vector3();
const raycasterOrigin = new THREE.Vector3();
const raycasterDirection = new THREE.Vector3();
const playerEuler = new THREE.Euler();
const playerQuaternion = new THREE.Quaternion();
const cameraPosition = new THREE.Vector3();
const cameraLookAt = new THREE.Vector3();
const cameraOffset = new THREE.Vector3();
const cameraPositionTarget = new THREE.Vector3();

// raycaster for height correction
const raycaster = new THREE.Raycaster();
raycaster.near = 0.01;
raycaster.far = 10;

// initialize camera position
cameraPosition.copy(camera.position);

/* movement update function */
const movementUpdate = (delta: number) => {
    const { left, right, forward, back, sprint } = input;

    // calculate movement vector
    movement.vector.set(0, 0, 0);

    if (forward || back) {
        if (forward) movement.vector.z -= 1;
        if (back) movement.vector.z += 1;
    }

    if (left || right) {
        if (left) movement.vector.x -= 1;
        if (right) movement.vector.x += 1;
    }

    const movementScalar = sprint ? guiSettings.runningSpeed : guiSettings.walkingSpeed;

    movement.vector.normalize().multiplyScalar(movementScalar * delta);

    // move along navmesh surface
    if (movement.vector.length() > 0 || firstPositionUpdate) {
        movementTarget.copy(playerGroup.position).add(movement.vector);

        const halfExtents: Vec3 = [1, 1, 1];
        const nearestResult = findNearestPoly(
            createFindNearestPolyResult(),
            navMesh,
            [playerGroup.position.x, playerGroup.position.y, playerGroup.position.z],
            halfExtents,
            DEFAULT_QUERY_FILTER,
        );

        if (nearestResult.success) {
            const moveResult = moveAlongSurface(
                navMesh,
                nearestResult.ref,
                [playerGroup.position.x, playerGroup.position.y, playerGroup.position.z],
                [movementTarget.x, movementTarget.y, movementTarget.z],
                DEFAULT_QUERY_FILTER,
            );

            if (moveResult.success && moveResult.resultPosition) {
                playerGroup.position.fromArray(moveResult.resultPosition);
            }
        }

        firstPositionUpdate = false;
    }

    movement.sprinting = sprint;
};

/* animation update function */
const animationUpdate = (delta: number) => {
    const t = 1.0 - 0.01 ** delta;

    // update rotation
    if (movement.vector.length() > 0) {
        const rotation = Math.atan2(movement.vector.x, movement.vector.z);
        const targetQuaternion = playerQuaternion.setFromEuler(playerEuler.set(0, rotation, 0));
        playerGroup.quaternion.slerp(targetQuaternion, t * 5);
    }

    const speed = movement.vector.length();

    // update animation weights
    let idleWeight: number;
    let walkWeight: number;
    let runWeight: number;

    if (speed < 0.01) {
        idleWeight = 1;
        walkWeight = 0;
        runWeight = 0;
    } else if (movement.sprinting) {
        idleWeight = 0;
        walkWeight = 0;
        runWeight = 1;
    } else {
        idleWeight = 0;
        walkWeight = 1;
        runWeight = 0;
    }

    // apply the weights directly with lerping for smooth transitions
    if (animations.idle) {
        animations.idle.weight = THREE.MathUtils.lerp(animations.idle.weight, idleWeight, t * 5);
    }
    if (animations.walk) {
        animations.walk.weight = THREE.MathUtils.lerp(animations.walk.weight, walkWeight, t * 5);
    }
    if (animations.run) {
        animations.run.weight = THREE.MathUtils.lerp(animations.run.weight, runWeight, t * 5);
    }

    // raycast to correct character height
    const characterRayOrigin = raycasterOrigin.copy(playerGroup.position);
    characterRayOrigin.y += 1;

    const characterRayDirection = raycasterDirection.set(0, -1, 0);
    raycaster.set(characterRayOrigin, characterRayDirection);

    const walkableMeshes: THREE.Object3D[] = [];
    levelModel.scene.traverse((object: THREE.Object3D) => {
        if (object instanceof THREE.Mesh && object.userData.walkable) {
            walkableMeshes.push(object);
        }
    });

    const characterRayHits = raycaster.intersectObjects(walkableMeshes, false);
    const characterRayHit = characterRayHits
        .filter((hit) => hit.object.userData.walkable)
        .sort((a, b) => a.distance - b.distance)[0];

    const characterRayHitPoint = characterRayHit ? characterRayHit.point : undefined;

    if (characterRayHitPoint) {
        const yDifference = Math.abs(characterRayHitPoint.y - playerGroup.position.y);
        if (yDifference < 1) {
            playerGroup.position.y = characterRayHitPoint.y;
        }
    }
};

/* camera update function */
const cameraUpdate = (delta: number) => {
    const cameraOffsetVector = cameraOffset.set(0, guiSettings.offsetAbove, guiSettings.offsetBehind);
    const cameraPositionTargetVector = cameraPositionTarget.copy(playerGroup.position).add(cameraOffsetVector);

    const t = 1.0 - 0.01 ** delta;

    cameraPosition.lerp(cameraPositionTargetVector, t / 1.1);
    camera.position.copy(cameraPosition);

    const lookAt = cameraLookAt.copy(cameraPosition).sub(cameraOffsetVector);
    camera.lookAt(lookAt);
};

/* main update loop */
let prevTime = performance.now();

function update() {
    requestAnimationFrame(update);

    const time = performance.now();
    const deltaTime = (time - prevTime) / 1000;
    const clampedDeltaTime = Math.min(deltaTime, 0.1);
    prevTime = time;

    // update movement, animation, and camera
    movementUpdate(clampedDeltaTime);
    animationUpdate(clampedDeltaTime);
    cameraUpdate(clampedDeltaTime);

    // update animation mixer
    mixer.update(clampedDeltaTime);

    // update navmesh helper visibility
    navMeshHelper.object.visible = guiSettings.showNavMeshHelper;

    // update agent helper visibility
    agentHelper.visible = guiSettings.showAgentHelper;

    renderer.render(scene, camera);
}

update();
