import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
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

// Agent visual components for debug visualization
type AgentVisuals = {
    mesh: THREE.Mesh;
    targetMesh: THREE.Mesh;
    pathLine: THREE.Line | null;
    polyHelpers: threeUtils.DebugObject[] | null;
    
    // Debug visualization for obstacle avoidance
    obstacleSegmentLines: THREE.Line[];
    localBoundaryLines: THREE.Line[];
    velocityArrow: THREE.ArrowHelper | null;
    desiredVelocityArrow: THREE.ArrowHelper | null;
};

type AgentVisualsOptions = {
    showObstacleSegments?: boolean;
    showLocalBoundary?: boolean;
    showVelocityVectors?: boolean;
};

const createAgentVisuals = (
    position: Vec3,
    scene: THREE.Scene,
    color: number,
    radius: number,
): AgentVisuals => {
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
        mesh,
        targetMesh,
        pathLine: null,
        polyHelpers: null,
        obstacleSegmentLines: [],
        localBoundaryLines: [],
        velocityArrow: null,
        desiredVelocityArrow: null,
    };
};

const updateAgentVisuals = (
    agent: Agent,
    visuals: AgentVisuals,
    scene: THREE.Scene,
    agentColor: number,
    options: AgentVisualsOptions = {},
): void => {
    // Update agent mesh position
    visuals.mesh.position.fromArray(agent.position);
    
    // Update target mesh position
    visuals.targetMesh.position.fromArray(agent.target);

    // Remove old path line
    if (visuals.pathLine) {
        scene.remove(visuals.pathLine);
        visuals.pathLine = null;
    }

    // Remove old polygon helpers
    if (visuals.polyHelpers) {
        for (const helper of visuals.polyHelpers) {
            scene.remove(helper.object);
        }
        visuals.polyHelpers = null;
    }

    // Create new polygon helpers array
    visuals.polyHelpers = [];

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

            visuals.polyHelpers.push(polyHelper);
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
            }
        }

        if (validPoints.length > 1) {
            const geometry = new THREE.BufferGeometry().setFromPoints(validPoints);
            const material = new THREE.LineBasicMaterial({ color: agentColor, linewidth: 2 });
            visuals.pathLine = new THREE.Line(geometry, material);
            scene.add(visuals.pathLine);
        }
    }

    // Debug visualization: Obstacle segments
    if (options.showObstacleSegments) {
        // Remove old obstacle segment lines
        for (const line of visuals.obstacleSegmentLines) {
            scene.remove(line);
        }
        visuals.obstacleSegmentLines = [];

        // Add current obstacle segments from the obstacle avoidance query
        for (const segment of agent.obstacleAvoidanceQuery.segments) {
            const points = [
                new THREE.Vector3(segment.p[0], segment.p[1] + 0.3, segment.p[2]),
                new THREE.Vector3(segment.q[0], segment.q[1] + 0.3, segment.q[2]),
            ];
            
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({ 
                color: segment.touch ? 0xff0000 : 0xff8800, // Red if touching, orange otherwise
                linewidth: 3,
            });
            const line = new THREE.Line(geometry, material);
            visuals.obstacleSegmentLines.push(line);
            scene.add(line);
        }
    }

    // Debug visualization: Local boundary segments
    if (options.showLocalBoundary) {
        // Remove old local boundary lines
        for (const line of visuals.localBoundaryLines) {
            scene.remove(line);
        }
        visuals.localBoundaryLines = [];

        // Add current local boundary segments
        for (const segment of agent.localBoundary.segments) {
            const s = segment.s;
            const points = [
                new THREE.Vector3(s[0], s[1] + 0.25, s[2]),
                new THREE.Vector3(s[3], s[4] + 0.25, s[5]),
            ];
            
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({ 
                color: 0x00ffff, // Cyan for local boundary
                linewidth: 2,
            });
            const line = new THREE.Line(geometry, material);
            visuals.localBoundaryLines.push(line);
            scene.add(line);
        }
    }

    // Debug visualization: Velocity vectors
    if (options.showVelocityVectors) {
        // Remove old velocity arrows
        if (visuals.velocityArrow) {
            scene.remove(visuals.velocityArrow);
            visuals.velocityArrow = null;
        }
        if (visuals.desiredVelocityArrow) {
            scene.remove(visuals.desiredVelocityArrow);
            visuals.desiredVelocityArrow = null;
        }

        // Add current velocity (actual velocity)
        const velLength = vec3.length(agent.velocity);
        if (velLength > 0.01) {
            const velDirection = vec3.normalize([0, 0, 0], agent.velocity);
            const origin = new THREE.Vector3(agent.position[0], agent.position[1] + 0.5, agent.position[2]);
            const direction = new THREE.Vector3(velDirection[0], velDirection[1], velDirection[2]);
            
            visuals.velocityArrow = new THREE.ArrowHelper(
                direction,
                origin,
                velLength * 0.5, // Scale down for visibility
                0x00ff00, // Green for actual velocity
                0.2,
                0.1
            );
            scene.add(visuals.velocityArrow);
        }

        // Add desired velocity
        const desiredVelLength = vec3.length(agent.desiredVelocity);
        if (desiredVelLength > 0.01) {
            const desiredVelDirection = vec3.normalize([0, 0, 0], agent.desiredVelocity);
            const origin = new THREE.Vector3(agent.position[0], agent.position[1] + 0.6, agent.position[2]);
            const direction = new THREE.Vector3(desiredVelDirection[0], desiredVelDirection[1], desiredVelDirection[2]);
            
            visuals.desiredVelocityArrow = new THREE.ArrowHelper(
                direction,
                origin,
                desiredVelLength * 0.5, // Scale down for visibility
                0xff0000, // Red for desired velocity
                0.2,
                0.1
            );
            scene.add(visuals.desiredVelocityArrow);
        }
    }
};

