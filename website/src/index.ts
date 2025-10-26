import { createMulberry32Generator, remapClamp, type Vec3, vec3 } from 'mathcat';
import {
    addOffMeshConnection,
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findRandomPoint,
    OffMeshConnectionDirection,
    type OffMeshConnectionParams,
} from 'navcat';
import { crowd, generateSoloNavMesh, type SoloNavMeshInput, type SoloNavMeshOptions } from 'navcat/blocks';
import { createNavMeshHelper, createNavMeshOffMeshConnectionsHelper, getPositionsAndIndices } from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Line2 } from 'three/examples/jsm/lines/webgpu/Line2.js';
import * as THREE from 'three/webgpu';
import { loadGLTF } from './load-gltf';

const random = createMulberry32Generator(42);

/* setup example scene */
const container = document.getElementById('root')!;

// scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

// camera
const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(-2, 10, 10);
camera.lookAt(0, 0, 0);

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

/* load level model */
const levelModel = await loadGLTF('/nav-test.glb');
scene.add(levelModel.scene);

/* load cat model for agents */
const catModel = await loadGLTF('/cat.gltf');
const catAnimations = catModel.animations;

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

    // Handle SkinnedMesh cloning properly
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

    // Fix skeleton references for SkinnedMesh
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

/* generate navmesh */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = getPositionsAndIndices(walkableMeshes);

const navMeshInput: SoloNavMeshInput = {
    positions,
    indices,
};

const cellSize = 0.15;
const cellHeight = 0.15;

const walkableRadiusWorld = 0.15;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 1;
const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);
const walkableSlopeAngleDegrees = 45;

const borderSize = 0;
const minRegionArea = 8;
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

const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

const offMeshConnectionsHelper = createNavMeshOffMeshConnectionsHelper(navMesh);
scene.add(offMeshConnectionsHelper.object);

type AgentVisuals = {
    catGroup: THREE.Group;
    mixer: THREE.AnimationMixer;
    idleAction: THREE.AnimationAction;
    walkAction: THREE.AnimationAction;
    runAction: THREE.AnimationAction;
    currentAnimation: 'idle' | 'walk' | 'run';
    currentRotation: number;
    targetRotation: number;
    color: number;
};

const createAgentVisuals = (position: Vec3, scene: THREE.Scene, color: number, radius: number): AgentVisuals => {
    const catGroup = cloneCatModel(color);
    catGroup.position.set(position[0], position[1], position[2]);

    const catScale = radius * 1.5;
    catGroup.scale.setScalar(catScale);
    scene.add(catGroup);

    const mixer = new THREE.AnimationMixer(catGroup);

    const idleClip = catAnimations.find((clip) => clip.name === 'Idle')!;
    const idleAction = mixer.clipAction(idleClip);
    idleAction.loop = THREE.LoopRepeat;

    const walkClip = catAnimations.find((clip) => clip.name === 'Walk')!;
    const walkAction = mixer.clipAction(walkClip);
    walkAction.loop = THREE.LoopRepeat;

    const runClip = catAnimations.find((clip) => clip.name === 'Run')!;
    const runAction = mixer.clipAction(runClip);
    runAction.loop = THREE.LoopRepeat;

    idleAction.play();

    const targetGeometry = new THREE.SphereGeometry(0.1);
    const targetMaterial = new THREE.MeshBasicMaterial({ color });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    scene.add(targetMesh);

    return {
        catGroup,
        mixer,
        idleAction,
        walkAction,
        runAction,
        currentAnimation: 'idle',
        currentRotation: 0,
        targetRotation: 0,
        color,
    };
};

