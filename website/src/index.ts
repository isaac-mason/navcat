import { createMulberry32Generator, type Vec3, vec3 } from 'mathcat';
import {
    addOffMeshConnection,
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findRandomPoint,
    findRandomPointAroundCircle,
    OffMeshConnectionDirection,
    type OffMeshConnectionParams,
} from 'navcat';
import { crowd, generateSoloNavMesh, type SoloNavMeshInput, type SoloNavMeshOptions } from 'navcat/blocks';
import { createNavMeshHelper, createNavMeshOffMeshConnectionsHelper, getPositionsAndIndices } from 'navcat/three';
import * as THREE from 'three';
import { Line2, LineGeometry, LineMaterial } from 'three/examples/jsm/Addons.js';
import { loadGLTF } from './load-gltf';

const random = createMulberry32Generator(42);

/* setup example scene */
const container = document.getElementById('root')!;

// scene
const scene = new THREE.Scene();
scene.background = new THREE.Color('#222222');

// camera
const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(-5, 4, 10);
camera.lookAt(-2, 0, 0);

// renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

container.appendChild(renderer.domElement);

// lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
directionalLight.position.set(-5, 10, 2);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 30;
directionalLight.shadow.camera.left = -30;
directionalLight.shadow.camera.right = 30;
directionalLight.shadow.camera.top = 10;
directionalLight.shadow.camera.bottom = -10;
directionalLight.shadow.bias = -0.001;
scene.add(directionalLight);

// resize handling
function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}
window.addEventListener('resize', onWindowResize);

/* load models in parallel */
const [levelModel, catModel, laserPointerModel] = await Promise.all([
    loadGLTF('/office.glb'),
    loadGLTF('/car.glb'),
    loadGLTF('/laserpointer.glb'),
]);

/* setup level */
const tapeMeshes: THREE.Mesh[] = [];

levelModel.scene.traverse((child) => {
    if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        if (child.userData.tape) {
            tapeMeshes.push(child);
        }
    }
});

scene.add(levelModel.scene);

const catAnimations = catModel.animations;

/* hide loading spinner */
const loadingElement = document.getElementById('loading');
if (loadingElement) {
    loadingElement.classList.add('hidden');
    setTimeout(() => {
        loadingElement.style.display = 'none';
    }, 500); // Wait for fade transition to complete
}

const cloneCatModel = (): THREE.Group => {
    const clone = catModel.scene.clone(true);

    const skinnedMeshes: THREE.SkinnedMesh[] = [];

    clone.traverse((child) => {
        if (child instanceof THREE.SkinnedMesh) {
            skinnedMeshes.push(child);

            child.castShadow = true;
            child.receiveShadow = true;
            console.log(child.geometry.attributes)
        }
    });

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

const cellSize = 0.1;
const cellHeight = 0.2;

const walkableRadiusWorld = 0.1;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.4;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 0.5;
const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);
const walkableSlopeAngleDegrees = 45;

const borderSize = 0;
const minRegionArea = 8;
const mergeRegionArea = 20;

const maxSimplificationError = 1.5;
const maxEdgeLength = 20;

const maxVerticesPerPoly = 6;

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
        start: [-2.6, 0, 6],
        end: [-2, 1.6, 4.5],
        direction: OffMeshConnectionDirection.BIDIRECTIONAL,
        radius: 0.2,
        flags: 0xffffff,
        area: 0,
    },
    {
        start: [-3.658154298168996, 0, 3.795235885826708],
        end: [-5.640291081405719, 1, 2.7],
        direction: OffMeshConnectionDirection.BIDIRECTIONAL,
        radius: 0.2,
        flags: 0xffffff,
        area: 0,
    },
    {
        start: [1.2, 0, -1.2],
        end: [2, 1, 1.3],
        direction: OffMeshConnectionDirection.BIDIRECTIONAL,
        radius: 0.2,
        flags: 0xffffff,
        area: 0,
    },
];

for (const offMeshConnection of offMeshConnections) {
    addOffMeshConnection(navMesh, offMeshConnection);
}

const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
navMeshHelper.object.visible = false; // Start hidden
scene.add(navMeshHelper.object);

const offMeshConnectionsHelper = createNavMeshOffMeshConnectionsHelper(navMesh);
offMeshConnectionsHelper.object.visible = false; // Start hidden
scene.add(offMeshConnectionsHelper.object);

/* cat state machine */
enum CatState {
    WANDERING = 'wandering',
    ALERTED = 'alerted',
    CHASING = 'chasing',
    SEARCHING = 'searching',
    SPINNING = 'spinning',
}

type CatStateData = {
    state: CatState;
    stateStartTime: number;
    chasingTextureIndex?: number;
};

