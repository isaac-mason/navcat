import { GUI } from 'lil-gui';
import { createMulberry32Generator, type Vec3, vec3 } from 'mathcat';
import {
    addOffMeshConnection,
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findRandomPoint,
    getNodeByTileAndPoly,
    type NavMesh,
    type NodeRef,
    OffMeshConnectionDirection,
    type OffMeshConnectionParams,
} from 'navcat';
import { crowd, generateTiledNavMesh, pathCorridor, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import {
    createNavMeshHelper,
    createNavMeshOffMeshConnectionsHelper,
    createNavMeshPolyHelper,
    type DebugObject,
    getPositionsAndIndices,
} from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';

const random = createMulberry32Generator(42);

/* controls */
const guiSettings = {
    showVelocityVectors: true,
    showPolyHelpers: true,
    showLocalBoundary: false,
    showObstacleSegments: false,
    showPathLine: false,
    showCapsuleDebug: false,
    showObstacleAvoidanceDebug: false,
    debugAgentIndex: 0,
    periodicScatter: true,
};

const gui = new GUI();
gui.add(guiSettings, 'showVelocityVectors').name('Show Velocity Vectors');
gui.add(guiSettings, 'showPolyHelpers').name('Show Poly Helpers');
gui.add(guiSettings, 'showLocalBoundary').name('Show Local Boundary');
gui.add(guiSettings, 'showObstacleSegments').name('Show Obstacle Segments');
gui.add(guiSettings, 'showPathLine').name('Show Path Line');
gui.add(guiSettings, 'showCapsuleDebug').name('Show Capsule Debug');
gui.add(guiSettings, 'showObstacleAvoidanceDebug').name('Show Obstacle Avoidance Debug');
gui.add(guiSettings, 'debugAgentIndex', 0, 9, 1).name('Debug Agent Index');
gui.add(guiSettings, 'periodicScatter').name('Periodic Scatter');

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
orbitControls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.ROTATE,
    RIGHT: null,
};

/* load level model */
const levelModel = await loadGLTF('/models/nav-test.glb');
scene.add(levelModel.scene);

/* load cat model for agents */
const catModel = await loadGLTF('/models/cat.gltf');
const catAnimations = catModel.animations;

// Helper function to clone GLTF scene properly
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

const navMeshInput: TiledNavMeshInput = {
    positions,
    indices,
};

const cellSize = 0.15;
const cellHeight = 0.15;

const tileSizeVoxels = 64;
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

/* Visuals */
type AgentVisuals = {
    mesh: THREE.Mesh; // capsule debug mesh
    catGroup: THREE.Group; // cat model group
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
    obstacleSegmentLines: THREE.Line[];
    localBoundaryLines: THREE.Line[];
    velocityArrow: THREE.ArrowHelper;
    desiredVelocityArrow: THREE.ArrowHelper;

    // obstacle avoidance debug
    velocitySampleMeshes: THREE.Mesh[];
    maxSpeedCircle: THREE.Line | null;

    // selection indicator
    selectionRing: THREE.Line;
};

type AgentVisualsOptions = {
    showObstacleSegments?: boolean;
    showLocalBoundary?: boolean;
    showVelocityVectors?: boolean;
    showPathLine?: boolean;
    showPolyHelpers?: boolean;
    showCapsuleDebug?: boolean;
    showObstacleAvoidanceDebug?: boolean;
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

const showPoly = (polyRef: NodeRef, color?: number): void => {
    const helperInfo = polyHelpers.get(polyRef);
    if (!helperInfo) return;

    helperInfo.helper.object.visible = true;

    // Update color if provided
    if (color !== undefined) {
        helperInfo.helper.object.traverse((child: any) => {
            if (child instanceof THREE.Mesh && child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach((mat) => {
                        if ('color' in mat) {
                            mat.color.setHex(color);
                        }
                    });
                } else {
                    if ('color' in child.material) {
                        child.material.color.setHex(color);
                    }
                }
            }
        });
    }
};

