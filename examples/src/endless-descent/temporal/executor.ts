import Rapier from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { createFindNearestPolyResult, findNearestPoly } from 'navcat';
import type { NavMesh } from 'navcat';
import type { CrowdController } from '../engine/crowd';
import { requestMoveTarget } from '../engine/crowd';
import type { AgentKinodynamics, TemporalPlan, TemporalPlanActionStep, TemporalPlanStep } from './types';

export type AgentRuntime = {
    id: number;
    crowdId: string | null;
    mesh: THREE.Mesh;
    plan: TemporalPlan | null;
    stepIndex: number;
    nextReplanTime: number;
    expectedLandingTime: number;
    body: Rapier.RigidBody | null;
};

export class TemporalExecutor {
    private readonly kin: AgentKinodynamics;
    private readonly crowd: CrowdController;
    private readonly world: Rapier.World;
    private readonly navMesh: NavMesh;
    private readonly agents: AgentRuntime[] = [];

    constructor(kin: AgentKinodynamics, crowd: CrowdController, world: Rapier.World, navMesh: NavMesh) {
        this.kin = kin;
        this.crowd = crowd;
        this.world = world;
        this.navMesh = navMesh;
    }

    addAgent(mesh: THREE.Mesh, crowdId: string): AgentRuntime {
        const runtime: AgentRuntime = {
            id: this.agents.length,
            crowdId,
            mesh,
            plan: null,
            stepIndex: 0,
            nextReplanTime: 0,
            expectedLandingTime: 0,
            body: null,
        };
        this.agents.push(runtime);
        return runtime;
    }

    setPlan(agent: AgentRuntime, plan: TemporalPlan, now: number): void {
        agent.plan = plan;
        agent.stepIndex = 0;
        agent.nextReplanTime = now + plan.eta + 0.5;
    }

    update(now: number, dt: number): void {
        for (const agent of this.agents) {
            if (!agent.plan) continue;
            const step = agent.plan.steps[agent.stepIndex];
            if (!step) continue;

            switch (step.kind) {
                case 'SURFACE':
                    this.updateSurface(agent, step, now);
                    break;
                case 'WAIT':
                    if (now >= step.tEnd) {
                        agent.stepIndex++;
                    }
                    break;
                case 'ACTION':
                    this.updateAction(agent, step, now);
                    break;
                case 'RIDE':
                    if (now >= step.tEnd) {
                        this.finishRide(agent, now);
                    }
                    break;
            }
        }
    }

    private updateSurface(agent: AgentRuntime, step: Extract<TemporalPlanStep, { kind: 'SURFACE' }>, now: number) {
        if (!agent.crowdId) return;
        const target = step.waypoints[step.waypoints.length - 1];
        const nearest = findNearestPoly(
            createFindNearestPolyResult(),
            this.navMesh,
            [target.x, target.y, target.z],
            [0.5, 1, 0.5],
            this.crowd.params.queryFilter,
        );
        if (nearest.success) {
            requestMoveTarget(this.crowd, agent.crowdId, nearest.nodeRef, nearest.position);
        }
        const agentPos = this.crowd.handle.agents[agent.crowdId]?.position;
        if (agentPos) {
            const dist = Math.hypot(agentPos[0] - target.x, agentPos[2] - target.z);
            if (dist < 0.5 || now >= step.tEnd) {
                agent.stepIndex++;
            }
        }
    }

    private updateAction(agent: AgentRuntime, step: TemporalPlanActionStep, now: number) {
        if (now < step.edge.t0) return;
        if (!agent.body) {
            this.beginJump(agent, step);
        }
        if (now >= step.edge.t0 + step.edge.tau) {
            this.endJump(agent, step);
            agent.stepIndex++;
        }
    }

    private beginJump(agent: AgentRuntime, step: TemporalPlanActionStep) {
        if (agent.crowdId) {
            this.crowd.removeAgent(agent.crowdId);
            agent.crowdId = null;
        }
        const bodyDesc = Rapier.RigidBodyDesc.dynamic().setTranslation(
            step.edge.launchPoint.x,
            step.edge.launchPoint.y,
            step.edge.launchPoint.z,
        );
        bodyDesc.setLinvel(
            step.edge.heading.x * step.edge.v0h,
            step.edge.v0y,
            step.edge.heading.z * step.edge.v0h,
        );
        const body = this.world.createRigidBody(bodyDesc);
        const colliderDesc = Rapier.ColliderDesc.ball(0.25);
        this.world.createCollider(colliderDesc, body);
        agent.body = body;
        agent.expectedLandingTime = step.edge.t0 + step.edge.tau;
    }

    private endJump(agent: AgentRuntime, step: TemporalPlanActionStep) {
        if (!agent.body) return;
        const landing = step.edge.landingPoint;
        agent.body.setTranslation(landing, true);
        agent.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.world.removeRigidBody(agent.body);
        agent.body = null;
        agent.mesh.position.copy(landing);

        const nearest = findNearestPoly(
            createFindNearestPolyResult(),
            this.navMesh,
            [landing.x, landing.y, landing.z],
            [0.5, 1.0, 0.5],
            this.crowd.params.queryFilter,
        );
        if (nearest.success) {
            agent.crowdId = this.crowd.spawnAgent(nearest.position);
        }
    }

    private finishRide(agent: AgentRuntime, _now: number) {
        agent.stepIndex++;
        if (agent.stepIndex >= (agent.plan?.steps.length ?? 0)) {
            agent.plan = null;
        }
    }
}
