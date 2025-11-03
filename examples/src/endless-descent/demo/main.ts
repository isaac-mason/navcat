import Rapier from '@dimforge/rapier3d-compat';
import { findRandomPoint } from 'navcat';
import * as THREE from 'three/webgpu';
import { DEFAULT_QUERY_FILTER } from 'navcat';
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

const navEnv = buildEndlessNavEnvironment(scene);

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

const executor = new TemporalExecutor(kin, crowdController, world, navEnv.navMesh);

const agentGeometry = new THREE.CapsuleGeometry(0.3, 0.8, 4, 8);
const agentMaterial = new THREE.MeshStandardMaterial({ color: 0xf5deb3 });

const agentRuntimes: AgentRuntime[] = [];
for (let i = 0; i < 40; i++) {
    const spawn = findRandomPoint(navEnv.navMesh, DEFAULT_QUERY_FILTER, Math.random);
    if (!spawn.success) continue;
    const mesh = new THREE.Mesh(agentGeometry, agentMaterial.clone());
    mesh.castShadow = true;
    mesh.position.set(spawn.position[0], spawn.position[1], spawn.position[2]);
    scene.add(mesh);
    const crowdId = crowdController.spawnAgent(spawn.position);
    const runtime = executor.addAgent(mesh, crowdId);
    agentRuntimes.push(runtime);
}

const debugDraw = new DebugDraw(scene);

const kinFolder = gui.addFolder('Kinodynamics');
kinFolder.add(kin, 'runMax', 2, 12, 0.1);
kinFolder.add(kin, 'runAccel', 4, 20, 0.1);
kinFolder.add(kin, 'jumpVMax', 2, 12, 0.1);
kinFolder.add(kin, 'lookahead', 2, 10, 0.1);
kinFolder.add(kin, 'ledgeSamples', 1, 12, 1);
kinFolder.open();

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
    crowdController.update(dt);
    updateAgentsPlans(time);
    executor.update(time, dt);

    for (const agent of agentRuntimes) {
        if (agent.crowdId) {
            const pos = getAgentPosition(crowdController, agent.crowdId);
            if (pos) {
                agent.mesh.position.set(pos[0], pos[1], pos[2]);
            }
        }
    }

    controls.update();
    renderer.render(scene, camera);
}

animate();
