import Rapier from '@dimforge/rapier3d-compat';
import { vec3, type Vec3 } from 'mathcat';
import { DEFAULT_QUERY_FILTER, findRandomPoint, findRandomPointAroundCircle } from 'navcat';
import { createNavMeshHelper, createNavMeshLinksHelper, createNavMeshOffMeshConnectionsHelper, createNavMeshPortalsHelper } from 'navcat/three';
import * as THREE from 'three/webgpu';
import { setupScene } from './scene';
import { buildEndlessNavEnvironment } from '../engine/nav';
import { createCrowdController, getAgentPosition, setAgentPosition } from '../engine/crowd';
import { DebugDraw } from '../engine/debug';
import { PlatformsManager } from './platforms';
import { planSpatioTemporalPath } from '../temporal/planner';
import type { AgentKinodynamics, KinematicSurface, TemporalPlan, TemporalPlanActionStep, TemporalPlanStep } from '../temporal/types';
import { TemporalExecutor, type AgentRuntime } from '../temporal/executor';

const container = document.getElementById('root')!;

const { scene, camera, renderer, controls, gui } = await setupScene(container);

await Rapier.init();
const world = new Rapier.World({ x: 0, y: -9.81, z: 0 });
const characterController = world.createCharacterController(0.01);
characterController.setUp({ x: 0, y: 1, z: 0 });
characterController.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
characterController.setMinSlopeSlideAngle((30 * Math.PI) / 180);
characterController.enableAutostep(0.5, 0.2, true);
characterController.enableSnapToGround(0.5);
characterController.setApplyImpulsesToDynamicBodies(true);

const physicsDebugState = { enabled: false };
const physicsDebugGeometry = new THREE.BufferGeometry();
const physicsDebugMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
});
const physicsDebugLines = new THREE.LineSegments(physicsDebugGeometry, physicsDebugMaterial);
physicsDebugLines.renderOrder = 1002;
physicsDebugLines.visible = false;
scene.add(physicsDebugLines);

const clearPhysicsDebug = () => {
    physicsDebugGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    physicsDebugGeometry.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
    physicsDebugGeometry.setDrawRange(0, 0);
};

const updatePhysicsDebug = () => {
    const { vertices, colors } = world.debugRender();

    if (!vertices || vertices.length === 0) {
        clearPhysicsDebug();
        return;
    }

    physicsDebugGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

    const colorCount = colors.length / 4;
    const rgb = new Float32Array(colorCount * 3);
    for (let i = 0, j = 0; i < colors.length; i += 4) {
        rgb[j++] = colors[i];
        rgb[j++] = colors[i + 1];
        rgb[j++] = colors[i + 2];
    }
    physicsDebugGeometry.setAttribute('color', new THREE.Float32BufferAttribute(rgb, 3));
    physicsDebugGeometry.setDrawRange(0, vertices.length / 3);
};

const navEnv = buildEndlessNavEnvironment(scene, world);
// Debug: log nav environment basics
console.log('[EndlessDescent] roofRef:', navEnv.roofRef, 'goalRegion:', navEnv.goalRegion);

const sampleRoofSpawn = (): Vec3 => {
    if (navEnv.roofRef !== 0) {
        const around = findRandomPointAroundCircle(
            navEnv.navMesh,
            navEnv.roofRef,
            [navEnv.roofCenter.x, navEnv.roofCenter.y, navEnv.roofCenter.z],
            4.5,
            DEFAULT_QUERY_FILTER,
            Math.random,
        );
        if (around.success) {
            return around.position;
        }
    }

    for (let attempt = 0; attempt < 50; attempt++) {
        const randomPoint = findRandomPoint(navEnv.navMesh, DEFAULT_QUERY_FILTER, Math.random);
        if (randomPoint.success && randomPoint.position[1] > navEnv.roofCenter.y - 1) {
            return randomPoint.position;
        }
    }

    const fallback = vec3.create();
    fallback[0] = navEnv.roofCenter.x;
    fallback[1] = navEnv.roofCenter.y;
    fallback[2] = navEnv.roofCenter.z;
    return fallback;
};