const clearPolyHelpers = (): void => {
    for (const helperInfo of polyHelpers.values()) {
        helperInfo.helper.object.visible = false;
    }
};

const mixColors = (colors: number[]): number => {
    if (colors.length === 0) return 0x0000ff;
    if (colors.length === 1) return colors[0];

    let r = 0,
        g = 0,
        b = 0;
    for (const color of colors) {
        r += (color >> 16) & 0xff;
        g += (color >> 8) & 0xff;
        b += color & 0xff;
    }

    r = Math.floor(r / colors.length);
    g = Math.floor(g / colors.length);
    b = Math.floor(b / colors.length);

    return (r << 16) | (g << 8) | b;
};

const createAgentVisuals = (position: Vec3, scene: THREE.Scene, color: number, radius: number, height: number): AgentVisuals => {
    // Create capsule debug mesh (initially hidden)
    const geometry = new THREE.CapsuleGeometry(radius, height, 4, 8);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1] + radius, position[2]);
    mesh.visible = false; // initially hidden
    scene.add(mesh);

    // Create cat model instance by properly cloning the scene
    const catGroup = cloneCatModel(color);
    catGroup.position.set(position[0], position[1], position[2]);
    // Scale the cat to match agent size approximately (cat model is quite large)
    const catScale = radius * 1.5; // larger scale to be more visible
    catGroup.scale.setScalar(catScale);
    scene.add(catGroup);

    // Set up animation mixer for this specific cat instance
    const mixer = new THREE.AnimationMixer(catGroup);

    // Find and create animation actions using the original animations but for this mixer
    const idleClip = catAnimations.find((clip) => clip.name === 'Idle');
    const walkClip = catAnimations.find((clip) => clip.name === 'Walk');
    const runClip = catAnimations.find((clip) => clip.name === 'Run');

    if (!idleClip || !walkClip || !runClip) {
        throw new Error('Missing required animations in cat model');
    }

    const idleAction = mixer.clipAction(idleClip);
    const walkAction = mixer.clipAction(walkClip);
    const runAction = mixer.clipAction(runClip);

    // Set up animation properties
    idleAction.loop = THREE.LoopRepeat;
    walkAction.loop = THREE.LoopRepeat;
    runAction.loop = THREE.LoopRepeat;

    // Start with idle animation
    idleAction.play();

    const targetGeometry = new THREE.SphereGeometry(0.1);
    const targetMaterial = new THREE.MeshBasicMaterial({ color });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    scene.add(targetMesh);

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

    // create selection ring (blue circle at agent base)
    const ringGeometry = new THREE.BufferGeometry();
    const ringPoints: THREE.Vector3[] = [];
    const segments = 32;
    const ringRadius = radius * 1.5; // slightly larger than agent radius

    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const x = Math.cos(theta) * ringRadius;
        const z = Math.sin(theta) * ringRadius;
        ringPoints.push(new THREE.Vector3(x, 0, z));
    }

    ringGeometry.setFromPoints(ringPoints);
    const ringMaterial = new THREE.LineBasicMaterial({ color: 0x00aaff, linewidth: 3 });
    const selectionRing = new THREE.Line(ringGeometry, ringMaterial);
    selectionRing.position.set(position[0], position[1] + 0.05, position[2]);
    selectionRing.visible = false; // initially not selected
    scene.add(selectionRing);

    return {
        mesh,
        catGroup,
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
        obstacleSegmentLines: [],
        localBoundaryLines: [],
        velocityArrow,
        desiredVelocityArrow,
        velocitySampleMeshes: [],
        maxSpeedCircle: null,
        selectionRing,
    };
};

