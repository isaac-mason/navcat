import { GUI } from 'lil-gui';
import { createMulberry32Generator, type Vec3, vec3 } from 'mathcat';
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findRandomPoint,
    getNodeByRef,
} from 'navcat';
import { crowd, floodFillNavMesh, generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import {
    createNavMeshHelper,
    getPositionsAndIndices
} from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';

const random = createMulberry32Generator(42);

/* controls */
const guiSettings = {
    showVelocityVectors: true,
    periodicScatter: true,
};

const gui = new GUI();
gui.add(guiSettings, 'showVelocityVectors').name('Show Velocity Vectors');
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

/* load level model */
const levelModel = await loadGLTF('./models/crowd-simulation-stress-test.glb');
scene.add(levelModel.scene);


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

const tileSizeVoxels = 32;
const tileSizeWorld = tileSizeVoxels * cellSize;

const walkableRadiusWorld = 0.3;
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

const seedPoly = findNearestPoly(createFindNearestPolyResult(), navMesh, [0, 0, 0], [0.5, 0.5, 0.5], DEFAULT_QUERY_FILTER);

if (seedPoly.success) {
    const { unreachable } = floodFillNavMesh(navMesh, [seedPoly.nodeRef]);

    for (const nodeRef of unreachable) {
        const node = getNodeByRef(navMesh, nodeRef);
        if (node) {
            node.flags = 0; // mark as non-walkable;
        }
    }
}

const navMeshHelper = createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

/* agent visuals using instanced meshes */
type AgentVisuals = {
    instanceId: number;
    color: THREE.Color;
    nextTargetTime: number; // timestamp when this agent should pick a new target
};

// Create instanced meshes for all agents upfront
const maxAgents = 1000;

// Capsule instances (agent bodies)
// Match the agentParams below for consistent sizing
const agentRadius = 0.35;
const agentHeight = 0.4;
const capsuleGeometry = new THREE.CapsuleGeometry(agentRadius, agentHeight, 4, 8);
const capsuleMaterial = new THREE.MeshLambertMaterial();
const capsuleInstances = new THREE.InstancedMesh(capsuleGeometry, capsuleMaterial, maxAgents);
capsuleInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(capsuleInstances);

// Target sphere instances
const targetGeometry = new THREE.SphereGeometry(0.1);
const targetMaterial = new THREE.MeshBasicMaterial();
const targetInstances = new THREE.InstancedMesh(targetGeometry, targetMaterial, maxAgents);
targetInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(targetInstances);

// Arrow instances for velocity (green)
const arrowGeometry = createArrowGeometry(1.0);
const velocityArrowMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const velocityArrowInstances = new THREE.InstancedMesh(arrowGeometry, velocityArrowMaterial, maxAgents);
velocityArrowInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
velocityArrowInstances.count = 0; // start hidden
scene.add(velocityArrowInstances);

// Arrow instances for desired velocity (red)
const desiredVelocityArrowMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const desiredVelocityArrowInstances = new THREE.InstancedMesh(arrowGeometry, desiredVelocityArrowMaterial, maxAgents);
desiredVelocityArrowInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
desiredVelocityArrowInstances.count = 0; // start hidden
scene.add(desiredVelocityArrowInstances);

// Helper to create arrow geometry (cone + cylinder)
function createArrowGeometry(length: number): THREE.BufferGeometry {
    const shaftRadius = 0.02;
    const shaftLength = length * 0.7;
    const headRadius = 0.06;
    const headLength = length * 0.3;

    // Create shaft (cylinder)
    const shaftGeometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 8);
    shaftGeometry.translate(0, shaftLength / 2, 0);

    // Create head (cone)
    const headGeometry = new THREE.ConeGeometry(headRadius, headLength, 8);
    headGeometry.translate(0, shaftLength + headLength / 2, 0);

    // Merge geometries using BufferGeometryUtils or manual merging
    const mergedGeometry = new THREE.BufferGeometry();
    
    const shaftPositions = shaftGeometry.getAttribute('position');
    const headPositions = headGeometry.getAttribute('position');
    
    const shaftNormals = shaftGeometry.getAttribute('normal');
    const headNormals = headGeometry.getAttribute('normal');
    
    // Combine positions
    const totalVertices = shaftPositions.count + headPositions.count;
    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    
    positions.set(shaftPositions.array, 0);
    positions.set(headPositions.array, shaftPositions.count * 3);
    
    normals.set(shaftNormals.array, 0);
    normals.set(headNormals.array, shaftNormals.count * 3);
    
    mergedGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    mergedGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    
    // Handle indices if they exist
    if (shaftGeometry.index && headGeometry.index) {
        const shaftIndices = shaftGeometry.index.array;
        const headIndices = headGeometry.index.array;
        const indices = new Uint16Array(shaftIndices.length + headIndices.length);
        
        indices.set(shaftIndices, 0);
        // Offset head indices by shaft vertex count
        for (let i = 0; i < headIndices.length; i++) {
            indices[shaftIndices.length + i] = headIndices[i] + shaftPositions.count;
        }
        
        mergedGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }

    return mergedGeometry;
}