const crowdParams = {
    radius: 0.3,
    height: 1.2,
    maxAcceleration: 8,
    maxSpeed: 4,
    collisionQueryRange: 3,
    separationWeight: 1,
    updateFlags:
        0 |
        1 |
        2 |
        4 |
        8 |
        16,
    queryFilter: DEFAULT_QUERY_FILTER,
} satisfies import('navcat/blocks').crowd.AgentParams;

const crowdController = createCrowdController(navEnv.navMesh, crowdParams, 256);

const kin: AgentKinodynamics = {
    g: 9.81,
    walkSpeed: 3,
    runMax: 8,
    runAccel: 12,
    jumpVMax: 8,
    safeDrop: 20,
    lookahead: 6,
    timeStep: 0.2,
    ledgeSamples: 5,
};

const platformsManager = new PlatformsManager(world, scene);

const platformHeights = [15, 12, 9, 6, 3];
for (let i = 0; i < platformHeights.length; i++) {
    const height = platformHeights[i];
    const horizontalOffset = 12 + i * 0.8;
    const side = i % 2 === 0 ? 1 : -1;
    platformsManager.addPlatform(
        {
            id: `platform-${i}`,
            size: new THREE.Vector2(2.5 + Math.random(), 2.5 + Math.random()),
            height,
            path:
                i % 2 === 0
                    ? {
                          kind: 'circle',
                          center: new THREE.Vector3(side * horizontalOffset, height, 0),
                          radius: 3.5 + i * 0.6,
                          speed: 0.3 + i * 0.05,
                          phase: Math.random() * Math.PI,
                      }
                    : {
                          kind: 'line',
                          start: new THREE.Vector3(side * horizontalOffset, height, -4 - i),
                          end: new THREE.Vector3(side * (horizontalOffset + 4 + i), height, 4 + i),
                          period: 8 + i * 1.5,
                      },
            spawnTime: 0,
        },
        scene,
    );
}

const groundSurface: KinematicSurface = {
    id: 'ground',
    footprintAt: () => {
        const points = [
            new THREE.Vector3(-50, 0, -50),
            new THREE.Vector3(50, 0, -50),
            new THREE.Vector3(50, 0, 50),
            new THREE.Vector3(-50, 0, 50),
        ];
        return points;
    },
    velocityAt: () => new THREE.Vector3(),
    aabbAt: () => new THREE.Box3(new THREE.Vector3(-50, -1, -50), new THREE.Vector3(50, 1, 50)),
};

const surfaces = (): KinematicSurface[] => [...platformsManager.surfaces(), groundSurface];

const executor = new TemporalExecutor(kin, crowdController, world, navEnv.navMesh, characterController);

const agentGeometry = new THREE.CapsuleGeometry(0.3, 0.8, 4, 8);
const agentMaterial = new THREE.MeshStandardMaterial({ color: 0xffc87a });

const agentRuntimes: AgentRuntime[] = [];
const agentPathVisuals = new Map<AgentRuntime, { line: THREE.Line; color: THREE.Color }>();
const pathHeightOffset = 0.25;
const agentCount = 3;

const ensureAgentPathVisual = (agent: AgentRuntime, color: THREE.Color) => {
    let entry = agentPathVisuals.get(agent);
    if (!entry) {
        const geometry = new THREE.BufferGeometry();
        const material = new THREE.LineBasicMaterial({
            color: color.getHex(),
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
        });
        const line = new THREE.Line(geometry, material);
        line.visible = false;
        line.renderOrder = 1004;
        scene.add(line);
        entry = { line, color: color.clone() };
        agentPathVisuals.set(agent, entry);
    }
    return entry;
};

const hideAgentPath = (agent: AgentRuntime) => {
    const entry = agentPathVisuals.get(agent);
    if (entry) {
        entry.line.visible = false;
    }
};