const updateAgentVisuals = (
    _agentId: string,
    agent: crowd.Agent,
    visuals: AgentVisuals,
    scene: THREE.Scene,
    deltaTime: number,
    options: AgentVisualsOptions = {},
): void => {
    // Update animation mixer
    visuals.mixer.update(deltaTime);

    // Update agent mesh position (capsule debug)
    visuals.mesh.position.fromArray(agent.position);
    visuals.mesh.position.y += agent.params.height / 2;
    visuals.mesh.visible = options.showCapsuleDebug ?? false;

    // Update cat model position and rotation
    visuals.catGroup.position.fromArray(agent.position);

    // Calculate velocity and determine animation
    const velocity = vec3.length(agent.velocity);
    let targetAnimation: 'idle' | 'walk' | 'run' = 'idle';

    if (velocity > 2.5) {
        targetAnimation = 'run';
    } else if (velocity > 0.1) {
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
    const minVelocityThreshold = 0.1; // minimum velocity to trigger rotation
    const rotationLerpSpeed = 5.0; // how fast to lerp towards target rotation

    if (velocity > minVelocityThreshold) {
        // Use velocity direction when moving normally
        const direction = vec3.normalize([0, 0, 0], agent.velocity);
        const targetAngle = Math.atan2(direction[0], direction[2]);
        visuals.targetRotation = targetAngle;
    } else {
        // When velocity is low (like during off-mesh connections), face towards target
        const targetDirection = vec3.subtract([0, 0, 0], agent.targetPos, agent.position);
        const targetDistance = vec3.length(targetDirection);

        if (targetDistance > 0.1) {
            // Only rotate if target is far enough away
            const normalizedTarget = vec3.normalize([0, 0, 0], targetDirection);
            const targetAngle = Math.atan2(normalizedTarget[0], normalizedTarget[2]);
            visuals.targetRotation = targetAngle;
        }
    }

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

    // update target mesh position
    visuals.targetMesh.position.fromArray(agent.targetPos);
    visuals.targetMesh.position.y += 0.1;

    // update selection ring position
    visuals.selectionRing.position.set(agent.position[0], agent.position[1] + 0.05, agent.position[2]);

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

    // show polygon helpers for this agent's corridor path

    // obstacle segments visualization
    if (visuals.obstacleSegmentLines.length > 0) {
        for (const line of visuals.obstacleSegmentLines) {
            scene.remove(line);
        }
        visuals.obstacleSegmentLines = [];
    }

    if (options.showObstacleSegments) {
        // add current obstacle segments from the obstacle avoidance query
        for (let i = 0; i < agent.obstacleAvoidanceQuery.segmentCount; i++) {
            const segment = agent.obstacleAvoidanceQuery.segments[i];
            const points = [
                new THREE.Vector3(segment.p[0], segment.p[1] + 0.3, segment.p[2]),
                new THREE.Vector3(segment.q[0], segment.q[1] + 0.3, segment.q[2]),
            ];

            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({
                color: segment.touch ? 0xff0000 : 0xff8800, // red if touching, orange otherwise
                linewidth: 3,
            });
            const line = new THREE.Line(geometry, material);
            visuals.obstacleSegmentLines.push(line);
            scene.add(line);
        }
    }

    // handle local boundary segments visualization
    if (visuals.localBoundaryLines.length > 0) {
        for (const line of visuals.localBoundaryLines) {
            scene.remove(line);
        }
        visuals.localBoundaryLines = [];
    }

    if (options.showLocalBoundary) {
        // add current local boundary segments
        for (const segment of agent.boundary.segments) {
            const s = segment.s;
            const points = [new THREE.Vector3(s[0], s[1] + 0.25, s[2]), new THREE.Vector3(s[3], s[4] + 0.25, s[5])];

            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({
                color: 0x00ffff, // cyan for local boundary
                linewidth: 2,
            });
            const line = new THREE.Line(geometry, material);
            visuals.localBoundaryLines.push(line);
            scene.add(line);
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

    // handle obstacle avoidance debug visualization
    if (options.showObstacleAvoidanceDebug && agent.obstacleAvoidanceDebugData) {
        const debugData = agent.obstacleAvoidanceDebugData;

        // clean up old meshes
        for (const mesh of visuals.velocitySampleMeshes) {
            scene.remove(mesh);
            mesh.geometry.dispose();
            if (mesh.material instanceof THREE.Material) {
                mesh.material.dispose();
            }
        }
        visuals.velocitySampleMeshes = [];

        // create max speed circle if not exists
        if (!visuals.maxSpeedCircle) {
            const circleGeometry = new THREE.BufferGeometry();
            const circlePoints: THREE.Vector3[] = [];
            const segments = 32;
            const maxSpeed = agent.params.maxSpeed;

            for (let i = 0; i <= segments; i++) {
                const theta = (i / segments) * Math.PI * 2;
                const x = Math.cos(theta) * maxSpeed;
                const z = Math.sin(theta) * maxSpeed;
                circlePoints.push(new THREE.Vector3(x, 0, z));
            }

            circleGeometry.setFromPoints(circlePoints);
            const circleMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.3, transparent: true });
            visuals.maxSpeedCircle = new THREE.Line(circleGeometry, circleMaterial);
            scene.add(visuals.maxSpeedCircle);
        }

        // update max speed circle position
        visuals.maxSpeedCircle.position.set(agent.position[0], agent.position[1] + 0.05, agent.position[2]);
        visuals.maxSpeedCircle.visible = true;

        // render velocity samples as colored quads
        for (let i = 0; i < debugData.samples.length; i++) {
            const sample = debugData.samples[i];

            // calculate quad position: agent position + sampled velocity
            const quadPos: Vec3 = [
                agent.position[0] + sample.vel[0],
                agent.position[1] + 0.05,
                agent.position[2] + sample.vel[2],
            ];

            // determine color based on penalties
            // Following Detour demo logic: white (low penalty) -> orange -> red (high penalty)
            let color: THREE.Color;

            if (sample.pen < 0.01) {
                // very low penalty - white
                color = new THREE.Color(1, 1, 1);
            } else {
                // interpolate between white -> orange -> red based on penalty
                // Normalize penalty (Detour uses values typically in 0-10 range)
                const normalizedPen = Math.min(sample.pen / 10.0, 1.0);

                if (normalizedPen < 0.5) {
                    // white to orange
                    const t = normalizedPen * 2;
                    color = new THREE.Color(1, 1 - t * 0.5, 1 - t);
                } else {
                    // orange to red
                    const t = (normalizedPen - 0.5) * 2;
                    color = new THREE.Color(1, 0.5 - t * 0.5, 0);
                }
            }

            // create small quad at sampled velocity position
            const quadSize = sample.ssize * 0.5; // scale down for better visibility
            const quadGeometry = new THREE.PlaneGeometry(quadSize, quadSize);
            quadGeometry.rotateX(-Math.PI / 2); // make it horizontal

            const quadMaterial = new THREE.MeshBasicMaterial({
                color: color,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.7,
            });

            const quadMesh = new THREE.Mesh(quadGeometry, quadMaterial);
            quadMesh.position.set(quadPos[0], quadPos[1], quadPos[2]);

            scene.add(quadMesh);
            visuals.velocitySampleMeshes.push(quadMesh);
        }
    } else {
        // hide obstacle avoidance debug visualization
        for (const mesh of visuals.velocitySampleMeshes) {
            scene.remove(mesh);
            mesh.geometry.dispose();
            if (mesh.material instanceof THREE.Material) {
                mesh.material.dispose();
            }
        }
        visuals.velocitySampleMeshes = [];

        if (visuals.maxSpeedCircle) {
            visuals.maxSpeedCircle.visible = false;
        }
    }
};

/* create all polygon helpers for the navmesh */
createPolyHelpers(navMesh, scene);

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
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, agentParams.radius, agentParams.height);
}

