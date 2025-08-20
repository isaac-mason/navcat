import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findRandomPoint,
    type NavMesh,
    type QueryFilter,
    three as threeUtils,
} from 'nav3d';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import {
    type Agent,
    AgentState,
    AgentTargetState,
    createAgent,
    requestMoveTarget,
    updateAgents,
} from './common/agent';
import { createExample } from './common/example-boilerplate';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from './common/generate-tiled-nav-mesh';
import { loadGLTF } from './common/load-gltf';
import { findCorridorCorners, resetCorridor } from './common/path-corridor';

const updateAgentVisualPath = (
    agent: Agent,
    scene: THREE.Scene,
    moveTargetMesh: THREE.Mesh,
    pathLine: THREE.Line | null,
    polyHelpers: threeUtils.DebugObject[] | null,
    agentColor: number,
): [THREE.Line | null, threeUtils.DebugObject[] | null] => {
    // Remove old path line
    if (pathLine) {
        scene.remove(pathLine);
        pathLine = null;
    }

    // Remove old polygon helpers
    if (polyHelpers) {
        for (const helper of polyHelpers) {
            scene.remove(helper.object);
        }
        polyHelpers = null;
    }

    // Create new polygon helpers array
    polyHelpers = [];

    // Get corridor path and create polygon visualizations
    if (agent.corridor.path.length > 0) {
        // Convert hex color to RGB array for createNavMeshPolyHelper
        const r = ((agentColor >> 16) & 255) / 255;
        const g = ((agentColor >> 8) & 255) / 255;
        const b = (agentColor & 255) / 255;
        const color: [number, number, number] = [r, g, b];

        // Create polygon helpers for each polygon in the corridor path
        for (const polyRef of agent.corridor.path) {
            const polyHelper = threeUtils.createNavMeshPolyHelper(navMesh, polyRef, color);

            // Make the polygons semi-transparent
            polyHelper.object.traverse((child: any) => {
                if (child instanceof THREE.Mesh && child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach((mat) => {
                            if (mat instanceof THREE.Material) {
                                mat.transparent = true;
                                mat.opacity = 0.3;
                            }
                        });
                    } else if (child.material instanceof THREE.Material) {
                        child.material.transparent = true;
                        child.material.opacity = 0.3;
                    }
                }
            });

            polyHelper.object.position.y += 0.15; // Adjust height for visibility

            polyHelpers.push(polyHelper);
            scene.add(polyHelper.object);
        }
    }

    // Create new path line
    const corners = findCorridorCorners(agent.corridor, navMesh, 3);

    if (corners.length > 1) {
        // Validate coordinates before creating THREE.js objects
        const validPoints: THREE.Vector3[] = [];

        // Add agent position
        if (Number.isFinite(agent.position[0]) && Number.isFinite(agent.position[1]) && Number.isFinite(agent.position[2])) {
            validPoints.push(new THREE.Vector3(agent.position[0], agent.position[1] + 0.2, agent.position[2]));
        }

        // Add corners
        for (const corner of corners) {
            if (Number.isFinite(corner[0]) && Number.isFinite(corner[1]) && Number.isFinite(corner[2])) {
                validPoints.push(new THREE.Vector3(corner[0], corner[1] + 0.2, corner[2]));
            } else {
                console.warn(`Invalid corner coordinate: [${corner[0]}, ${corner[1]}, ${corner[2]}]`);
            }
        }

        if (validPoints.length > 1) {
            const geometry = new THREE.BufferGeometry().setFromPoints(validPoints);
            const material = new THREE.LineBasicMaterial({ color: agentColor, linewidth: 2 });
            pathLine = new THREE.Line(geometry, material);
            scene.add(pathLine);
        }
    }

    // update move target
    moveTargetMesh.position.fromArray(agent.target);

    return [pathLine, polyHelpers];
};

/* Leader and follower agents */

// Leader agent that contains base agent + visuals
type LeaderAgent = {
    agent: Agent;

    // Visual components
    mesh: THREE.Mesh;
    targetMesh: THREE.Mesh;
    pathLine: THREE.Line | null;
    polyHelpers: threeUtils.DebugObject[] | null;
};