const _tempMatrix = new THREE.Matrix4();
const _tempPosition = new THREE.Vector3();
const _tempQuaternion = new THREE.Quaternion();
const _tempScale = new THREE.Vector3(1, 1, 1);

const createAgentVisuals = (instanceId: number, color: number, currentTime: number): AgentVisuals => {
    return {
        instanceId,
        color: new THREE.Color(color),
        nextTargetTime: currentTime + 5000 + Math.random() * 5000, // 5-10 seconds from now
    };
};

const updateAgentVisuals = (
    agent: crowd.Agent,
    visuals: AgentVisuals,
): void => {
    const instanceId = visuals.instanceId;

    // Update capsule position and color
    // CapsuleGeometry total height = height + 2*radius, so center is at (height + 2*radius) / 2
    const capsuleTotalHeight = agentHeight + 2 * agentRadius;
    const capsuleCenterOffset = capsuleTotalHeight / 2;
    _tempPosition.set(agent.position[0], agent.position[1] + capsuleCenterOffset, agent.position[2]);
    _tempQuaternion.identity();
    _tempScale.set(1, 1, 1);
    _tempMatrix.compose(_tempPosition, _tempQuaternion, _tempScale);
    capsuleInstances.setMatrixAt(instanceId, _tempMatrix);
    capsuleInstances.setColorAt(instanceId, visuals.color);

    // Update target position and color
    _tempPosition.set(agent.targetPosition[0], agent.targetPosition[1] + 0.1, agent.targetPosition[2]);
    _tempMatrix.compose(_tempPosition, _tempQuaternion, _tempScale);
    targetInstances.setMatrixAt(instanceId, _tempMatrix);
    targetInstances.setColorAt(instanceId, visuals.color);
};

const updateVelocityArrows = (agents: crowd.Crowd, agentVisuals: Record<string, AgentVisuals>, showVelocityVectors: boolean): void => {
    if (!showVelocityVectors) {
        velocityArrowInstances.count = 0;
        desiredVelocityArrowInstances.count = 0;
        return;
    }

    let velocityArrowCount = 0;
    let desiredVelocityArrowCount = 0;

    const agentIds = Object.keys(agents.agents);

    for (let i = 0; i < agentIds.length; i++) {
        const agentId = agentIds[i];
        const agent = agents.agents[agentId];
        const visuals = agentVisuals[agentId];

        if (!visuals) continue;

        // Update actual velocity arrow
        const velLength = vec3.length(agent.velocity);
        if (velLength > 0.01) {
            const velDirection = vec3.normalize([0, 0, 0], agent.velocity);

            _tempPosition.set(agent.position[0], agent.position[1] + 0.5, agent.position[2]);

            // Create rotation to point arrow in velocity direction
            const up = new THREE.Vector3(0, 1, 0);
            const dir = new THREE.Vector3(velDirection[0], velDirection[1], velDirection[2]);
            _tempQuaternion.setFromUnitVectors(up, dir);

            const scale = velLength * 0.5;
            _tempScale.set(1, scale, 1);

            _tempMatrix.compose(_tempPosition, _tempQuaternion, _tempScale);
            velocityArrowInstances.setMatrixAt(velocityArrowCount, _tempMatrix);
            velocityArrowCount++;
        }

        // Update desired velocity arrow
        const desiredVelLength = vec3.length(agent.desiredVelocity);
        if (desiredVelLength > 0.01) {
            const desiredVelDirection = vec3.normalize([0, 0, 0], agent.desiredVelocity);

            _tempPosition.set(agent.position[0], agent.position[1] + 0.6, agent.position[2]);

            const up = new THREE.Vector3(0, 1, 0);
            const dir = new THREE.Vector3(desiredVelDirection[0], desiredVelDirection[1], desiredVelDirection[2]);
            _tempQuaternion.setFromUnitVectors(up, dir);

            const scale = desiredVelLength * 0.5;
            _tempScale.set(1, scale, 1);

            _tempMatrix.compose(_tempPosition, _tempQuaternion, _tempScale);
            desiredVelocityArrowInstances.setMatrixAt(desiredVelocityArrowCount, _tempMatrix);
            desiredVelocityArrowCount++;
        }
    }

    velocityArrowInstances.count = velocityArrowCount;
    desiredVelocityArrowInstances.count = desiredVelocityArrowCount;
};