const densifyPathPoints = (points: THREE.Vector3[]): THREE.Vector3[] => {
    if (points.length < 2) return points;
    const densified: THREE.Vector3[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const current = points[i];
        const next = points[i + 1];
        densified.push(current.clone());
        const distance = current.distanceTo(next);
        if (distance > 0.001) {
            const segments = Math.max(1, Math.ceil(distance * 6));
            for (let j = 1; j < segments; j++) {
                const t = j / segments;
                const interpolated = new THREE.Vector3().lerpVectors(current, next, t);
                densified.push(interpolated);
            }
        }
    }
    densified.push(points[points.length - 1].clone());
    return densified;
};

const sampleJumpArcPoints = (edge: TemporalPlanActionStep['edge']): THREE.Vector3[] => {
    const points: THREE.Vector3[] = [];
    const heading = edge.heading.clone();
    if (heading.lengthSq() > 0) {
        heading.normalize();
    }
    const samples = Math.max(20, Math.ceil(edge.tau / 0.05));
    for (let i = 0; i <= samples; i++) {
        const t = (edge.tau * i) / samples;
        const horizontal = heading.clone().multiplyScalar(edge.v0h * t);
        const x = edge.launchPoint.x + horizontal.x;
        const z = edge.launchPoint.z + horizontal.z;
        const y = edge.launchPoint.y + edge.v0y * t - 0.5 * kin.g * t * t;
        const point = new THREE.Vector3(x, y, z);
        if (i === samples) {
            points.push(edge.landingPoint.clone());
        } else {
            points.push(point);
        }
    }
    return points;
};

const updateAgentPlanPath = (agent: AgentRuntime, plan: TemporalPlan | null, startPosition: THREE.Vector3 | null) => {
    const entry = agentPathVisuals.get(agent);
    if (!entry) return;

    if (!plan || !plan.steps || plan.steps.length === 0) {
        entry.line.visible = false;
        return;
    }

    const points: THREE.Vector3[] = [];
    const addPoint = (vec: THREE.Vector3 | undefined | null) => {
        if (!vec) return;
        if (!Number.isFinite(vec.x) || !Number.isFinite(vec.y) || !Number.isFinite(vec.z)) return;
        const point = vec.clone();
        point.y += pathHeightOffset;
        if (points.length === 0 || !points[points.length - 1].equals(point)) {
            points.push(point);
        }
    };

    if (startPosition) {
        addPoint(startPosition.clone());
    }

    for (const step of plan.steps as TemporalPlanStep[]) {
        switch (step.kind) {
            case 'SURFACE': {
                for (const waypoint of step.waypoints) {
                    addPoint(waypoint);
                }
                break;
            }
            case 'WAIT': {
                addPoint(step.position);
                break;
            }
            case 'ACTION': {
                if (step.edge.approachPath && step.edge.approachPath.length > 0) {
                    for (const approach of step.edge.approachPath) {
                        addPoint(approach);
                    }
                }
                addPoint(step.edge.launchPoint);
                for (const jumpPoint of sampleJumpArcPoints(step.edge)) {
                    addPoint(jumpPoint);
                }
                addPoint(step.edge.landingPoint);
                break;
            }
            case 'RIDE': {
                // No explicit path sampling for ride steps; they will be interpolated between existing points.
                break;
            }
        }
    }

    if (points.length < 2) {
        entry.line.visible = false;
        return;
    }

    const densified = densifyPathPoints(points);
    (entry.line.geometry as THREE.BufferGeometry).setFromPoints(densified);
    entry.line.visible = true;
};

const spawnHeightOffset = 2.5;

for (let i = 0; i < agentCount; i++) {
    const spawnPosition = sampleRoofSpawn();
    const spawnPhysicsPosition = vec3.clone(spawnPosition);
    spawnPhysicsPosition[1] += spawnHeightOffset;
    const mesh = new THREE.Mesh(agentGeometry, agentMaterial.clone());
    mesh.castShadow = true;
    const pathColor = new THREE.Color().setHSL((i / Math.max(1, agentCount)), 0.75, 0.55);
    if (mesh.material && 'color' in mesh.material) {
        (mesh.material as THREE.MeshStandardMaterial).color.copy(pathColor);
    }
    mesh.position.set(spawnPhysicsPosition[0], spawnPhysicsPosition[1], spawnPhysicsPosition[2]);
    scene.add(mesh);
    const crowdId = crowdController.spawnAgent(spawnPosition);
    setAgentPosition(crowdController, crowdId, spawnPhysicsPosition);
    const runtime = executor.addAgent(mesh, crowdId, spawnPhysicsPosition);
    ensureAgentPathVisual(runtime, pathColor);
    agentRuntimes.push(runtime);
}

