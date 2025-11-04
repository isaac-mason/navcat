import Rapier from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { vec3, type Vec3 } from 'mathcat';
import { createFindNearestPolyResult, findNearestPoly } from 'navcat';
import type { NavMesh } from 'navcat';
import type { CrowdController } from '../engine/crowd';
import { getAgentNewVelocity, requestMoveTarget, setAgentPosition, setAgentVelocity } from '../engine/crowd';
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
    kinematicBody: Rapier.RigidBody | null;
    collider: Rapier.Collider | null;
    verticalVelocity: number;
    grounded: boolean;
    velocity: Vec3;
    lastPosition: THREE.Vector3;
    position: Vec3;
};

type KinematicCharacterController = ReturnType<Rapier.World['createCharacterController']>;

export class TemporalExecutor {
    private readonly kin: AgentKinodynamics;
    private readonly crowd: CrowdController;
    private readonly world: Rapier.World;
    private readonly navMesh: NavMesh;
    private readonly agents: AgentRuntime[] = [];
    private readonly characterController: KinematicCharacterController;
    private readonly upVector = new THREE.Vector3(0, 1, 0);
    private readonly tempVec3 = new THREE.Vector3();
    private readonly tempDesired = new THREE.Vector3();
    private readonly tempNextPosition = new THREE.Vector3();
    private readonly zeroVelocity: Vec3 = vec3.create();
    private readonly capsuleRadius: number;
    private readonly capsuleHalfHeight: number;

    constructor(
        kin: AgentKinodynamics,
        crowd: CrowdController,
        world: Rapier.World,
        navMesh: NavMesh,
        characterController: KinematicCharacterController,
    ) {
        this.kin = kin;
        this.crowd = crowd;
        this.world = world;
        this.navMesh = navMesh;
        this.characterController = characterController;
        this.capsuleRadius = this.crowd.params.radius;
        const halfHeight = this.crowd.params.height * 0.5 - this.capsuleRadius;
        this.capsuleHalfHeight = Math.max(0, halfHeight);
    }

    private createKinematicForAgent(agent: AgentRuntime, position: Vec3): void {
        if (agent.collider) {
            this.world.removeCollider(agent.collider, true);
            agent.collider = null;
        }
        if (agent.kinematicBody) {
            this.world.removeRigidBody(agent.kinematicBody);
            agent.kinematicBody = null;
        }

        const bodyDesc = Rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(position[0], position[1], position[2]);
        const body = this.world.createRigidBody(bodyDesc);
        body.setNextKinematicTranslation({ x: position[0], y: position[1], z: position[2] });

        const colliderDesc = Rapier.ColliderDesc.capsule(this.capsuleHalfHeight, this.capsuleRadius);
        const collider = this.world.createCollider(colliderDesc, body);

        agent.kinematicBody = body;
        agent.collider = collider;

        agent.lastPosition.set(position[0], position[1], position[2]);
        agent.position[0] = position[0];
        agent.position[1] = position[1];
        agent.position[2] = position[2];
    }

    addAgent(mesh: THREE.Mesh, crowdId: string, initialPosition: Vec3): AgentRuntime {
        const runtimePosition = vec3.create();
        vec3.set(runtimePosition, initialPosition[0], initialPosition[1], initialPosition[2]);

        const runtime: AgentRuntime = {
            id: this.agents.length,
            crowdId,
            mesh,
            plan: null,
            stepIndex: 0,
            nextReplanTime: 0,
            expectedLandingTime: 0,
            body: null,
            kinematicBody: null,
            collider: null,
            verticalVelocity: 0,
            grounded: true,
            velocity: vec3.create(),
            lastPosition: new THREE.Vector3(initialPosition[0], initialPosition[1], initialPosition[2]),
            position: runtimePosition,
        };

        this.createKinematicForAgent(runtime, initialPosition);
        runtime.mesh.position.set(initialPosition[0], initialPosition[1], initialPosition[2]);

        this.agents.push(runtime);
        return runtime;
    }

    setPlan(agent: AgentRuntime, plan: TemporalPlan, now: number): void {
        agent.plan = plan;
        agent.stepIndex = 0;
        agent.nextReplanTime = now + plan.eta + 0.5;
    }

    syncCrowdToPhysics(): void {
        for (const agent of this.agents) {
            if (!agent.crowdId) continue;
            const body = agent.kinematicBody ?? agent.body;
            if (!body) continue;
            const translation = body.translation();
            agent.position[0] = translation.x;
            agent.position[1] = translation.y;
            agent.position[2] = translation.z;
            setAgentPosition(this.crowd, agent.crowdId, agent.position);
            setAgentVelocity(this.crowd, agent.crowdId, agent.velocity);
        }
    }