const CAT_SPEEDS = {
    WANDERING: 1.5,
    ALERTED: 2.0,
    CHASING: 5.0,
    SEARCHING: 1.0,
};

const CAT_ACCELERATION = {
    WANDERING: 5.0,
    ALERTED: 8.0,
    CHASING: 30.0,
    SEARCHING: 0.0,
};

const createTextTexture = (text: string, fontSize: number = 64): THREE.CanvasTexture => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;

    canvas.width = 256;
    canvas.height = 256;

    context.font = `bold ${fontSize}px Arial`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    context.strokeStyle = 'black';
    context.lineWidth = 8;
    context.strokeText(text, 128, 128);

    context.fillStyle = 'white';
    context.fillText(text, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    return texture;
};

// create all emotion textures
const emotionTextures = {
    question1: createTextTexture('?', 30),
    question2: createTextTexture('??', 50),
    question3: createTextTexture('???', 64),
    exclamation: createTextTexture('!!!', 64),
    sad: createTextTexture(':(', 64),
    chasing1: createTextTexture('>w<', 64),
    chasing2: createTextTexture(':3', 64),
    chasing3: createTextTexture('owo', 64),
    chasing4: createTextTexture('^_^', 64),
    chasing5: createTextTexture('>:3', 64),
    spinning1: createTextTexture('ooo', 64),
    spinning2: createTextTexture('eee', 64),
    spinning3: createTextTexture('aaa', 64),
};

const chasingTextures = [
    emotionTextures.chasing1,
    emotionTextures.chasing2,
    emotionTextures.chasing3,
    emotionTextures.chasing4,
    emotionTextures.chasing5,
];

const spinningTextures = [emotionTextures.spinning1, emotionTextures.spinning2, emotionTextures.spinning3];

type AgentVisuals = {
    catGroup: THREE.Group;
    mixer: THREE.AnimationMixer;
    idleAction: THREE.AnimationAction;
    walkAction: THREE.AnimationAction;
    currentAnimation: 'idle' | 'walk';
    currentRotation: number;
    targetRotation: number;
    emotionSprite: THREE.Sprite;
    currentVisualY: number;
    spinEndTime: number;
    idleWeight: number;
    walkWeight: number;
    walkTimeScale: number;
    spinStartTimeForSpawn: number | null; // null = not spinning
};

const createAgentVisuals = (position: Vec3, scene: THREE.Scene, radius: number): AgentVisuals => {
    const catGroup = cloneCatModel();
    catGroup.position.set(position[0], position[1], position[2]);

    const catScale = radius * 0.5;
    catGroup.scale.setScalar(catScale);
    scene.add(catGroup);

    const mixer = new THREE.AnimationMixer(catGroup);

    const idleClip = catAnimations.find((clip) => clip.name === 'Idle')!;
    const idleAction = mixer.clipAction(idleClip);
    idleAction.loop = THREE.LoopRepeat;
    idleAction.setEffectiveTimeScale(2);
    idleAction.setEffectiveWeight(1); // Start with idle at full weight
    idleAction.play();

    const walkClip = catAnimations.find((clip) => clip.name === 'Walk')!;
    const walkAction = mixer.clipAction(walkClip);
    walkAction.loop = THREE.LoopRepeat;
    walkAction.setEffectiveTimeScale(2);
    walkAction.setEffectiveWeight(0); // Start at 0 weight
    walkAction.play();

    // create emotion sprite (initially hidden)
    const spriteMaterial = new THREE.SpriteMaterial({
        map: emotionTextures.question1,
        alphaTest: 0.5,
    });
    const emotionSprite = new THREE.Sprite(spriteMaterial);
    emotionSprite.scale.setScalar(2);
    emotionSprite.position.y = 5; // position above cat
    catGroup.add(emotionSprite); // parent to cat so it follows

    return {
        catGroup,
        mixer,
        idleAction,
        walkAction,
        currentAnimation: 'idle',
        currentRotation: 0,
        targetRotation: 0,
        emotionSprite,
        currentVisualY: position[1],
        spinEndTime: 0,
        idleWeight: 1,
        walkWeight: 0,
        walkTimeScale: 2,
        spinStartTimeForSpawn: null,
    };
};

const groundRaycaster = new THREE.Raycaster();
const groundRayOrigin = new THREE.Vector3();
const groundRayDirection = new THREE.Vector3(0, -1, 0);

