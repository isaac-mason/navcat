import Rapier from '@dimforge/rapier3d-compat';
import { vec3, type Vec3 } from 'mathcat';
import { DEFAULT_QUERY_FILTER, findRandomPoint, findRandomPointAroundCircle } from 'navcat';
import { createNavMeshHelper, createNavMeshLinksHelper, createNavMeshOffMeshConnectionsHelper, createNavMeshPortalsHelper } from 'navcat/three';
import * as THREE from 'three/webgpu';
import { setupScene } from './scene';
import { buildEndlessNavEnvironment } from '../engine/nav';
import { createCrowdController, getAgentPosition } from '../engine/crowd';
import { DebugDraw } from '../engine/debug';
import { PlatformsManager } from './platforms';
import { planSpatioTemporalPath } from '../temporal/planner';
import type { AgentKinodynamics, KinematicSurface } from '../temporal/types';
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

const navEnv = buildEndlessNavEnvironment(scene);
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
    platformsManager.addPlatform(
        {
            id: `platform-${i}`,
            size: new THREE.Vector2(2.5 + Math.random(), 2.5 + Math.random()),
            height: platformHeights[i],
            path:
                i % 2 === 0
                    ? {
                          kind: 'circle',
                          center: new THREE.Vector3(0, platformHeights[i], 0),
                          radius: 6 + i,
                          speed: 0.3 + i * 0.05,
                          phase: Math.random() * Math.PI,
                      }
                    : {
                          kind: 'line',
                          start: new THREE.Vector3(-8, platformHeights[i], -4 - i),
                          end: new THREE.Vector3(8, platformHeights[i], 4 + i),
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
for (let i = 0; i < 40; i++) {
    const spawnPosition = sampleRoofSpawn();
    const mesh = new THREE.Mesh(agentGeometry, agentMaterial.clone());
    mesh.castShadow = true;
    mesh.position.set(spawnPosition[0], spawnPosition[1], spawnPosition[2]);
    scene.add(mesh);
    const crowdId = crowdController.spawnAgent(spawnPosition);
    const runtime = executor.addAgent(mesh, crowdId, spawnPosition);
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
            const newId = crowdController.spawnAgent(spawn);
            executor.resetAgent(agent, spawn, newId);
            agent.nextReplanTime = now;
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
            if (agent === agentRuntimes[0]) {
                debugDraw.clear();
                debugDraw.drawPlan(plan);
            }
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
