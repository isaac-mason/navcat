import { GUI } from 'lil-gui';
import { type Vec3, vec3 } from 'maaths';
import {
    addOffMeshConnection,
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findRandomPoint,
    type NavMesh,
    type NodeRef,
    type OffMeshConnection,
    OffMeshConnectionDirection,
    serPolyNodeRef,
    three as threeUtils,
} from 'navcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import {
    addAgent,
    type Agent,
    type AgentParams,
    createCrowd,
    CrowdUpdateFlags,
    requestMoveTarget,
    updateCrowd,
} from './common/crowd';
import { createExample } from './common/example-base';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from './common/generate-tiled-nav-mesh';
import { loadGLTF } from './common/load-gltf';
import { findCorridorCorners } from './common/path-corridor';

/* controls */
const guiSettings = {
    showVelocityVectors: true,
    showPolyHelpers: true,
    showLocalBoundary: false,
    showObstacleSegments: false,
    showPathLine: false,
    showCapsuleDebug: false,
};

const gui = new GUI();
gui.add(guiSettings, 'showVelocityVectors').name('Show Velocity Vectors');
gui.add(guiSettings, 'showPolyHelpers').name('Show Poly Helpers');
gui.add(guiSettings, 'showLocalBoundary').name('Show Local Boundary');
gui.add(guiSettings, 'showObstacleSegments').name('Show Obstacle Segments');
gui.add(guiSettings, 'showPathLine').name('Show Path Line');
gui.add(guiSettings, 'showCapsuleDebug').name('Show Capsule Debug');

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const levelModel = await loadGLTF('/models/nav-test.glb');
// const levelModel = await loadGLTF('/models/dungeon.gltf');
// const levelModel = await loadGLTF('/models/proto-level.glb');
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

const [positions, indices] = threeUtils.getPositionsAndIndices(walkableMeshes);

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
const detailSampleDistance = 6;
const detailSampleMaxError = 1;

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

const offMeshConnections: OffMeshConnection[] = [
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

const navMeshHelper = threeUtils.createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

const offMeshConnectionsHelper = threeUtils.createNavMeshOffMeshConnectionsHelper(navMesh);
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
};

type AgentVisualsOptions = {
    showObstacleSegments?: boolean;
    showLocalBoundary?: boolean;
    showVelocityVectors?: boolean;
    showPathLine?: boolean;
    showPolyHelpers?: boolean;
    showCapsuleDebug?: boolean; // new option
};

// poly visuals
type PolyHelper = {
    helper: threeUtils.DebugObject;
    polyRef: NodeRef;
};

const polyHelpers = new Map<NodeRef, PolyHelper>();

const createPolyHelpers = (navMesh: NavMesh, scene: THREE.Scene): void => {
    // create helpers for all polygons in the navmesh
    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let polyIndex = 0; polyIndex < tile.polys.length; polyIndex++) {
            const polyRef = serPolyNodeRef(tile.id, polyIndex);

            const helper = threeUtils.createNavMeshPolyHelper(navMesh, polyRef, [0.3, 0.3, 1]);

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
    };
};

const updateAgentVisuals = (
    _agentId: string,
    agent: Agent,
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

    // handle path line visualization
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
};

/* create all polygon helpers for the navmesh */
createPolyHelpers(navMesh, scene);

/* create crowd and agents */
const crowd = createCrowd(1);

console.log(crowd);

const agentParams: AgentParams = {
    radius: 0.3,
    height: 0.6,
    maxAcceleration: 15.0,
    maxSpeed: 3.5,
    collisionQueryRange: 2,
    // pathOptimizationRange: 30.0,
    separationWeight: 0.5,
    updateFlags: CrowdUpdateFlags.ANTICIPATE_TURNS | CrowdUpdateFlags.SEPARATION | CrowdUpdateFlags.OBSTACLE_AVOIDANCE,
    queryFilter: DEFAULT_QUERY_FILTER,
    obstacleAvoidance: {
        velBias: 0.5,
        weightDesVel: 2.0,
        weightCurVel: 0.5,
        weightSide: 0.5,
        weightToi: 2.0,
        horizTime: 2.0,
        gridSize: 33,
        adaptiveDivs: 7,
        adaptiveRings: 2,
        adaptiveDepth: 3,
    },
};

// create agents at different positions
const agentPositions: Vec3[] = Array.from({ length: 10 }).map((_, i) => [-2 + i * -0.05, 0.5, 3]) as Vec3[];

const agentColors = [0x0000ff, 0x00ff00, 0xff0000, 0xffff00, 0xff00ff, 0x00ffff, 0xffa500, 0x800080, 0xffc0cb, 0x90ee90];

const agentVisuals: Record<string, AgentVisuals> = {};

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i % agentColors.length];

    // add agent to crowd
    const agentId = addAgent(crowd, position, agentParams);
    console.log(`Creating agent ${i} at position:`, position);

    // create visuals for the agent
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, agentParams.radius, agentParams.height);
}

const scatterCats = () => {
    for (const agentId in crowd.agents) {
        const randomPointResult = findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, Math.random);

        if (!randomPointResult.success) continue;

        requestMoveTarget(crowd, agentId, randomPointResult.ref, randomPointResult.position);
    }
};

scatterCats();

// mouse interaction for setting agent targets
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// timer for auto-scatter
let lastInteractionTime = performance.now();
let lastScatterTime = performance.now();
const scatterTimeoutMs = 5000;

const onPointerDown = (event: MouseEvent) => {
    if (event.button !== 0) return;

    // update interaction timer
    lastInteractionTime = performance.now();

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
        requestMoveTarget(crowd, agentId, nearestResult.nearestPolyRef, nearestResult.nearestPoint);
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

    // check if we should scatter cats due to inactivity
    if (time - lastInteractionTime > scatterTimeoutMs && time - lastScatterTime > scatterTimeoutMs) {
        scatterCats();
        lastScatterTime = time;
    }

    // update crowd
    // console.time("update crowd");
    updateCrowd(crowd, navMesh, clampedDeltaTime);
    // console.timeEnd("update crowd");

    // update visuals
    clearPolyHelpers();

    // collect corridor information for poly helper coloring
    const polyAgentColors = new Map<NodeRef, number[]>();

    const agents = Object.keys(crowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = crowd.agents[agentId];
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

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
