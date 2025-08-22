import { type Vec3, vec3 } from 'maaths';
import { createFindNearestPolyResult, DEFAULT_QUERY_FILTER, findNearestPoly, three as threeUtils } from 'nav3d';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import {
    type Agent,
    type AgentParams,
    addAgent,
    CrowdUpdateFlags,
    createCrowd,
    requestMoveTarget,
    updateCrowd,
} from './common/crowd';
import { createExample } from './common/example-boilerplate';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from './common/generate-tiled-nav-mesh';
import { loadGLTF } from './common/load-gltf';
import { findCorridorCorners } from './common/path-corridor';

type AgentVisuals = {
    mesh: THREE.Mesh;
    targetMesh: THREE.Mesh;
    pathLine: THREE.Line | null;
    polyHelpers: threeUtils.DebugObject[] | null;

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

const createAgentVisuals = (position: Vec3, scene: THREE.Scene, color: number, radius: number, height: number): AgentVisuals => {
    const geometry = new THREE.CapsuleGeometry(radius, height, 4, 8);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1] + radius, position[2]);
    scene.add(mesh);

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
    // update agent mesh position
    visuals.mesh.position.fromArray(agent.position);
    visuals.mesh.position.y += agent.params.height / 2;

    // update target mesh position
    visuals.targetMesh.position.fromArray(agent.targetPos);

    // remove old path line
    if (visuals.pathLine) {
        scene.remove(visuals.pathLine);
        visuals.pathLine = null;
    }

    // remove old polygon helpers
    if (visuals.polyHelpers) {
        for (const helper of visuals.polyHelpers) {
            scene.remove(helper.object);
        }
        visuals.polyHelpers = null;
    }

    // create new polygon helpers array
    visuals.polyHelpers = [];

    // get corridor path and create polygon visualizations
    if (agent.corridor.path.length > 0) {
        // convert hex color to RGB array for createNavMeshPolyHelper
        const r = ((agentColor >> 16) & 255) / 255;
        const g = ((agentColor >> 8) & 255) / 255;
        const b = (agentColor & 255) / 255;
        const color: [number, number, number] = [r, g, b];

        // create polygon helpers for each polygon in the corridor path
        for (const polyRef of agent.corridor.path) {
            const polyHelper = threeUtils.createNavMeshPolyHelper(navMesh, polyRef, color);

            // make the polygons semi-transparent
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

            polyHelper.object.position.y += 0.15; // adjust height for visibility

            visuals.polyHelpers.push(polyHelper);
            scene.add(polyHelper.object);
        }
    }

    // create new path line
    const corners = findCorridorCorners(agent.corridor, navMesh, 3);

    if (corners && corners.corners.length > 1) {
        // validate coordinates before creating THREE.js objects
        const validPoints: THREE.Vector3[] = [];

        // add agent position
        if (Number.isFinite(agent.position[0]) && Number.isFinite(agent.position[1]) && Number.isFinite(agent.position[2])) {
            validPoints.push(new THREE.Vector3(agent.position[0], agent.position[1] + 0.2, agent.position[2]));
        }

        // add corners
        for (const corner of corners.corners) {
            if (
                Number.isFinite(corner.position[0]) &&
                Number.isFinite(corner.position[1]) &&
                Number.isFinite(corner.position[2])
            ) {
                validPoints.push(new THREE.Vector3(corner.position[0], corner.position[1] + 0.2, corner.position[2]));
            }
        }

        if (validPoints.length > 1) {
            const geometry = new THREE.BufferGeometry().setFromPoints(validPoints);
            const material = new THREE.LineBasicMaterial({ color: agentColor, linewidth: 2 });
            visuals.pathLine = new THREE.Line(geometry, material);
            scene.add(visuals.pathLine);
        }
    }

    // debug visualization: obstacle segments
    if (options.showObstacleSegments) {
        // remove old obstacle segment lines
        for (const line of visuals.obstacleSegmentLines) {
            scene.remove(line);
        }
        visuals.obstacleSegmentLines = [];

        // add current obstacle segments from the obstacle avoidance query
        for (let i = 0; i < agent.obstacleAvoidanceQuery.segmentCount; i++) {
            const segment = agent.obstacleAvoidanceQuery.segments[i];
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

    // debug visualization: local boundary segments
    if (options.showLocalBoundary) {
        // remove old local boundary lines
        for (const line of visuals.localBoundaryLines) {
            scene.remove(line);
        }
        visuals.localBoundaryLines = [];

        // add current local boundary segments
        for (const segment of agent.boundary.segments) {
            const s = segment.s;
            const points = [new THREE.Vector3(s[0], s[1] + 0.25, s[2]), new THREE.Vector3(s[3], s[4] + 0.25, s[5])];

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

    // debug visualization: velocity vectors
    if (options.showVelocityVectors) {
        // remove old velocity arrows
        if (visuals.velocityArrow) {
            scene.remove(visuals.velocityArrow);
            visuals.velocityArrow = null;
        }
        if (visuals.desiredVelocityArrow) {
            scene.remove(visuals.desiredVelocityArrow);
            visuals.desiredVelocityArrow = null;
        }

        // add current velocity (actual velocity)
        const velLength = vec3.length(agent.velocity);
        if (velLength > 0.01) {
            const velDirection = vec3.normalize([0, 0, 0], agent.velocity);
            const origin = new THREE.Vector3(agent.position[0], agent.position[1] + 0.5, agent.position[2]);
            const direction = new THREE.Vector3(velDirection[0], velDirection[1], velDirection[2]);

            visuals.velocityArrow = new THREE.ArrowHelper(
                direction,
                origin,
                velLength * 0.5, // scale down for visibility
                0x00ff00, // green for actual velocity
                0.2,
                0.1,
            );
            scene.add(visuals.velocityArrow);
        }

        // add desired velocity
        const desiredVelLength = vec3.length(agent.desiredVelocity);
        if (desiredVelLength > 0.01) {
            const desiredVelDirection = vec3.normalize([0, 0, 0], agent.desiredVelocity);
            const origin = new THREE.Vector3(agent.position[0], agent.position[1] + 0.6, agent.position[2]);
            const direction = new THREE.Vector3(desiredVelDirection[0], desiredVelDirection[1], desiredVelDirection[2]);

            visuals.desiredVelocityArrow = new THREE.ArrowHelper(
                direction,
                origin,
                desiredVelLength * 0.5, // scale down for visibility
                0xff0000, // red for desired velocity
                0.2,
                0.1,
            );
            scene.add(visuals.desiredVelocityArrow);
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

/* create crowd and agents */
const crowd = createCrowd(1);

console.log(crowd)

const agentParams: AgentParams = {
    radius: 0.3,
    height: 0.6,
    maxAcceleration: 8.0,
    maxSpeed: 3.5,
    collisionQueryRange: 12.0,
    pathOptimizationRange: 30.0,
    separationWeight: 0.5,
    updateFlags: 0, //CrowdUpdateFlags.ANTICIPATE_TURNS & CrowdUpdateFlags.OBSTACLE_AVOIDANCE & CrowdUpdateFlags.SEPARATION,
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

// Create agents at different positions
const agentPositions: Vec3[] = [
    [-2, 0.5, 3],
    [-1.5, 0.5, 3.5],
    [-2.5, 0.5, 3.5],
];

const agentColors = [0x0000ff, 0x00ff00, 0xff0000, 0xffff00]; // Blue, Green, Red, Yellow
const agentVisuals: Record<string, AgentVisuals> = {};

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i];

    // add agent to crowd
    const agentId = addAgent(crowd, position, agentParams);

    // create visuals for the agent
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, agentParams.radius, agentParams.height);
}

// mouse interaction for setting agent targets
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
        findNearestPoly(nearestResult, navMesh, targetPosition, halfExtents, DEFAULT_QUERY_FILTER);

        if (nearestResult.success && nearestResult.nearestPolyRef) {
            for (const agentId in crowd.agents) {
                requestMoveTarget(crowd, agentId, nearestResult.nearestPolyRef, nearestResult.nearestPoint);
            }
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

    // update crowd
    updateCrowd(crowd, navMesh, deltaTime);

    // update agent visuals
    const agents = Object.keys(crowd.agents);
    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = crowd.agents[agentId];
        if (agentVisuals[agentId]) {
            updateAgentVisuals(agent, agentVisuals[agentId], scene, agentColors[i % agentColors.length], {
                showLocalBoundary: false,
                showObstacleSegments: false,
                showVelocityVectors: true,
            });
        }
    }

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