/* Agent selection system */
const selectedAgents = new Set<string>();

const selectAgent = (agentId: string) => {
    selectedAgents.add(agentId);
    if (agentVisuals[agentId]) {
        agentVisuals[agentId].selectionRing.visible = true;
    }
};

const deselectAgent = (agentId: string) => {
    selectedAgents.delete(agentId);
    if (agentVisuals[agentId]) {
        agentVisuals[agentId].selectionRing.visible = false;
    }
};

const clearSelection = () => {
    for (const agentId of selectedAgents) {
        if (agentVisuals[agentId]) {
            agentVisuals[agentId].selectionRing.visible = false;
        }
    }
    selectedAgents.clear();
};

const toggleAgentSelection = (agentId: string) => {
    if (selectedAgents.has(agentId)) {
        deselectAgent(agentId);
    } else {
        selectAgent(agentId);
    }
};

const updateSelectedAgentsInfo = () => {
    if (selectedAgents.size === 0) {
        selectedAgentsInfoDiv.style.display = 'none';
        return;
    }

    selectedAgentsInfoDiv.style.display = 'block';

    let html = `<div style="margin-bottom: 8px; font-weight: bold; color: #00aaff;">Selected Agents (${selectedAgents.size})</div>`;

    let displayCount = 0;
    for (const agentId of selectedAgents) {
        const agent = catsCrowd.agents[agentId];
        if (!agent) continue;

        const agentColor = agentVisuals[agentId]?.color || 0xffffff;
        const colorStr = '#' + agentColor.toString(16).padStart(6, '0');

        html += `<div style="margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.05); border-radius: 3px;">`;
        html += `<div style="color: ${colorStr}; font-weight: bold; margin-bottom: 3px;">Agent ${agentId}</div>`;

        // Position
        html += `<div style="color: #ccc;">Pos: (${agent.position[0].toFixed(2)}, ${agent.position[1].toFixed(2)}, ${agent.position[2].toFixed(2)})</div>`;

        // Target Position
        html += `<div style="color: #ccc;">Target: (${agent.targetPos[0].toFixed(2)}, ${agent.targetPos[1].toFixed(2)}, ${agent.targetPos[2].toFixed(2)})</div>`;

        // Velocity
        const velLength = vec3.length(agent.velocity);
        html += `<div style="color: #ccc;">Velocity: ${velLength.toFixed(2)} m/s</div>`;

        // Current poly
        html += `<div style="color: #ccc;">Poly: ${agent.corridor.path[0] || 'none'}</div>`;

        // Target poly
        if (agent.targetRef) {
            html += `<div style="color: #ccc;">Target Poly: ${agent.targetRef}</div>`;
        }

        // State
        const stateNames = ['Invalid', 'Walking', 'Offmesh'];
        const stateName = stateNames[agent.state] || 'Unknown';
        html += `<div style="color: ${agent.state === 2 ? '#ff00ff' : '#ccc'};">State: ${stateName}</div>`;

        // Corridor path length
        html += `<div style="color: #ccc;">Corridor: ${agent.corridor.path.length} polys</div>`;

        html += `</div>`;
        displayCount++;

        // Limit display to first 5 agents if many selected
        if (displayCount >= 5 && selectedAgents.size > 5) {
            html += `<div style="color: #888; text-align: center; margin-top: 5px;">... and ${selectedAgents.size - 5} more</div>`;
            break;
        }
    }

    selectedAgentsInfoDiv.innerHTML = html;
};