const updateAgentVisuals = (_agentId: string, agent: crowd.Agent, visuals: AgentVisuals, deltaTime: number): void => {
    visuals.catGroup.position.fromArray(agent.position);

    // height adjustment via raycast
    if (!agent.offMeshAnimation) {
        groundRayOrigin.set(agent.position[0], agent.position[1] + 0.1, agent.position[2]);
        groundRaycaster.set(groundRayOrigin, groundRayDirection);
        const groundIntersects = groundRaycaster.intersectObjects(walkableMeshes, true);

        if (groundIntersects.length > 0) {
            const rayHitY = groundIntersects[0].point.y;

            // if difference not too great, lerp to it
            if (Math.abs(rayHitY - agent.position[1]) < 1) {
                // lerp speed - higher = faster adjustment
                const heightLerpSpeed = 8.0;
                visuals.currentVisualY += (rayHitY - visuals.currentVisualY) * heightLerpSpeed * deltaTime;
                visuals.catGroup.position.y = visuals.currentVisualY;
            } else {
                // large height difference - snap immediately and update current Y
                visuals.currentVisualY = agent.position[1];
            }
        }
    } else {
        // during off-mesh animations, keep visual Y in sync
        visuals.currentVisualY = visuals.catGroup.position.y;
    }

    // calculate velocity and determine target animation weights
    const velocity = vec3.length(agent.velocity);

    // set target weights and walk speed based on velocity
    let targetIdleWeight = 0;
    let targetWalkWeight = 0;
    let targetWalkTimeScale = 2;

    if (velocity > 2.5) {
        // running - use walk animation at double speed
        targetWalkWeight = 1;
        targetWalkTimeScale = 4;
    } else if (velocity > 0.4) {
        // walking - use walk animation at normal speed
        targetWalkWeight = 1;
        targetWalkTimeScale = 2;
    } else {
        // idle
        targetIdleWeight = 1;
        targetWalkTimeScale = 2;
    }

    // lerp animation weights towards target weights for smooth transitions
    const weightLerpSpeed = 5.0; // higher = faster transitions
    visuals.idleWeight += (targetIdleWeight - visuals.idleWeight) * weightLerpSpeed * deltaTime;
    visuals.walkWeight += (targetWalkWeight - visuals.walkWeight) * weightLerpSpeed * deltaTime;
    visuals.walkTimeScale += (targetWalkTimeScale - visuals.walkTimeScale) * weightLerpSpeed * deltaTime;

    // apply weights to animation actions
    visuals.idleAction.setEffectiveWeight(visuals.idleWeight);
    visuals.walkAction.setEffectiveWeight(visuals.walkWeight);
    visuals.walkAction.setEffectiveTimeScale(visuals.walkTimeScale);

    // update currentAnimation for reference (based on highest weight)
    if (visuals.walkWeight > visuals.idleWeight) {
        visuals.currentAnimation = 'walk';
    } else {
        visuals.currentAnimation = 'idle';
    }

    // check if laser is directly hitting this cat
    if (laserHitAgentIds.has(_agentId)) {
        // laser is hitting the cat - start spinning for 1 second
        const currentTime = performance.now() / 1000; // Convert to seconds
        visuals.spinEndTime = currentTime + 1.0; // Spin for 1 second
    }

    // check if cat should be spinning
    const currentTime = performance.now() / 1000;
    const isSpinning = currentTime < visuals.spinEndTime;

    if (isSpinning) {
        // spin quickly - no lerping, just direct rotation
        const spinSpeed = 15.0; // radians per second
        visuals.currentRotation += spinSpeed * deltaTime;

        // normalize currentRotation to [-PI, PI] to prevent it from growing unbounded
        while (visuals.currentRotation > Math.PI) {
            visuals.currentRotation -= 2 * Math.PI;
        }
        while (visuals.currentRotation < -Math.PI) {
            visuals.currentRotation += 2 * Math.PI;
        }

        // keep targetRotation synced so when we stop spinning, we start lerping from current position
        visuals.targetRotation = visuals.currentRotation;
    } else {
        // rotate cat to face movement direction with lerping
        const minVelocityThreshold = 1; // minimum velocity to trigger rotation
        const rotationLerpSpeed = 5.0; // how fast to lerp towards target rotation

        if (velocity > minVelocityThreshold) {
            const direction = vec3.normalize([0, 0, 0], agent.velocity);
            const targetAngle = Math.atan2(direction[0], direction[2]);
            visuals.targetRotation = targetAngle;
        } else if (agent.targetRef) {
            const targetDirection = vec3.subtract([0, 0, 0], agent.targetPosition, agent.position);
            const targetDistance = vec3.length(targetDirection);

            if (targetDistance > 0.5) {
                const normalizedTarget = vec3.normalize([0, 0, 0], targetDirection);
                const targetAngle = Math.atan2(normalizedTarget[0], normalizedTarget[2]);
                visuals.targetRotation = targetAngle;
            }
        }

        let angleDiff = visuals.targetRotation - visuals.currentRotation;

        if (angleDiff > Math.PI) {
            angleDiff -= 2 * Math.PI;
        } else if (angleDiff < -Math.PI) {
            angleDiff += 2 * Math.PI;
        }

        visuals.currentRotation += angleDiff * rotationLerpSpeed * deltaTime;
    }

    visuals.catGroup.rotation.y = visuals.currentRotation;

    // update mixer
    visuals.mixer.update(deltaTime);
};