/* Leader and follower agents */

// Leader agent that contains base agent + visuals
type LeaderAgent = {
    agent: Agent;
    visuals: AgentVisuals;
};

// Follower agent that contains base agent + visuals
type FollowerAgent = {
    agent: Agent;
    visuals: AgentVisuals;
};

const createLeaderAgent = (
    id: string,
    position: Vec3,
    scene: THREE.Scene,
    color: number,
    maxSpeed: number,
    radius: number,
): LeaderAgent => {
    const agent = createAgent(id, position, maxSpeed, radius);
    const visuals = createAgentVisuals(position, scene, color, radius);

    return {
        agent,
        visuals,
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
    const agent = createAgent(id, position, maxSpeed, radius);
    const visuals = createAgentVisuals(position, scene, color, radius);

    return {
        agent,
        visuals,
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

// initialize agents
const agents: Agent[] = []
const filter = DEFAULT_QUERY_FILTER;
const halfExtents: Vec3 = [1, 1, 1];

// initialize leader
const leaderNearestResult = createFindNearestPolyResult();
findNearestPoly(leaderNearestResult, navMesh, leader.agent.position, halfExtents, filter);
if (leaderNearestResult.success && leaderNearestResult.nearestPolyRef) {
    resetCorridor(leader.agent.corridor, leaderNearestResult.nearestPolyRef, leaderNearestResult.nearestPoint);
    vec3.copy(leader.agent.position, leader.agent.corridor.position);
    leader.agent.state = AgentState.WALKING;
}

agents.push(leader.agent);

// initialize followers
for (let i = 0; i < followers.length; i++) {
    const follower = followers[i];
    const followerNearestResult = createFindNearestPolyResult();
    findNearestPoly(followerNearestResult, navMesh, follower.agent.position, halfExtents, filter);

    if (followerNearestResult.success && followerNearestResult.nearestPolyRef) {
        resetCorridor(follower.agent.corridor, followerNearestResult.nearestPolyRef, followerNearestResult.nearestPoint);
        vec3.copy(follower.agent.position, followerNearestResult.nearestPoint);
        follower.agent.state = AgentState.WALKING;
    }

    agents.push(follower.agent);
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

    // update follower behaviors
    for (const follower of followers) {
        updateFollowerBehavior(follower, leader, navMesh, filter);
    }

    // update agents
    updateAgents(agents, navMesh, filter, deltaTime);

    // update leader visuals with debug visualization
    updateAgentVisuals(
        leader.agent,
        leader.visuals,
        scene,
        0x0000ff,
        {
            showObstacleSegments: true,
            showLocalBoundary: false,
            showVelocityVectors: true,
        }
    );

    // update follower visuals
    const followerColors = [0x00ff00, 0xff0000, 0xffff00]; // Green, Red, Yellow
    for (let i = 0; i < followers.length; i++) {
        const follower = followers[i];
        updateAgentVisuals(
            follower.agent,
            follower.visuals,
            scene,
            followerColors[i]
        );
    }

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