const updateAgentVisuals = (_agentId: string, agent: crowd.Agent, visuals: AgentVisuals, deltaTime: number): void => {
    // Update animation mixer
    visuals.mixer.update(deltaTime);

    // Update cat model position and rotation
    visuals.catGroup.position.fromArray(agent.position);

    // Calculate velocity and determine animation
    const velocity = vec3.length(agent.velocity);
    let targetAnimation: 'idle' | 'walk' | 'run' = 'idle';

    if (velocity > 2.5) {
        targetAnimation = 'run';
    } else if (velocity > 0.4) {
        targetAnimation = 'walk';
    }

    // Handle animation transitions
    if (visuals.currentAnimation !== targetAnimation) {
        const currentAction =
            visuals.currentAnimation === 'idle'
                ? visuals.idleAction
                : visuals.currentAnimation === 'walk'
                  ? visuals.walkAction
                  : visuals.runAction;

        const targetAction =
            targetAnimation === 'idle' ? visuals.idleAction : targetAnimation === 'walk' ? visuals.walkAction : visuals.runAction;

        // Cross-fade to new animation
        currentAction.fadeOut(0.3);
        targetAction.reset().fadeIn(0.3).play();

        visuals.currentAnimation = targetAnimation;
    }

    // Rotate cat to face movement direction with lerping
    const minVelocityThreshold = 1; // minimum velocity to trigger rotation
    const rotationLerpSpeed = 5.0; // how fast to lerp towards target rotation

    if (velocity > minVelocityThreshold) {
        // Use velocity direction when moving normally
        const direction = vec3.normalize([0, 0, 0], agent.velocity);
        const targetAngle = Math.atan2(direction[0], direction[2]);
        visuals.targetRotation = targetAngle;
    } else if (agent.targetRef) {
        // Only update rotation when there's a valid target
        // When velocity is low (like during off-mesh connections), face towards target
        const targetDirection = vec3.subtract([0, 0, 0], agent.targetPosition, agent.position);
        const targetDistance = vec3.length(targetDirection);

        if (targetDistance > 0.5) {
            // Only rotate if target is far enough away
            const normalizedTarget = vec3.normalize([0, 0, 0], targetDirection);
            const targetAngle = Math.atan2(normalizedTarget[0], normalizedTarget[2]);
            visuals.targetRotation = targetAngle;
        }
    }
    // If no target and low velocity, don't update targetRotation (cat stays facing current direction)

    // Lerp current rotation towards target rotation
    let angleDiff = visuals.targetRotation - visuals.currentRotation;

    // Handle angle wrapping (shortest path)
    if (angleDiff > Math.PI) {
        angleDiff -= 2 * Math.PI;
    } else if (angleDiff < -Math.PI) {
        angleDiff += 2 * Math.PI;
    }

    // Apply lerp
    visuals.currentRotation += angleDiff * rotationLerpSpeed * deltaTime;

    // Apply rotation to cat
    visuals.catGroup.rotation.y = visuals.currentRotation;
};

/* mouse tracking for raycasting */
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lastRaycastTarget: { nodeRef: number; position: Vec3 } | null = null;
let isPointerDown = false;

// Track laser pointer movement speed
const previousMousePosition = new THREE.Vector2();
let mouseVelocity = 0;
const velocitySmoothingFactor = 0.1; // Smooth out velocity changes

// Track recent mouse velocities (only while laser is on)
const velocityHistory: Array<{ velocity: number; timestamp: number }> = [];
const velocityHistoryDuration = 2000; // 2 seconds in milliseconds

// Store latest raycast data for use in update loop
let latestIntersects: THREE.Intersection[] = [];
let latestValidTarget = false;

// Store target quaternion for laser pointer slerp
const laserPointerTargetQuaternion = new THREE.Quaternion();
const laserPointerSlerpSpeed = 30.0; // How fast to slerp towards target rotation (faster = more responsive)

// Create laser pointer visuals (will follow camera like first-person weapon)
// Made of 3 cylinders: black shaft, gray tip, and pressable button
// Oriented to point forward (along Z axis)

// Container group for the laser pointer
const laserPointer = new THREE.Group();

// 1. Main black shaft (longest part) - rotated to point forward
const shaftGeometry = new THREE.CylinderGeometry(0.08, 0.08, 0.8, 16);
const shaftMaterial = new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    metalness: 0.7,
    roughness: 0.2,
});
const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
shaft.rotation.x = Math.PI / 2; // Rotate 90 degrees to point along -Z axis (forward)
shaft.position.z = 0; // centered
laserPointer.add(shaft);

// 2. Gray tip (emits the laser) - at the front
const tipGeometry = new THREE.CylinderGeometry(0.06, 0.08, 0.15, 16);
const tipMaterial = new THREE.MeshStandardMaterial({
    color: 0x808080,
    metalness: 0.8,
    roughness: 0.2,
    emissive: 0xffffff,
    emissiveIntensity: 0.3,
});
const tip = new THREE.Mesh(tipGeometry, tipMaterial);
tip.rotation.x = Math.PI / 2; // Rotate to align with shaft
tip.position.z = -0.475; // at the front of shaft (negative Z is forward)
laserPointer.add(tip);