const updateEmotionSprite = (visuals: AgentVisuals, catState: CatStateData, time: number): void => {
    const sprite = visuals.emotionSprite;
    const material = sprite.material as THREE.SpriteMaterial;

    const elapsed = time - catState.stateStartTime;
    
    let newTexture: THREE.CanvasTexture | null = null;

    switch (catState.state) {
        case CatState.ALERTED:
            // discrete steps: 0-0.33s = ?, 0.33-0.66s = ??, 0.66-1s = ???
            if (elapsed < 333) {
                newTexture = emotionTextures.question1;
            } else if (elapsed < 666) {
                newTexture = emotionTextures.question2;
            } else {
                newTexture = emotionTextures.question3;
            }
            sprite.visible = true;
            break;

        case CatState.CHASING:
            // show ! for first 1 second, then keep showing random chasing emojis
            if (elapsed < 1000) {
                newTexture = emotionTextures.exclamation;
                sprite.visible = true;
            } else {
                // show the selected chasing emoji (changes every 2 seconds in state machine)
                const textureIndex = catState.chasingTextureIndex ?? 0;
                newTexture = chasingTextures[textureIndex];
                sprite.visible = true;
            }
            break;

        case CatState.SEARCHING:
            // show :( for 1 second
            if (elapsed < 1000) {
                newTexture = emotionTextures.sad;
                sprite.visible = true;
            } else {
                sprite.visible = false;
            }
            break;

        case CatState.SPINNING: {
            // cycle through spinning emotion sprites quickly
            const cycleSpeed = 5.0; // cycles per second
            const textureIndex = Math.floor((time / 1000) * cycleSpeed) % spinningTextures.length;
            newTexture = spinningTextures[textureIndex];
            sprite.visible = true;
            break;
        }

        case CatState.WANDERING:
            sprite.visible = false;
            break;
    }

    // only update texture if it changed (important for Safari)
    if (newTexture && material.map !== newTexture) {
        material.map = newTexture;
        material.needsUpdate = true;
    }
};

/* interaction */
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lastRaycastTarget: { nodeRef: number; position: Vec3 } | null = null;
let isPointerDown = false;

let latestIntersects: THREE.Intersection[] = [];
let latestValidTarget = false;

const laserHitAgentIds = new Set<string>();

const mouseScreenPos = new THREE.Vector2(0, 0); // normalized -1 to 1, center is 0,0
const baseCameraPosition = new THREE.Vector3();
const baseCameraLookAt = new THREE.Vector3();
baseCameraPosition.copy(camera.position);
baseCameraLookAt.set(0, 0, 0);

const laserPointerTargetQuaternion = new THREE.Quaternion();
const laserPointerSlerpSpeed = 30.0;

const _tempWorldPosition = new THREE.Vector3();
const _tempDirection = new THREE.Vector3();
const _tempLocalDirection = new THREE.Vector3();
const _tempQuaternion = new THREE.Quaternion();

const laserPointer = laserPointerModel.scene.clone();
const laserPointerButton = laserPointer.getObjectByName('Button002')!;
const laserPointerTip = laserPointer.getObjectByName('Top001')!;
const laserPointerButtonRestPosition = new THREE.Vector3();
laserPointerButtonRestPosition.copy(laserPointerButton.position);
const laserPointerButtonPressOffset = 10; // how much to press down (in local Y)
let laserPointerButtonTargetOffset = 0; // current target offset for lerping

const updateLaserPointerPosition = () => {
    const aspect = camera.aspect;
    const fov = camera.fov * (Math.PI / 180); // convert to radians
    const distance = 2; // distance from camera

    // calculate visible dimensions at this distance
    const vFOV = fov;
    const height = 2 * Math.tan(vFOV / 2) * distance;
    const width = height * aspect;

    // check if mobile screen (using viewport width as indicator)
    const isMobile = window.innerWidth <= 768;

    // position in bottom right (with some padding)
    // on mobile, adjust position to be less obtrusive and scale down
    const paddingX = isMobile ? 0.5 : 0.8; // less padding on mobile to keep it visible
    const paddingY = isMobile ? 0.3 : 0.5; // less padding on mobile
    const x = width / 2 - paddingX;
    const y = -(height / 2) + paddingY;
    const z = -distance;

    laserPointer.position.set(x, y, z);

    // scale down on mobile devices
    const scale = isMobile ? 0.7 : 1.0;
    laserPointer.scale.setScalar(scale);
};

updateLaserPointerPosition();

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    updateLaserPointerPosition();
});