// Follower agent that contains base agent + visuals
type FollowerAgent = {
    agent: Agent;

    // Visual components
    mesh: THREE.Mesh;
    targetMesh: THREE.Mesh;
    pathLine: THREE.Line | null;
    polyHelpers: threeUtils.DebugObject[] | null;
};

const createLeaderAgent = (
    id: string,
    position: Vec3,
    scene: THREE.Scene,
    color: number,
    maxSpeed: number,
    radius: number,
): LeaderAgent => {
    // Create visual representation
    const geometry = new THREE.CapsuleGeometry(radius, radius * 2, 4, 8);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1] + radius, position[2]);
    scene.add(mesh);

    // Create target indicator
    const targetGeometry = new THREE.SphereGeometry(0.1);
    const targetMaterial = new THREE.MeshBasicMaterial({ color });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    scene.add(targetMesh);

    return {
        agent: createAgent(id, position, maxSpeed, radius),
        mesh,
        targetMesh,
        pathLine: null,
        polyHelpers: null,
    };
};

const createFollowerAgent = (
    id: string,
    position: Vec3,
    scene: THREE.Scene,
    color: number,
    maxSpeed = 1.5,
    radius = 0.25,
): FollowerAgent => {
    // Create visual representation
    const geometry = new THREE.CapsuleGeometry(radius, radius * 2, 4, 8);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1] + radius, position[2]);
    scene.add(mesh);

    // Create target indicator
    const targetGeometry = new THREE.SphereGeometry(0.1);
    const targetMaterial = new THREE.MeshBasicMaterial({ color });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    scene.add(targetMesh);

    return {
        agent: createAgent(id, position, maxSpeed, radius),
        mesh,
        targetMesh,
        pathLine: null,
        polyHelpers: null,
    };
};

const updateFollowerBehavior = (
    followerAgent: FollowerAgent,
    leaderAgent: LeaderAgent,
    navMesh: NavMesh,
    filter: QueryFilter,
): void => {
    // follow leader if they're far enough away
    const distance = vec3.distance(followerAgent.agent.position, leaderAgent.agent.position);
    const followDistance = 1.0;

    if (distance > followDistance && followerAgent.agent.targetState === AgentTargetState.NONE) {
        // find nearest poly to leader position
        const halfExtents: Vec3 = [1, 1, 1];
        const nearestResult = createFindNearestPolyResult();
        findNearestPoly(nearestResult, navMesh, leaderAgent.agent.position, halfExtents, filter);

        if (nearestResult.success && nearestResult.nearestPolyRef) {
            requestMoveTarget(followerAgent.agent, nearestResult.nearestPolyRef, nearestResult.nearestPoint, navMesh, filter);
        } else {
            console.warn(`Follower failed to find poly near leader`);
        }
    }
};

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const navTestModel = await loadGLTF('/models/nav-test.glb');
scene.add(navTestModel.scene);

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

const navMeshHelper = threeUtils.createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

/* create agents */
const startPosition: Vec3 = [-3, 0.5, 4];
const followerPositions: Vec3[] = [
    [-2, 0.5, 3],
    [-1.5, 0.5, 3.5],
    [-2.5, 0.5, 3.5],
];

// Create leader agent (blue)
const leader = createLeaderAgent('leader', startPosition, scene, 0x0000ff, 5, 0.3);

// Create three follower agents with different colors
const followers = [
    createFollowerAgent('follower1', followerPositions[0], scene, 0x00ff00, 3, 0.25), // Green
    createFollowerAgent('follower2', followerPositions[1], scene, 0xff0000, 3, 0.25), // Red
    createFollowerAgent('follower3', followerPositions[2], scene, 0xffff00, 3, 0.25), // Yellow
];

console.log('Created agents:', { 
    leader: leader.agent.id, 
    followers: followers.map(f => f.agent.id)
});
console.log('Leader mesh:', leader.mesh);
console.log('Follower meshes:', followers.map(f => f.mesh));

// Initialize agents
const filter = DEFAULT_QUERY_FILTER;
const halfExtents: Vec3 = [1, 1, 1];