// 3. Button (on top, pressable) - on top of the shaft
const laserPointerButtonGeometry = new THREE.CylinderGeometry(0.035, 0.035, 0.05, 16);
const laserPointerButtonMaterial = new THREE.MeshStandardMaterial({
    color: 0xff3333,
    metalness: 0.4,
    roughness: 0.6,
    emissive: 0xff0000,
    emissiveIntensity: 0.2,
});
const laserPointerButton = new THREE.Mesh(laserPointerButtonGeometry, laserPointerButtonMaterial);

const buttonRestPositionY = 0.10;
const buttonPressedPositionY = 0.06; // Press down slightly
let buttonTargetY = buttonRestPositionY; // Current target for lerping

laserPointerButton.position.set(0, buttonRestPositionY, 0.15); // Positioned on top, slightly back from front
laserPointer.add(laserPointerButton);

// Calculate responsive position for bottom right based on camera aspect
const updateLaserPointerPosition = () => {
    const aspect = camera.aspect;
    const fov = camera.fov * (Math.PI / 180); // Convert to radians
    const distance = 2; // Distance from camera

    // Calculate visible dimensions at this distance
    const vFOV = fov;
    const height = 2 * Math.tan(vFOV / 2) * distance;
    const width = height * aspect;

    // Position in bottom right (with some padding)
    const paddingX = 0.8; // More padding from right edge (brings it in)
    const paddingY = 0.5; // More padding from bottom edge (brings it up)
    const x = (width / 2) - paddingX;
    const y = -(height / 2) + paddingY;
    const z = -distance;

    laserPointer.position.set(x, y, z);
};

// Set initial position
updateLaserPointerPosition();

// Update position on window resize
window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    updateLaserPointerPosition();
});

// No need to rotate the group - parts are already oriented correctly to point forward (-Z)

// Add laser pointer as a child of the camera so it follows
camera.add(laserPointer);
scene.add(camera); // Camera needs to be in scene for its children to render

// Create laser beam (red line using Line2 for WebGPU)
// Use a constant line from (0,0,0) to (0,0,1) and transform it
const laserBeamGeometry = new LineGeometry();
laserBeamGeometry.setPositions([0, 0, 0, 0, 0, 1]); // unit line along Z axis
const laserBeamMaterial = new THREE.Line2NodeMaterial({
    color: 0xff0000,
    linewidth: 5, // in pixels
    transparent: true,
    opacity: 0.8,
});
const laserBeam = new Line2(laserBeamGeometry, laserBeamMaterial);
laserBeam.computeLineDistances();
laserBeam.visible = false; // Start hidden
scene.add(laserBeam);

// Track pointer down/up
window.addEventListener('pointerdown', () => {
    isPointerDown = true;
    // Set button target to pressed position
    buttonTargetY = buttonPressedPositionY;
});

window.addEventListener('pointerup', () => {
    isPointerDown = false;
    // Set button target to rest position
    buttonTargetY = buttonRestPositionY;
    // Hide laser when pointer is released
    laserBeam.visible = false;
});