const scatterCats = () => {
    for (const agentId in catsCrowd.agents) {
        // skip selected agents
        if (selectedAgents.has(agentId)) continue;

        const randomPointResult = findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, Math.random);

        if (!randomPointResult.success) continue;

        crowd.requestMoveTarget(catsCrowd, agentId, randomPointResult.ref, randomPointResult.position);
    }
};

scatterCats();

// mouse interaction for setting agent targets
const raycaster = new THREE.Raycaster();

// selection box state
let isMouseDown = false;
let isDragging = false;
const mouseDownPos = new THREE.Vector2();
const currentMousePos = new THREE.Vector2();

// create selection box overlay
const selectionBoxDiv = document.createElement('div');
selectionBoxDiv.style.position = 'absolute';
selectionBoxDiv.style.border = '1px solid #00aaff';
selectionBoxDiv.style.backgroundColor = 'rgba(0, 170, 255, 0.1)';
selectionBoxDiv.style.pointerEvents = 'none';
selectionBoxDiv.style.display = 'none';
container.appendChild(selectionBoxDiv);

// create controls info overlay (bottom left)
const controlsInfoDiv = document.createElement('div');
controlsInfoDiv.style.position = 'absolute';
controlsInfoDiv.style.bottom = '10px';
controlsInfoDiv.style.left = '10px';
controlsInfoDiv.style.color = 'white';
controlsInfoDiv.style.fontFamily = 'monospace';
controlsInfoDiv.style.fontSize = '12px';
controlsInfoDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
controlsInfoDiv.style.padding = '10px';
controlsInfoDiv.style.borderRadius = '4px';
controlsInfoDiv.style.pointerEvents = 'none';
controlsInfoDiv.style.lineHeight = '1.5';
controlsInfoDiv.innerHTML = `
    <div style="margin-bottom: 5px; font-weight: bold; color: #00aaff;">Controls</div>
    <div><span style="color: #aaa;">Left Click:</span> Select agent</div>
    <div><span style="color: #aaa;">Left Click + Drag:</span> Box select agents</div>
    <div><span style="color: #aaa;">Shift + Left Click:</span> Add/remove from selection</div>
    <div><span style="color: #aaa;">Right Click:</span> Set move target</div>
    <div><span style="color: #aaa;">Middle Click:</span> Rotate camera</div>
    <div><span style="color: #aaa;">Shift + Middle Click:</span> Move camera</div>
    <div><span style="color: #aaa;">Middle Mouse:</span> Zoom</div>
`;
container.appendChild(controlsInfoDiv);