const debugDraw = new DebugDraw(scene);

// Create helpers with diagnostics
const navMeshHelper = createNavMeshHelper(navEnv.navMesh);
navMeshHelper.object.position.y += 0.2;
navMeshHelper.object.renderOrder = 999;
navMeshHelper.object.traverse((child: any) => {
    if (child instanceof THREE.Mesh) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of materials) {
            if (!mat) continue;
            if ('color' in mat) {
                mat.color.setHex(0x00aaff);
            }
            mat.transparent = true;
            mat.opacity = 0.7;
            mat.depthWrite = false;
            mat.depthTest = false;
        }
    }
});
scene.add(navMeshHelper.object);
console.log('[EndlessDescent] NavMeshHelper added:', {
    visible: navMeshHelper.object.visible,
    children: navMeshHelper.object.children.length,
});

// NavMesh Links helper (hidden by default; toggled via GUI)
const navMeshLinksHelper = createNavMeshLinksHelper(navEnv.navMesh);
navMeshLinksHelper.object.renderOrder = 1000;
navMeshLinksHelper.object.visible = false;
scene.add(navMeshLinksHelper.object);
console.log('[EndlessDescent] NavMeshLinksHelper added:', {
    visible: navMeshLinksHelper.object.visible,
});

// OffMesh Connections helper (hidden by default; toggled via GUI)
const offMeshHelper = createNavMeshOffMeshConnectionsHelper(navEnv.navMesh);
offMeshHelper.object.renderOrder = 1000;
offMeshHelper.object.visible = false;
scene.add(offMeshHelper.object);
console.log('[EndlessDescent] OffMeshConnectionsHelper added:', {
    visible: offMeshHelper.object.visible,
});

// Portals helper (hidden by default; toggled via GUI)
const portalsHelper = createNavMeshPortalsHelper(navEnv.navMesh);
portalsHelper.object.renderOrder = 1000;
portalsHelper.object.visible = false;
scene.add(portalsHelper.object);
console.log('[EndlessDescent] PortalsHelper added:', {
    visible: portalsHelper.object.visible,
});

// Platforms footprint overlay
const platformsOverlay = new THREE.Group();
platformsOverlay.renderOrder = 1001;
scene.add(platformsOverlay);

function rebuildPlatformsOverlay(time: number) {
    platformsOverlay.clear();
    for (const s of surfaces()) {
        const fp = s.footprintAt(time);
        if (!fp || fp.length === 0) continue;
        const closed = [...fp, fp[0]];
        const geom = new THREE.BufferGeometry().setFromPoints(
            closed.map((p) => new THREE.Vector3(p.x, p.y + 0.02, p.z)),
        );
        const mat = new THREE.LineBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.7, linewidth: 1 });
        const line = new THREE.Line(geom, mat);
        line.renderOrder = 1001;
        platformsOverlay.add(line);
    }
}

const debugConfig = {
    navMesh: true,
    navMeshLinks: false,
    navMeshPortals: false,
    offMeshConnections: false,
    platforms: true,
};