// Initialize leader
const leaderNearestResult = createFindNearestPolyResult();
findNearestPoly(leaderNearestResult, navMesh, leader.agent.position, halfExtents, filter);
if (leaderNearestResult.success && leaderNearestResult.nearestPolyRef) {
    resetCorridor(leader.agent.corridor, leaderNearestResult.nearestPolyRef, leaderNearestResult.nearestPoint);
    // IMPORTANT: Sync agent position with corridor position (like DetourCrowd)
    vec3.copy(leader.agent.position, leader.agent.corridor.position);
    leader.agent.state = AgentState.WALKING;
    console.log('Leader initialized:');
    console.log('  Agent position:', leader.agent.position);
    console.log('  Corridor position:', leader.agent.corridor.position);
    console.log('  Corridor path length:', leader.agent.corridor.path.length);
    console.log('  First poly:', leader.agent.corridor.path[0]);

    // Give leader an immediate target
    const randomResult = findRandomPoint(navMesh, filter, Math.random);
    if (randomResult.success) {
        requestMoveTarget(leader.agent, randomResult.ref, randomResult.position, navMesh, filter);
        console.log('Leader initial target set:', randomResult.position);
    }
}

// Initialize followers
for (let i = 0; i < followers.length; i++) {
    const follower = followers[i];
    const followerNearestResult = createFindNearestPolyResult();
    findNearestPoly(followerNearestResult, navMesh, follower.agent.position, halfExtents, filter);
    if (followerNearestResult.success && followerNearestResult.nearestPolyRef) {
        resetCorridor(follower.agent.corridor, followerNearestResult.nearestPolyRef, followerNearestResult.nearestPoint);
        vec3.copy(follower.agent.position, followerNearestResult.nearestPoint);
        follower.agent.state = AgentState.WALKING;
        console.log(`Follower ${i + 1} initialized`);
    }
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

const onPointerDown = (event: MouseEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(navMeshHelper.object, true);
    
    if (intersects.length > 0) {
        const intersectionPoint = intersects[0].point;
        const targetPosition: Vec3 = [intersectionPoint.x, intersectionPoint.y, intersectionPoint.z];

        const halfExtents: Vec3 = [1, 1, 1];
        const nearestResult = createFindNearestPolyResult();
        findNearestPoly(nearestResult, navMesh, targetPosition, halfExtents, filter);

        if (nearestResult.success && nearestResult.nearestPolyRef) {
            requestMoveTarget(leader.agent, nearestResult.nearestPolyRef, nearestResult.nearestPoint, navMesh, filter);
        }
    }
};

renderer.domElement.addEventListener('pointerdown', onPointerDown);

let lastTime = performance.now();

/* start loop */
function update() {
    requestAnimationFrame(update);

    const currentTime = performance.now();
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    // update leader behavior (now handled by mouse clicks)
    // updateLeaderBehavior is no longer needed as it's controlled by clicks

    // update follower behaviors
    for (const follower of followers) {
        updateFollowerBehavior(follower, leader, navMesh, filter);
    }

    // update all agents (leader + all followers)
    const allAgents = [leader.agent, ...followers.map(f => f.agent)];
    updateAgents(allAgents, navMesh, filter, deltaTime);

    // update leader visuals
    leader.mesh.position.fromArray(leader.agent.position);
    [leader.pathLine, leader.polyHelpers] = updateAgentVisualPath(
        leader.agent,
        scene,
        leader.targetMesh,
        leader.pathLine,
        leader.polyHelpers,
        0x0000ff,
    );

    // update follower visuals
    const followerColors = [0x00ff00, 0xff0000, 0xffff00]; // Green, Red, Yellow
    for (let i = 0; i < followers.length; i++) {
        const follower = followers[i];
        follower.mesh.position.fromArray(follower.agent.position);
        [follower.pathLine, follower.polyHelpers] = updateAgentVisualPath(
            follower.agent,
            scene,
            follower.targetMesh,
            follower.pathLine,
            follower.polyHelpers,
            followerColors[i],
        );
    }

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