// create selected agents info overlay (top right)
const selectedAgentsInfoDiv = document.createElement('div');
selectedAgentsInfoDiv.style.position = 'absolute';
selectedAgentsInfoDiv.style.top = '10px';
selectedAgentsInfoDiv.style.left = '10px';
selectedAgentsInfoDiv.style.color = 'white';
selectedAgentsInfoDiv.style.fontFamily = 'monospace';
selectedAgentsInfoDiv.style.fontSize = '11px';
selectedAgentsInfoDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
selectedAgentsInfoDiv.style.padding = '10px';
selectedAgentsInfoDiv.style.borderRadius = '4px';
selectedAgentsInfoDiv.style.pointerEvents = 'none';
selectedAgentsInfoDiv.style.maxWidth = '300px';
selectedAgentsInfoDiv.style.maxHeight = '400px';
selectedAgentsInfoDiv.style.overflowY = 'auto';
selectedAgentsInfoDiv.style.display = 'none';
container.appendChild(selectedAgentsInfoDiv);

// timer for auto-scatter
let lastScatterTime = performance.now();
const scatterTimeoutMs = 5000;

// helper to get normalized mouse coordinates
const getNormalizedMouse = (event: MouseEvent): THREE.Vector2 => {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
};

// helper to get screen position of world point
const worldToScreen = (worldPos: Vec3): THREE.Vector2 => {
    const vector = new THREE.Vector3(worldPos[0], worldPos[1], worldPos[2]);
    vector.project(camera);

    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((vector.x + 1) * rect.width) / 2 + rect.left, ((-vector.y + 1) * rect.height) / 2 + rect.top);
};