    update(now: number, dt: number): void {
        for (const agent of this.agents) {
            if (agent.body) {
                this.updateDynamicAgent(agent);
            }

            const step = agent.plan?.steps[agent.stepIndex];

            if (!step) {
                if (!agent.body) {
                    const navVelocity = agent.crowdId ? getAgentNewVelocity(this.crowd, agent.crowdId) : null;
                    this.updateKinematicMovement(agent, navVelocity, dt);
                }
                continue;
            }

            switch (step.kind) {
                case 'SURFACE':
                    this.updateSurface(agent, step, now, dt);
                    break;
                case 'WAIT':
                    this.updateWait(agent, step, now, dt);
                    break;
                case 'ACTION':
                    this.updateAction(agent, step, now);
                    break;
                case 'RIDE':
                    this.updateRide(agent, step, now, dt);
                    break;
            }
        }
    }

    private updateSurface(agent: AgentRuntime, step: Extract<TemporalPlanStep, { kind: 'SURFACE' }>, now: number, dt: number) {
        if (!agent.crowdId) {
            return;
        }

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

        const navVelocity = getAgentNewVelocity(this.crowd, agent.crowdId);
        this.updateKinematicMovement(agent, navVelocity, dt);

        const agentPos = agent.position;
        const dist = Math.hypot(agentPos[0] - target.x, agentPos[2] - target.z);
        if (dist < 0.5 || now >= step.tEnd) {
            agent.stepIndex++;
        }
    }

    private updateWait(agent: AgentRuntime, step: Extract<TemporalPlanStep, { kind: 'WAIT' }>, now: number, dt: number) {
        this.updateKinematicMovement(agent, this.zeroVelocity, dt);
        if (now >= step.tEnd) {
            agent.stepIndex++;
        }
    }

    private updateRide(agent: AgentRuntime, step: Extract<TemporalPlanStep, { kind: 'RIDE' }>, now: number, dt: number) {
        const navVelocity = agent.crowdId ? getAgentNewVelocity(this.crowd, agent.crowdId) : null;
        this.updateKinematicMovement(agent, navVelocity, dt);
        if (now >= step.tEnd) {
            this.finishRide(agent, now);
        }
    }

    private updateDynamicAgent(agent: AgentRuntime): void {
        if (!agent.body) return;
        const translation = agent.body.translation();
        agent.mesh.position.set(translation.x, translation.y, translation.z);
        agent.lastPosition.set(translation.x, translation.y, translation.z);
    }

    private updateKinematicMovement(agent: AgentRuntime, desiredVelocity: Vec3 | null, dt: number): void {
        if (!agent.kinematicBody || !agent.collider) return;

        if (dt <= 0) {
            const translation = agent.kinematicBody.translation();
            agent.mesh.position.set(translation.x, translation.y, translation.z);
            agent.lastPosition.set(translation.x, translation.y, translation.z);
            agent.position[0] = translation.x;
            agent.position[1] = translation.y;
            agent.position[2] = translation.z;
            return;
        }

        const targetVelocity = desiredVelocity ?? this.zeroVelocity;
        agent.verticalVelocity -= this.kin.g * dt;

        const translation = agent.kinematicBody.translation();
        this.tempVec3.set(translation.x, translation.y, translation.z);

        this.tempDesired.set(targetVelocity[0] * dt, agent.verticalVelocity * dt, targetVelocity[2] * dt);

        this.characterController.computeColliderMovement(agent.collider, {
            x: this.tempDesired.x,
            y: this.tempDesired.y,
            z: this.tempDesired.z,
        });

        const movement = this.characterController.computedMovement() as { x: number; y: number; z: number };
        this.tempNextPosition.set(
            this.tempVec3.x + movement.x,
            this.tempVec3.y + movement.y,
            this.tempVec3.z + movement.z,
        );

        agent.kinematicBody.setTranslation(this.tempNextPosition, true);
        agent.kinematicBody.setNextKinematicTranslation({
            x: this.tempNextPosition.x,
            y: this.tempNextPosition.y,
            z: this.tempNextPosition.z,
        });

        agent.mesh.position.copy(this.tempNextPosition);
        agent.lastPosition.copy(this.tempNextPosition);

        const invDt = dt > 0 ? 1 / dt : 0;
        agent.velocity[0] = movement.x * invDt;
        agent.velocity[1] = movement.y * invDt;
        agent.velocity[2] = movement.z * invDt;

        agent.position[0] = this.tempNextPosition.x;
        agent.position[1] = this.tempNextPosition.y;
        agent.position[2] = this.tempNextPosition.z;

        const grounded = this.isGroundedFromController(movement, this.tempDesired.y);
        agent.grounded = grounded;
        if (grounded && agent.verticalVelocity < 0) {
            agent.verticalVelocity = 0;
        }

        if (agent.crowdId) {
            setAgentPosition(this.crowd, agent.crowdId, agent.position);
            setAgentVelocity(this.crowd, agent.crowdId, agent.velocity);
        }
    }