/* create crowd and agents */
const agents = crowd.create(1);

console.log(agents);

const agentParams: crowd.AgentParams = {
    radius: agentRadius,
    height: agentHeight,
    maxAcceleration: 15.0,
    maxSpeed: 3.5,
    collisionQueryRange: 2,
    separationWeight: 0.5,
    updateFlags:
        crowd.CrowdUpdateFlags.ANTICIPATE_TURNS | crowd.CrowdUpdateFlags.SEPARATION | crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE,
    queryFilter: DEFAULT_QUERY_FILTER,
};

// create agents at different positions
const agentPositions: Vec3[] = Array.from({ length: 300 }, () => {
    return findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, random).position;
});

const agentColors = [0x0000ff, 0x00ff00, 0xff0000, 0xffff00, 0xff00ff, 0x00ffff, 0xffa500, 0x800080, 0xffc0cb, 0x90ee90];

const agentVisuals: Record<string, AgentVisuals> = {};

const currentTime = performance.now();

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i % agentColors.length];

    // add agent to crowd
    const agentId = crowd.addAgent(agents, position, agentParams);
    console.log(`Creating agent ${i} at position:`, position);

    // create visuals for the agent (just stores instanceId and color)
    agentVisuals[agentId] = createAgentVisuals(i, color, currentTime);
}

// set initial instance count
capsuleInstances.count = agentPositions.length;
targetInstances.count = agentPositions.length;

const pickNewTarget = (agentId: string, currentTime: number) => {
    const randomPointResult = findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, Math.random);

    if (!randomPointResult.success) return;

    crowd.requestMoveTarget(agents, agentId, randomPointResult.nodeRef, randomPointResult.position);
    
    // Set next target time to 5-10 seconds from now
    if (agentVisuals[agentId]) {
        agentVisuals[agentId].nextTargetTime = currentTime + 5000 + Math.random() * 5000;
    }
};

const scatter = () => {
    const currentTime = performance.now();
    for (const agentId in agents.agents) {
        pickNewTarget(agentId, currentTime);
    }
};

scatter();

// Remove the global timer - agents now have individual timers
// let lastScatterTime = performance.now();
// const scatterTimeoutMs = 5000;

/* loop */
let prevTime = performance.now();

function update() {
    requestAnimationFrame(update);

    const time = performance.now();
    const deltaTime = (time - prevTime) / 1000;
    const clampedDeltaTime = Math.min(deltaTime, 0.1);
    prevTime = time;

    // Check each agent's individual timer for new target (if periodic scatter is enabled)
    if (guiSettings.periodicScatter) {
        for (const agentId in agents.agents) {
            const visuals = agentVisuals[agentId];
            if (visuals && time >= visuals.nextTargetTime) {
                pickNewTarget(agentId, time);
            }
        }
    }

    // update crowd
    crowd.update(agents, navMesh, clampedDeltaTime);

    // Update agent capsules and targets
    const agentIds = Object.keys(agents.agents);
    for (let i = 0; i < agentIds.length; i++) {
        const agentId = agentIds[i];
        const agent = agents.agents[agentId];
        if (agentVisuals[agentId]) {
            updateAgentVisuals(agent, agentVisuals[agentId]);
        }
    }

    // Mark instance matrices as needing update
    capsuleInstances.instanceMatrix.needsUpdate = true;
    if (capsuleInstances.instanceColor) capsuleInstances.instanceColor.needsUpdate = true;
    targetInstances.instanceMatrix.needsUpdate = true;
    if (targetInstances.instanceColor) targetInstances.instanceColor.needsUpdate = true;

    // Update velocity arrows
    updateVelocityArrows(agents, agentVisuals, guiSettings.showVelocityVectors);
    velocityArrowInstances.instanceMatrix.needsUpdate = true;
    desiredVelocityArrowInstances.instanceMatrix.needsUpdate = true;

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