// helper to check if agent is in selection box
const isAgentInSelectionBox = (agentId: string): boolean => {
    const agent = catsCrowd.agents[agentId];
    if (!agent) return false;

    const screenPos = worldToScreen(agent.position);

    // convert to client coordinates
    const boxLeft = Math.min(mouseDownPos.x, currentMousePos.x);
    const boxRight = Math.max(mouseDownPos.x, currentMousePos.x);
    const boxTop = Math.min(mouseDownPos.y, currentMousePos.y);
    const boxBottom = Math.max(mouseDownPos.y, currentMousePos.y);

    return screenPos.x >= boxLeft && screenPos.x <= boxRight && screenPos.y >= boxTop && screenPos.y <= boxBottom;
};

const onPointerDown = (event: MouseEvent) => {
    // left click for selection
    if (event.button === 0) {
        isMouseDown = true;
        isDragging = false;

        mouseDownPos.set(event.clientX, event.clientY);
        currentMousePos.copy(mouseDownPos);

        // disable orbit controls during selection
        orbitControls.enabled = false;
    }
};

const onPointerMove = (event: MouseEvent) => {
    if (!isMouseDown) return;

    currentMousePos.set(event.clientX, event.clientY);

    // consider it a drag if moved more than 5 pixels
    const dragDistance = mouseDownPos.distanceTo(currentMousePos);
    if (dragDistance > 5) {
        isDragging = true;

        // show and update selection box
        const boxLeft = Math.min(mouseDownPos.x, currentMousePos.x);
        const boxTop = Math.min(mouseDownPos.y, currentMousePos.y);
        const boxWidth = Math.abs(currentMousePos.x - mouseDownPos.x);
        const boxHeight = Math.abs(currentMousePos.y - mouseDownPos.y);

        selectionBoxDiv.style.display = 'block';
        selectionBoxDiv.style.left = `${boxLeft}px`;
        selectionBoxDiv.style.top = `${boxTop}px`;
        selectionBoxDiv.style.width = `${boxWidth}px`;
        selectionBoxDiv.style.height = `${boxHeight}px`;
    }
};

const onPointerUp = (event: MouseEvent) => {
    if (event.button !== 0) return;

    if (isDragging) {
        // box selection
        if (!event.shiftKey) {
            clearSelection();
        }

        // select all agents in box
        for (const agentId in catsCrowd.agents) {
            if (isAgentInSelectionBox(agentId)) {
                selectAgent(agentId);
            }
        }

        // hide selection box
        selectionBoxDiv.style.display = 'none';
    } else if (isMouseDown) {
        // single click - raycast to agent
        const normalizedMouse = getNormalizedMouse(event);
        raycaster.setFromCamera(normalizedMouse, camera);

        // raycast to agent cat models
        const agentMeshes: THREE.Object3D[] = [];
        for (const agentId in catsCrowd.agents) {
            if (agentVisuals[agentId]) {
                agentMeshes.push(agentVisuals[agentId].catGroup);
            }
        }

        const intersects = raycaster.intersectObjects(agentMeshes, true);

        if (intersects.length > 0) {
            // find which agent was clicked
            let clickedAgentId: string | null = null;
            for (const agentId in catsCrowd.agents) {
                if (agentVisuals[agentId] && intersects[0].object.parent === agentVisuals[agentId].catGroup) {
                    clickedAgentId = agentId;
                    break;
                }
                // check if it's a child of the cat group
                let obj = intersects[0].object;
                while (obj.parent) {
                    if (obj.parent === agentVisuals[agentId].catGroup) {
                        clickedAgentId = agentId;
                        break;
                    }
                    obj = obj.parent;
                }
                if (clickedAgentId) break;
            }

            if (clickedAgentId) {
                if (event.shiftKey) {
                    toggleAgentSelection(clickedAgentId);
                } else {
                    clearSelection();
                    selectAgent(clickedAgentId);
                }
            }
        } else {
            // clicked on empty space - clear selection if not shift
            if (!event.shiftKey) {
                clearSelection();
            }
        }
    }

    isMouseDown = false;
    isDragging = false;

    // re-enable orbit controls after left-click interaction
    orbitControls.enabled = true;
};