    private isGroundedFromController(applied: { x: number; y: number; z: number }, desiredVertical: number): boolean {
        const controllerAny = this.characterController as unknown as {
            numComputedCollisions?: () => number;
            computedCollision?: (index: number) => any;
        };

        const collisionCount = controllerAny.numComputedCollisions ? controllerAny.numComputedCollisions() : 0;
        for (let i = 0; i < collisionCount; i++) {
            const collision = controllerAny.computedCollision ? controllerAny.computedCollision(i) : null;
            if (!collision) continue;
            const normal =
                collision.normal1 ??
                collision.normal ??
                collision.contactNormal ??
                collision.contact?.normal1 ??
                collision.contact?.normal ??
                collision.manifold?.normal;
            if (!normal) continue;
            const dot = normal.x * this.upVector.x + normal.y * this.upVector.y + normal.z * this.upVector.z;
            if (dot > 0.5) {
                return true;
            }
        }

        if (desiredVertical < 0) {
            const delta = Math.abs(applied.y - desiredVertical);
            if (delta > 0.0001 && delta >= Math.abs(desiredVertical) * 0.2) {
                return true;
            }
        }

        return false;
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
        if (agent.collider) {
            this.world.removeCollider(agent.collider, true);
            agent.collider = null;
        }
        if (agent.kinematicBody) {
            this.world.removeRigidBody(agent.kinematicBody);
            agent.kinematicBody = null;
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
        agent.verticalVelocity = step.edge.v0y;
        agent.grounded = false;
    }

    private endJump(agent: AgentRuntime, step: TemporalPlanActionStep) {
        if (!agent.body) return;
        const landing = step.edge.landingPoint;
        agent.body.setTranslation(landing, true);
        agent.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.world.removeRigidBody(agent.body);
        agent.body = null;
        agent.mesh.position.copy(landing);

        const landingVec: Vec3 = [landing.x, landing.y, landing.z];
        this.createKinematicForAgent(agent, landingVec);
        agent.mesh.position.set(landing.x, landing.y, landing.z);
        agent.verticalVelocity = 0;

        const nearest = findNearestPoly(
            createFindNearestPolyResult(),
            this.navMesh,
            [landing.x, landing.y, landing.z],
            [0.5, 1.0, 0.5],
            this.crowd.params.queryFilter,
        );
        if (nearest.success) {
            agent.crowdId = this.crowd.spawnAgent(nearest.position);
            vec3.copy(agent.position, nearest.position);
            if (agent.crowdId) {
                setAgentPosition(this.crowd, agent.crowdId, agent.position);
                setAgentVelocity(this.crowd, agent.crowdId, agent.velocity);
            }
        }
    }

    private finishRide(agent: AgentRuntime, _now: number) {
        agent.stepIndex++;
        if (agent.stepIndex >= (agent.plan?.steps.length ?? 0)) {
            agent.plan = null;
        }
    }

    resetAgent(agent: AgentRuntime, position: Vec3, crowdId: string): void {
        if (agent.body) {
            this.world.removeRigidBody(agent.body);
            agent.body = null;
        }
        vec3.set(agent.velocity, 0, 0, 0);
        agent.verticalVelocity = 0;
        agent.grounded = true;
        agent.plan = null;
        agent.stepIndex = 0;
        agent.nextReplanTime = 0;
        agent.expectedLandingTime = 0;
        agent.crowdId = crowdId;

        vec3.copy(agent.position, position);
        this.createKinematicForAgent(agent, position);
        agent.mesh.position.set(position[0], position[1], position[2]);

        if (agent.crowdId) {
            setAgentPosition(this.crowd, agent.crowdId, agent.position);
            setAgentVelocity(this.crowd, agent.crowdId, agent.velocity);
        }
    }
}