camera.add(laserPointer);
scene.add(camera);

const laserBeamGeometry = new LineGeometry();
laserBeamGeometry.setPositions([0, 0, 0, 0, 0, 1]);
const laserBeamMaterial = new LineMaterial({
    color: 0xff0000,
    linewidth: 4,
});
const laserBeam = new Line2(laserBeamGeometry, laserBeamMaterial);
laserBeam.computeLineDistances();
laserBeam.visible = false;
scene.add(laserBeam);

const updateMousePositionAndRaycast = (clientX: number, clientY: number) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    // store mouse screen position for camera rotation
    mouseScreenPos.set(mouse.x, mouse.y);

    // first raycast from camera to find where the cursor is pointing in world space
    raycaster.setFromCamera(mouse, camera);
    const cameraIntersects = raycaster.intersectObjects(walkableMeshes, true);

    // get the tip position in world space
    laserPointerTip.getWorldPosition(_tempWorldPosition);

    // calculate target direction from tip to the camera raycast hit point
    // this will be used to set the target quaternion for smooth rotation
    if (cameraIntersects.length > 0) {
        _tempDirection.subVectors(cameraIntersects[0].point, _tempWorldPosition).normalize();
    } else {
        // if no hit, use a far point along the camera ray
        const farPoint = raycaster.ray.origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(1000));
        _tempDirection.subVectors(farPoint, _tempWorldPosition).normalize();
    }

    // convert target direction to local space (relative to camera) for laser pointer rotation
    camera.getWorldQuaternion(_tempQuaternion);
    _tempLocalDirection.copy(_tempDirection).applyQuaternion(_tempQuaternion.invert());

    // create target quaternion for the laser pointer to smoothly rotate towards
    // the laser pointer's forward direction is along -Z axis in local space
    const defaultForward = new THREE.Vector3(0, 0, -1);
    laserPointerTargetQuaternion.setFromUnitVectors(defaultForward, _tempLocalDirection);

    // note: actual rotation, raycast, and line updates happen in the update loop
    // so everything stays in sync with the slerped rotation
};

window.addEventListener('pointerdown', () => {
    isPointerDown = true;
    laserPointerButtonTargetOffset = laserPointerButtonPressOffset;
});

window.addEventListener('pointerup', () => {
    isPointerDown = false;
    laserPointerButtonTargetOffset = 0;
    laserBeam.visible = false;
});

window.addEventListener('pointermove', (event) => {
    updateMousePositionAndRaycast(event.clientX, event.clientY);
});

window.addEventListener(
    'touchstart',
    (event) => {
        isPointerDown = true;
        laserPointerButtonTargetOffset = laserPointerButtonPressOffset;

        if (event.touches.length > 0) {
            const touch = event.touches[0];
            updateMousePositionAndRaycast(touch.clientX, touch.clientY);
        }
    },
    { passive: false },
);

window.addEventListener(
    'touchmove',
    (event) => {
        if (event.touches.length > 0) {
            const touch = event.touches[0];
            updateMousePositionAndRaycast(touch.clientX, touch.clientY);
        }
    },
    { passive: false },
);

window.addEventListener(
    'touchend',
    () => {
        isPointerDown = false;
        laserPointerButtonTargetOffset = 0;
        laserBeam.visible = false;
    },
    { passive: false },
);

const toggleNavMeshButton = document.getElementById('navmesh-toggle')!;

const toggleNavMesh = () => {
    const isVisible = !navMeshHelper.object.visible;
    navMeshHelper.object.visible = isVisible;
    offMeshConnectionsHelper.object.visible = isVisible;

    toggleNavMeshButton.textContent = isVisible ? 'Hide NavMesh [H]' : 'Show NavMesh [H]';
};

window.addEventListener('keydown', (event) => {
    if (event.key === 'h' || event.key === 'H') {
        toggleNavMesh();
    }
});

toggleNavMeshButton.addEventListener('click', toggleNavMesh);

/* create crowd and agents */
const catsCrowd = crowd.create(1);

catsCrowd.quickSearchIterations = 20;
catsCrowd.maxIterationsPerAgent = 1000;
catsCrowd.maxIterationsPerUpdate = 30000;
CAT_SPEEDS

const agentParams: crowd.AgentParams = {
    radius: 0.3,
    height: 0.6,
    maxAcceleration: CAT_ACCELERATION.WANDERING,
    maxSpeed: CAT_SPEEDS.WANDERING,
    collisionQueryRange: 2,
    separationWeight: 0.5,
    updateFlags:
        crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
        crowd.CrowdUpdateFlags.SEPARATION |
        crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
        crowd.CrowdUpdateFlags.OPTIMIZE_TOPO |
        crowd.CrowdUpdateFlags.OPTIMIZE_VIS,
    queryFilter: DEFAULT_QUERY_FILTER,
    obstacleAvoidance: crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
    // we will do a custom animation for off-mesh connections
    autoTraverseOffMeshConnections: false,
};