const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();

    // temporarily disable orbit controls for right-click
    orbitControls.enabled = false;
    setTimeout(() => {
        orbitControls.enabled = true;
    }, 0);

    // right click - set move target for selected agents
    if (selectedAgents.size === 0) return;

    const normalizedMouse = getNormalizedMouse(event);
    raycaster.setFromCamera(normalizedMouse, camera);

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

    // move only selected agents
    for (const agentId of selectedAgents) {
        crowd.requestMoveTarget(catsCrowd, agentId, nearestResult.ref, nearestResult.point);
    }

    console.log('target position for selected agents:', targetPosition);
};

renderer.domElement.addEventListener('pointerdown', onPointerDown);
renderer.domElement.addEventListener('pointermove', onPointerMove);
renderer.domElement.addEventListener('pointerup', onPointerUp);
renderer.domElement.addEventListener('contextmenu', onContextMenu);

/* loop */
let prevTime = performance.now();

function update() {
    requestAnimationFrame(update);

    const time = performance.now();
    const deltaTime = (time - prevTime) / 1000;
    const clampedDeltaTime = Math.min(deltaTime, 0.1);
    prevTime = time;

    // check if we should scatter cats (if periodic scatter is enabled)
    if (guiSettings.periodicScatter && time - lastScatterTime > scatterTimeoutMs) {
        scatterCats();
        lastScatterTime = time;
    }

    // update crowd
    crowd.updateCrowd(catsCrowd, navMesh, clampedDeltaTime);

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
                const x = anim.startPos[0] + (anim.endPos[0] - anim.startPos[0]) * progress;
                const z = anim.startPos[2] + (anim.endPos[2] - anim.startPos[2]) * progress;

                // parabolic arc for y (creates a jump effect)
                const startY = anim.startPos[1];
                const endY = anim.endPos[1];
                const arcHeight = 1.0; // height of the arc

                // parabola: y = -4h * (p - 0.5)^2 + h where h is max height above start
                const parabola = -4 * arcHeight * (progress - 0.5) ** 2 + arcHeight;
                const y = startY + (endY - startY) * progress + parabola;

                vec3.set(agent.position, x, y, z);
            }
        }
    }

    // update visuals
    clearPolyHelpers();

    // collect corridor information for poly helper coloring
    const polyAgentColors = new Map<NodeRef, number[]>();

    const agents = Object.keys(catsCrowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = catsCrowd.agents[agentId];
        if (agentVisuals[agentId]) {
            // collect corridor data for this agent
            if (guiSettings.showPolyHelpers && agent.corridor.path.length > 0) {
                const agentColor = agentVisuals[agentId].color;
                for (const polyRef of agent.corridor.path) {
                    if (!polyAgentColors.has(polyRef)) {
                        polyAgentColors.set(polyRef, []);
                    }
                    polyAgentColors.get(polyRef)!.push(agentColor);
                }
            }

            updateAgentVisuals(agentId, agent, agentVisuals[agentId], scene, clampedDeltaTime, {
                showVelocityVectors: guiSettings.showVelocityVectors,
                showPolyHelpers: guiSettings.showPolyHelpers,
                showLocalBoundary: guiSettings.showLocalBoundary,
                showObstacleSegments: guiSettings.showObstacleSegments,
                showPathLine: guiSettings.showPathLine,
                showCapsuleDebug: guiSettings.showCapsuleDebug,
                showObstacleAvoidanceDebug: guiSettings.showObstacleAvoidanceDebug && i === guiSettings.debugAgentIndex,
            });
        }
    }

    // update poly helper colors based on collected corridor data
    if (guiSettings.showPolyHelpers) {
        for (const [polyRef, colors] of polyAgentColors.entries()) {
            const mixedColor = mixColors(colors);
            showPoly(polyRef, mixedColor);
        }
    }

    // update selected agents info display
    updateSelectedAgentsInfo();

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