// Update mouse position
window.addEventListener('pointermove', (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    const newMouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );

    // Calculate mouse velocity (distance moved)
    const currentVelocity = newMouse.distanceTo(previousMousePosition);

    // Only track velocity history when laser is on
    if (isPointerDown) {
        const currentTime = performance.now();
        velocityHistory.push({ velocity: currentVelocity, timestamp: currentTime });

        // Remove old entries (older than 2 seconds)
        while (velocityHistory.length > 0 && currentTime - velocityHistory[0].timestamp > velocityHistoryDuration) {
            velocityHistory.shift();
        }
    } else {
        // Clear history when laser is off
        velocityHistory.length = 0;
    }

    // Smooth velocity with exponential moving average
    mouseVelocity = mouseVelocity * (1 - velocitySmoothingFactor) + currentVelocity * velocitySmoothingFactor;

    // Update mouse and previous position
    mouse.copy(newMouse);
    previousMousePosition.copy(newMouse);

    // Perform raycast
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(walkableMeshes, true);

    // Rotate laser pointer to point at raycast hit or mouse direction
    // Get the tip's world position (where the laser emits from)
    const tipWorldPos = new THREE.Vector3();
    tip.getWorldPosition(tipWorldPos);

    let worldDirection: THREE.Vector3;

    if (intersects.length > 0) {
        // Use actual raycast hit point
        const hitPoint = intersects[0].point;
        worldDirection = new THREE.Vector3().subVectors(hitPoint, tipWorldPos).normalize();
    } else {
        // Fallback: point in the direction of the mouse ray
        raycaster.setFromCamera(mouse, camera);
        const rayDirection = raycaster.ray.direction.clone();
        worldDirection = rayDirection.normalize();
    }

    // Convert world direction to local direction (relative to camera)
    const cameraWorldQuaternion = new THREE.Quaternion();
    camera.getWorldQuaternion(cameraWorldQuaternion);
    const localDirection = worldDirection.clone().applyQuaternion(cameraWorldQuaternion.clone().invert());

    // Create a quaternion that rotates from the default direction to the target direction
    // The laser pointer's forward direction is along -Z axis in local space
    laserPointerTargetQuaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), localDirection);

    // Note: actual rotation applied in update loop with slerp

    // Store intersects for use in update loop
    latestIntersects = intersects;

    // Check if we have a valid navmesh target
    latestValidTarget = false;

    if (intersects.length > 0) {
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

        if (nearestResult.success) {
            lastRaycastTarget = {
                nodeRef: nearestResult.nodeRef,
                position: nearestResult.position,
            };

            latestValidTarget = true;
        }
    }
});

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
        crowd.CrowdUpdateFlags.ANTICIPATE_TURNS | crowd.CrowdUpdateFlags.SEPARATION | crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE,
    queryFilter: DEFAULT_QUERY_FILTER,
    obstacleAvoidance: crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
    // we will do a custom animation for off-mesh connections
    autoTraverseOffMeshConnections: false,
};

// create agents at different positions
const agentPositions: Vec3[] = Array.from({ length: 10 }, () => {
    return findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, random).position;
});

const agentColors = [0x0000ff, 0x00ff00, 0xff0000, 0xffff00, 0xff00ff, 0x00ffff, 0xffa500, 0x800080, 0xffc0cb, 0x90ee90];

const agentVisuals: Record<string, AgentVisuals> = {};

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i % agentColors.length];

    // add agent to crowd
    const agentId = crowd.addAgent(catsCrowd, position, agentParams);
    console.log(`Creating agent ${i} at position:`, position);

    // create visuals for the agent
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, agentParams.radius);
}

/* loop */
let prevTime = performance.now();
let lastTargetUpdateTime = performance.now();
const targetUpdateInterval = 500; // 0.5 seconds in milliseconds