const debugFolder = gui.addFolder('NavMesh');
debugFolder.add(debugConfig, 'navMesh').name('NavMesh').onChange((value: boolean) => {
    console.log('[EndlessDescent] Toggle NavMesh:', value);
    navMeshHelper.object.visible = value;
});
debugFolder.add(debugConfig, 'navMeshLinks').name('NavMesh Links').onChange((value: boolean) => {
    console.log('[EndlessDescent] Toggle NavMesh Links:', value);
    navMeshLinksHelper.object.visible = value;
});
debugFolder.add(debugConfig, 'navMeshPortals').name('NavMesh Portals').onChange((value: boolean) => {
    console.log('[EndlessDescent] Toggle NavMesh Portals:', value);
    portalsHelper.object.visible = value;
});
debugFolder.add(debugConfig, 'offMeshConnections').name('OffMesh Connections').onChange((value: boolean) => {
    console.log('[EndlessDescent] Toggle OffMesh Connections:', value);
    offMeshHelper.object.visible = value;
});
debugFolder.add(debugConfig, 'platforms').name('Platforms').onChange((value: boolean) => {
    console.log('[EndlessDescent] Toggle Platforms overlay:', value);
    platformsOverlay.visible = value;
});
debugFolder.add(physicsDebugState, 'enabled').name('Physics Debug').onChange((value: boolean) => {
    console.log('[EndlessDescent] Toggle Physics Debug:', value);
    physicsDebugLines.visible = value;
    if (!value) {
        clearPhysicsDebug();
    } else {
        updatePhysicsDebug();
    }
});
debugFolder.open();

const kinFolder = gui.addFolder('Kinodynamics');
kinFolder.add(kin, 'runMax', 2, 12, 0.1);
kinFolder.add(kin, 'runAccel', 4, 20, 0.1);
kinFolder.add(kin, 'jumpVMax', 2, 12, 0.1);
kinFolder.add(kin, 'lookahead', 2, 10, 0.1);
kinFolder.add(kin, 'ledgeSamples', 1, 12, 1);
kinFolder.open();

// Actions
const actions = {
    resetCrowd: () => {
        const now = performance.now() / 1000;
        console.log('[EndlessDescent] Reset crowd');
        for (const agent of agentRuntimes) {
            if (agent.crowdId) {
                crowdController.removeAgent(agent.crowdId);
            }
            const spawn = sampleRoofSpawn();
            const spawnPhysics = vec3.clone(spawn);
            spawnPhysics[1] += spawnHeightOffset;
            const newId = crowdController.spawnAgent(spawn);
            executor.resetAgent(agent, spawnPhysics, newId);
            agent.nextReplanTime = now;
            hideAgentPath(agent);
        }
    },
};
const actionsFolder = gui.addFolder('Actions');
actionsFolder.add(actions, 'resetCrowd').name('Reset Crowd');
actionsFolder.open();

let lastTime = performance.now() / 1000;

function updateAgentsPlans(now: number) {
    for (const agent of agentRuntimes) {
        const crowdPos = agent.crowdId ? getAgentPosition(crowdController, agent.crowdId) : null;
        const startPos = crowdPos
            ? new THREE.Vector3(crowdPos[0], crowdPos[1], crowdPos[2])
            : agent.mesh.position.clone();

        if (!agent.plan || now > agent.nextReplanTime) {
            const plan = planSpatioTemporalPath(navEnv.navMesh, startPos, navEnv.goalRegion, now, kin, surfaces());
            executor.setPlan(agent, plan, now);
            updateAgentPlanPath(agent, plan, startPos.clone());
            if (agent === agentRuntimes[0]) {
                debugDraw.clear();
                debugDraw.drawPlan(plan);
            }
        } else if (agent.plan) {
            // Keep path line visible for agents with existing plans.
            updateAgentPlanPath(agent, agent.plan, startPos.clone());
        }
    }
}

function animate() {
    requestAnimationFrame(animate);
    const time = performance.now() / 1000;
    const dt = Math.min(0.1, time - lastTime);
    lastTime = time;

    world.step();
    platformsManager.update(time);
    platformsManager.updateContactHighlights(world);
    if (debugConfig.platforms) rebuildPlatformsOverlay(time);
    executor.syncCrowdToPhysics();
    crowdController.update(dt);
    updateAgentsPlans(time);
    executor.update(time, dt);

    if (physicsDebugState.enabled) {
        updatePhysicsDebug();
    }

    controls.update();
    renderer.render(scene, camera);
}

animate();