// create agents at different positions
const agentPositions: Vec3[] = Array.from({ length: 15 }, () => {
    return findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, random).position;
});

const agentVisuals: Record<string, AgentVisuals> = {};

// track next wander time for each agent (when laser is off)
const agentNextWanderTime: Record<string, number> = {};

// track cat state for each agent
const agentCatState: Record<string, CatStateData> = {};

// track next update time for each agent (for staggered updates)
const agentNextUpdateTime: Record<string, number> = {};

// helper function to spawn a new cat at a position
const spawnCat = (position: Vec3): string => {
    const agentId = crowd.addAgent(catsCrowd, navMesh, position, { ...agentParams });
    agentVisuals[agentId] = createAgentVisuals(position, scene, agentParams.radius);
    agentNextWanderTime[agentId] = performance.now() + 1500 + Math.random() * 1500;
    agentCatState[agentId] = {
        state: CatState.WANDERING,
        stateStartTime: performance.now(),
    };
    agentNextUpdateTime[agentId] = performance.now() + Math.random() * 500;
    return agentId;
};

// spawn initial cats
for (let i = 0; i < agentPositions.length; i++) {
    spawnCat(agentPositions[i]);
}

/* loop */
let prevTime = performance.now();
const targetUpdateInterval = 500; // 0.5 seconds in milliseconds