function update() {
    requestAnimationFrame(update);

    const time = performance.now();
    const deltaTime = (time - prevTime) / 1000;
    const clampedDeltaTime = Math.min(deltaTime, 0.1);
    prevTime = time;

    // Update all agents to move to last raycast target every 0.5 seconds
    if (time - lastTargetUpdateTime >= targetUpdateInterval) {
        if (isPointerDown && lastRaycastTarget) {
            // Laser is on - update agents to follow the target
            // Calculate average velocity from the last 2 seconds (only while laser is on)
            let avgVelocity = 0;
            if (velocityHistory.length > 0) {
                const sum = velocityHistory.reduce((acc, entry) => acc + entry.velocity, 0);
                avgVelocity = sum / velocityHistory.length;
            }

            // Map average mouse velocity to max acceleration
            // avgVelocity ranges roughly from 0 to 0.1 for normal movement
            // Remap to acceleration range: 15.0 (slow) to 50.0 (fast)
            const targetAcceleration = remapClamp(avgVelocity, 0, 0.015, 15.0, 30.0);
            const targetSpeed = remapClamp(avgVelocity, 0, 0.015, 1.5, 10.0);

            for (const agentId in catsCrowd.agents) {
                const agent = catsCrowd.agents[agentId];

                agent.params.maxAcceleration = targetAcceleration;
                agent.params.maxSpeed = targetSpeed;

                crowd.requestMoveTarget(catsCrowd, agentId, lastRaycastTarget.nodeRef, lastRaycastTarget.position);
            }
        } else {
            // Laser is off - reset agents targets
            for (const agentId in catsCrowd.agents) {
                const agent = catsCrowd.agents[agentId];

                agent.params.maxAcceleration = 15.0;
                agent.params.maxSpeed = 1.5;

                // Reset move target
                crowd.resetMoveTarget(catsCrowd, agentId);
            }
        }
        lastTargetUpdateTime = time;
    }

    // Slerp laser pointer rotation for smooth aiming
    laserPointer.quaternion.slerp(laserPointerTargetQuaternion, laserPointerSlerpSpeed * clampedDeltaTime);

    // Lerp button position for smooth animation
    const buttonLerpSpeed = 20.0; // Fast lerp
    laserPointerButton.position.y += (buttonTargetY - laserPointerButton.position.y) * buttonLerpSpeed * clampedDeltaTime;

    // Update laser beam visibility and visuals based on pointer state
    if (isPointerDown) {
        const laserTipWorld = new THREE.Vector3();
        tip.getWorldPosition(laserTipWorld);

        if (latestValidTarget && latestIntersects.length > 0) {
            // Use the actual raycast hit point
            const targetPos = latestIntersects[0].point;

            laserBeam.position.copy(laserTipWorld);
            const direction = new THREE.Vector3().subVectors(targetPos, laserTipWorld);
            const distance = direction.length();

            const quaternion = new THREE.Quaternion();
            quaternion.setFromUnitVectors(
                new THREE.Vector3(0, 0, 1),
                direction.normalize()
            );
            laserBeam.quaternion.copy(quaternion);
            laserBeam.scale.set(1, 1, distance);
            laserBeam.visible = true;
        } else {
            // No navmesh hit - show laser extending far in the direction
            const rayDirection = raycaster.ray.direction.clone().normalize();
            const targetPos = laserTipWorld.clone().add(rayDirection.multiplyScalar(1000));

            laserBeam.position.copy(laserTipWorld);
            const direction = new THREE.Vector3().subVectors(targetPos, laserTipWorld);
            const distance = direction.length();

            const quaternion = new THREE.Quaternion();
            quaternion.setFromUnitVectors(
                new THREE.Vector3(0, 0, 1),
                direction.normalize()
            );
            laserBeam.quaternion.copy(quaternion);
            laserBeam.scale.set(1, 1, distance);
            laserBeam.visible = true;
        }
    } else {
        laserBeam.visible = false;
    }

    // update crowd
    crowd.update(catsCrowd, navMesh, clampedDeltaTime);

    // handle custom off-mesh connection animations with arcs
    for (const agentId in catsCrowd.agents) {
        const agent = catsCrowd.agents[agentId];

        if (agent.state === crowd.AgentState.OFFMESH && agent.offMeshAnimation) {
            const anim = agent.offMeshAnimation;

            // progress animation time
            anim.t += clampedDeltaTime;

            // custom animation duration
            const customDuration = 0.8; // slightly longer for nice arc

            if (anim.t >= customDuration) {
                // finish the off-mesh connection
                crowd.completeOffMeshConnection(catsCrowd, agentId);
            } else {
                // animate with a parabolic arc
                const progress = anim.t / customDuration;

                // linear interpolation for x and z
                const x = anim.startPosition[0] + (anim.endPosition[0] - anim.startPosition[0]) * progress;
                const z = anim.startPosition[2] + (anim.endPosition[2] - anim.startPosition[2]) * progress;

                // parabolic arc for y (creates a jump effect)
                const startY = anim.startPosition[1];
                const endY = anim.endPosition[1];
                const arcHeight = 1.0; // height of the arc

                // parabola: y = -4h * (p - 0.5)^2 + h where h is max height above start
                const parabola = -4 * arcHeight * (progress - 0.5) ** 2 + arcHeight;
                const y = startY + (endY - startY) * progress + parabola;

                vec3.set(agent.position, x, y, z);
            }
        }
    }

    const agents = Object.keys(catsCrowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = catsCrowd.agents[agentId];
        if (agentVisuals[agentId]) {
            updateAgentVisuals(agentId, agent, agentVisuals[agentId], clampedDeltaTime);
        }
    }

    renderer.render(scene, camera);
}

update();
