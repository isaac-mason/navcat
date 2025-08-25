import { GUI } from 'lil-gui';
import { type Vec3, vec3 } from 'maaths';
import {
    addOffMeshConnection,
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    type NavMesh,
    type NodeRef,
    type OffMeshConnection,
    OffMeshConnectionDirection,
    serPolyNodeRef,
    three as threeUtils,
} from 'nav3d';
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
import { createExample } from './common/example-boilerplate';
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
};

const gui = new GUI();
gui.add(guiSettings, 'showVelocityVectors').name('Show Velocity Vectors');
gui.add(guiSettings, 'showPolyHelpers').name('Show Poly Helpers');
gui.add(guiSettings, 'showLocalBoundary').name('Show Local Boundary');
gui.add(guiSettings, 'showObstacleSegments').name('Show Obstacle Segments');
gui.add(guiSettings, 'showPathLine').name('Show Path Line');

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
    mesh: THREE.Mesh;
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

const showPoly = (polyRef: NodeRef): void => {
    const helperInfo = polyHelpers.get(polyRef);
    if (!helperInfo) return;

    helperInfo.helper.object.visible = true;
};

const clearPolyHelpers = (): void => {
    for (const helperInfo of polyHelpers.values()) {
        helperInfo.helper.object.visible = false;
    }
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
    options: AgentVisualsOptions = {},
): void => {
    // update agent mesh position
    visuals.mesh.position.fromArray(agent.position);
    visuals.mesh.position.y += agent.params.height / 2;

    // update target mesh position
    visuals.targetMesh.position.fromArray(agent.targetPos);

    // handle path line visualization
    if (options.showPathLine) {
        const corners = findCorridorCorners(agent.corridor, navMesh, 3);

        if (corners && corners.corners.length > 1) {
            // validate coordinates
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
    if (options.showPolyHelpers && agent.corridor.path.length > 0) {
        // highlight this polygon
        for (const polyRef of agent.corridor.path) {
            showPoly(polyRef);
        }
    }
    // Note: poly helpers are handled globally in clearPolyHelperColors(), no need to hide individually

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
const agentPositions: Vec3[] = Array.from({ length: 10 }).map((_, i) => [-2 + i * 0.01, 0.5, 3]) as Vec3[];

const agentColors = [0x0000ff, 0x00ff00, 0xff0000, 0xffff00];

const agentVisuals: Record<string, AgentVisuals> = {};

for (let i = 0; i < agentPositions.length; i++) {
    const position = agentPositions[i];
    const color = agentColors[i % agentColors.length];

    // add agent to crowd
    const agentId = addAgent(crowd, position, agentParams);

    // create visuals for the agent
    agentVisuals[agentId] = createAgentVisuals(position, scene, color, agentParams.radius, agentParams.height);
}

// mouse interaction for setting agent targets
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

const onPointerDown = (event: MouseEvent) => {
    if (event.button !== 0) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObject(navMeshHelper.object, true);

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

    // update crowd
    // console.time("update crowd");
    updateCrowd(crowd, navMesh, clampedDeltaTime);
    // console.timeEnd("update crowd");

    // update visuals
    clearPolyHelpers();

    const agents = Object.keys(crowd.agents);

    for (let i = 0; i < agents.length; i++) {
        const agentId = agents[i];
        const agent = crowd.agents[agentId];
        if (agentVisuals[agentId]) {
            updateAgentVisuals(agentId, agent, agentVisuals[agentId], scene, {
                showVelocityVectors: guiSettings.showVelocityVectors,
                showPolyHelpers: guiSettings.showPolyHelpers,
                showLocalBoundary: guiSettings.showLocalBoundary,
                showObstacleSegments: guiSettings.showObstacleSegments,
                showPathLine: guiSettings.showPathLine,
            });
        }
    }

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