function update() {
    requestAnimationFrame(update);

    const time = performance.now();
    const deltaTime = (time - prevTime) / 1000;
    const clampedDeltaTime = Math.min(deltaTime, 0.1);

    prevTime = time;

    // update cat state machine and behavior - staggered per agent
    for (const agentId in catsCrowd.agents) {
        // check if it's time for this agent to update
        if (time < agentNextUpdateTime[agentId]) {
            continue;
        }

        // schedule next update for this agent (random 0.3-0.6s)
        agentNextUpdateTime[agentId] = time + 300 + Math.random() * 300;

        const agent = catsCrowd.agents[agentId];
        const catState = agentCatState[agentId];
        const elapsed = time - catState.stateStartTime;
        const visuals = agentVisuals[agentId];

        // check if cat should be spinning (takes priority over other states)
        const currentTime = performance.now() / 1000;
        const isSpinning = currentTime < visuals.spinEndTime;

        if (isSpinning && catState.state !== CatState.SPINNING) {
            // transition to SPINNING
            catState.state = CatState.SPINNING;
            catState.stateStartTime = time;
        } else if (!isSpinning && catState.state === CatState.SPINNING) {
            // spinning ended - go back to WANDERING
            catState.state = CatState.WANDERING;
            catState.stateStartTime = time;
        }

        // state machine transitions
        switch (catState.state) {
            case CatState.WANDERING:
                if (isPointerDown && lastRaycastTarget) {
                    // transition to ALERTED whenever laser is on
                    catState.state = CatState.ALERTED;
                    catState.stateStartTime = time;
                }
                break;

            case CatState.ALERTED:
                if (!isPointerDown || !lastRaycastTarget) {
                    // laser turned off -> go to SEARCHING
                    catState.state = CatState.SEARCHING;
                    catState.stateStartTime = time;
                } else if (elapsed >= 1000) {
                    // 1 second passed -> go to CHASING
                    catState.state = CatState.CHASING;
                    catState.stateStartTime = time;
                    // randomly select a chasing emoji
                    catState.chasingTextureIndex = Math.floor(Math.random() * chasingTextures.length);
                }
                break;

            case CatState.CHASING:
                if (!isPointerDown || !lastRaycastTarget) {
                    // laser turned off -> go to SEARCHING
                    catState.state = CatState.SEARCHING;
                    catState.stateStartTime = time;
                }
                break;

            case CatState.SEARCHING:
                if (isPointerDown && lastRaycastTarget) {
                    // laser back on -> go straight to CHASING
                    catState.state = CatState.CHASING;
                    catState.stateStartTime = time;
                    // randomly select a chasing emoji
                    catState.chasingTextureIndex = Math.floor(Math.random() * chasingTextures.length);
                } else if (elapsed >= 1000) {
                    // 1 second passed -> go back to WANDERING
                    catState.state = CatState.WANDERING;
                    catState.stateStartTime = time;
                }
                break;
        }

        // update agent speed/acceleration based on state
        switch (catState.state) {
            case CatState.WANDERING:
                agent.maxSpeed = CAT_SPEEDS.WANDERING;
                agent.maxAcceleration = CAT_ACCELERATION.WANDERING;
                break;

            case CatState.ALERTED:
                agent.maxSpeed = CAT_SPEEDS.ALERTED;
                agent.maxAcceleration = CAT_ACCELERATION.ALERTED;
                if (lastRaycastTarget) {
                    crowd.requestMoveTarget(catsCrowd, agentId, lastRaycastTarget.nodeRef, lastRaycastTarget.position);
                }
                break;

            case CatState.CHASING:
                agent.maxSpeed = CAT_SPEEDS.CHASING;
                agent.maxAcceleration = CAT_ACCELERATION.CHASING;
                if (lastRaycastTarget) {
                    crowd.requestMoveTarget(catsCrowd, agentId, lastRaycastTarget.nodeRef, lastRaycastTarget.position);
                }
                // pick a new random chasing emoji every 2 seconds (after the initial ! at 1s)
                if (
                    elapsed >= 1000 &&
                    Math.floor((elapsed - 1000) / 2000) !== Math.floor((elapsed - 1000 - targetUpdateInterval) / 2000)
                ) {
                    catState.chasingTextureIndex = Math.floor(Math.random() * chasingTextures.length);
                }
                break;

            case CatState.SEARCHING:
                agent.maxSpeed = CAT_SPEEDS.SEARCHING;
                agent.maxAcceleration = CAT_ACCELERATION.SEARCHING;
                // stay still - don't update target
                break;

            case CatState.SPINNING:
                // keep moving with current velocity while spinning
                agent.maxSpeed = CAT_SPEEDS.CHASING;
                agent.maxAcceleration = CAT_ACCELERATION.CHASING;
                // use requestMoveVelocity to continue moving in current direction
                crowd.requestMoveVelocity(catsCrowd, agentId, agent.velocity);
                break;
        }
    }

    // Wander logic - only for cats in WANDERING state
    for (const agentId in catsCrowd.agents) {
        const catState = agentCatState[agentId];

        if (catState.state === CatState.WANDERING && time >= agentNextWanderTime[agentId]) {
            const agent = catsCrowd.agents[agentId];

            // find the nearest poly to the agent's current position
            const halfExtents: Vec3 = [0.5, 0.5, 0.5];
            const nearestResult = findNearestPoly(
                createFindNearestPolyResult(),
                navMesh,
                agent.position,
                halfExtents,
                DEFAULT_QUERY_FILTER,
            );

            if (nearestResult.success) {
                // find a random point around the agent's current position
                const result = findRandomPointAroundCircle(
                    navMesh,
                    nearestResult.nodeRef,
                    nearestResult.position,
                    4.0, // radius
                    DEFAULT_QUERY_FILTER,
                    random,
                );

                if (result.success) {
                    crowd.requestMoveTarget(catsCrowd, agentId, result.nodeRef, result.position);
                }
            }

            // set next wander time
            agentNextWanderTime[agentId] = time + 1500 + Math.random() * 1500;
        }
    }

    // lerp camera rotation based on mouse position
    const cameraRotationAmount = 0.15; // how much the camera rotates (in radians)
    const cameraLerpSpeed = 2.0; // how fast to lerp to target rotation

    // calculate target look position based on mouse
    const targetLookAt = new THREE.Vector3(
        baseCameraLookAt.x + mouseScreenPos.x * cameraRotationAmount * 10,
        baseCameraLookAt.y + mouseScreenPos.y * cameraRotationAmount * 5,
        baseCameraLookAt.z,
    );

    // get current look direction and lerp towards target
    const currentLookAt = new THREE.Vector3();
    camera.getWorldDirection(currentLookAt);
    currentLookAt.multiplyScalar(10).add(camera.position); // extend direction to point

    currentLookAt.lerp(targetLookAt, cameraLerpSpeed * clampedDeltaTime);
    camera.lookAt(currentLookAt);

    // slerp laser pointer rotation for smooth aiming
    laserPointer.quaternion.slerp(laserPointerTargetQuaternion, laserPointerSlerpSpeed * clampedDeltaTime);

    // perform raycast using the laser pointer's current (slerped) rotation
    // this keeps the raycast, line, and visual rotation perfectly in sync
    laserPointerTip.getWorldPosition(_tempWorldPosition);
    laserPointer.getWorldQuaternion(_tempQuaternion);
    const laserForward = new THREE.Vector3(0, 0, -1); // laser's local forward
    laserForward.applyQuaternion(_tempQuaternion);

    raycaster.set(_tempWorldPosition, laserForward);
    latestIntersects = raycaster.intersectObjects(walkableMeshes, true);

    // get the distance to the first walkable mesh hit (if any)
    const firstWalkableMeshDistance = latestIntersects.length > 0 ? latestIntersects[0].distance : Infinity;

    // raycast against cat meshes to see if laser is hitting any cats
    laserHitAgentIds.clear();
    if (isPointerDown) {
        const catMeshes: THREE.Object3D[] = [];
        for (const visuals of Object.values(agentVisuals)) {
            catMeshes.push(visuals.catGroup);
        }
        const catIntersects = raycaster.intersectObjects(catMeshes, true);

        // find which cat was hit, but only if it's closer than the first walkable mesh
        for (const intersection of catIntersects) {
            // skip if this cat is behind the level geometry
            if (intersection.distance >= firstWalkableMeshDistance) {
                continue;
            }

            let hitObject = intersection.object;
            while (hitObject.parent) {
                for (const [agentId, visuals] of Object.entries(agentVisuals)) {
                    if (hitObject === visuals.catGroup) {
                        laserHitAgentIds.add(agentId);
                        break;
                    }
                }
                hitObject = hitObject.parent;
            }
        }
    }

    // check if we have a valid navmesh target
    latestValidTarget = false;
    if (latestIntersects.length > 0) {
        const intersectionPoint = latestIntersects[0].point;
        const targetPosition: Vec3 = [intersectionPoint.x, intersectionPoint.y, intersectionPoint.z];

        const halfExtents: Vec3 = [5, 5, 5];
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

    // lerp button position for smooth animation
    if (laserPointerButton) {
        const buttonLerpSpeed = 20.0; // Fast lerp
        const targetY = laserPointerButtonRestPosition.y - laserPointerButtonTargetOffset;
        laserPointerButton.position.y += (targetY - laserPointerButton.position.y) * buttonLerpSpeed * clampedDeltaTime;
    }

    // update laser beam visibility and visuals based on pointer state
    if (isPointerDown) {
        laserPointerTip.getWorldPosition(_tempWorldPosition);

        if (latestValidTarget && latestIntersects.length > 0) {
            // use the actual raycast hit point
            const targetPos = latestIntersects[0].point;

            laserBeam.position.copy(_tempWorldPosition);
            _tempDirection.subVectors(targetPos, _tempWorldPosition);
            const distance = _tempDirection.length();

            _tempLocalDirection.set(0, 0, 1);
            _tempQuaternion.setFromUnitVectors(_tempLocalDirection, _tempDirection.normalize());
            laserBeam.quaternion.copy(_tempQuaternion);
            laserBeam.scale.set(1, 1, distance);
            laserBeam.visible = true;
        } else {
            // no navmesh hit - show laser extending far in the direction
            _tempDirection.copy(raycaster.ray.direction).normalize().multiplyScalar(1000);
            _tempLocalDirection.copy(_tempWorldPosition).add(_tempDirection);

            laserBeam.position.copy(_tempWorldPosition);
            _tempDirection.subVectors(_tempLocalDirection, _tempWorldPosition);
            const distance = _tempDirection.length();

            _tempLocalDirection.set(0, 0, 1);
            _tempQuaternion.setFromUnitVectors(_tempLocalDirection, _tempDirection.normalize());
            laserBeam.quaternion.copy(_tempQuaternion);
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

    const agentIds = Object.keys(catsCrowd.agents);

    for (let i = 0; i < agentIds.length; i++) {
        const agentId = agentIds[i];
        const agent = catsCrowd.agents[agentId];
        if (agentVisuals[agentId]) {
            updateAgentVisuals(agentId, agent, agentVisuals[agentId], clampedDeltaTime);
            updateEmotionSprite(agentVisuals[agentId], agentCatState[agentId], time);
        }
    }

    // spawning cats from spinning cats
    const SPIN_SPAWN_DURATION = 3_000;
    for (const agentId of agentIds) {
        const visuals = agentVisuals[agentId];
        const agent = catsCrowd.agents[agentId];
        const catState = agentCatState[agentId];
        if (!visuals || !agent || !catState) continue;

        const isSpinning = catState.state === CatState.SPINNING;

        if (isSpinning) {
            // start tracking spin time if not already
            if (visuals.spinStartTimeForSpawn === null) {
                visuals.spinStartTimeForSpawn = time;
            } else {
                // check if spin duration exceeded
                const spinDuration = time - visuals.spinStartTimeForSpawn;
                if (spinDuration >= SPIN_SPAWN_DURATION) {
                    // spawn new cat at this cat's position
                    spawnCat([...agent.position] as Vec3);
                    // reset timer to allow spawning again after another 3 seconds
                    visuals.spinStartTimeForSpawn = time;
                }
            }
        } else {
            // not spinning - reset timer
            visuals.spinStartTimeForSpawn = null;
        }
    }

    // animate tape meshes with slight rotation
    const rotationSpeed = 0.5; // radians per second
    for (let i = 0; i < tapeMeshes.length; i++) {
        tapeMeshes[i].rotation.y += rotationSpeed * clampedDeltaTime;
    }

    renderer.render(scene, camera);
}

update();
