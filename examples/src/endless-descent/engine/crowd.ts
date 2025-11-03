import type { Vec3 } from 'mathcat';
import { crowd } from 'navcat/blocks';
import type { NavMesh } from 'navcat';

export type CrowdController = {
    handle: crowd.Crowd;
    params: crowd.AgentParams;
    spawnAgent(position: Vec3): string;
    removeAgent(agentId: string): boolean;
    update(dt: number): void;
};

export function createCrowdController(navMesh: NavMesh, params: crowd.AgentParams, maxAgents = 256): CrowdController {
    const handle = crowd.create(maxAgents);
    const spawnAgent = (position: Vec3): string => {
        return crowd.addAgent(handle, navMesh, position, params);
    };
    const removeAgent = (agentId: string): boolean => {
        return crowd.removeAgent(handle, agentId);
    };
    const update = (dt: number) => {
        crowd.update(handle, navMesh, dt);
    };
    return { handle, params, spawnAgent, removeAgent, update };
}

export function requestMoveTarget(controller: CrowdController, agentId: string, nodeRef: number, target: Vec3): boolean {
    return crowd.requestMoveTarget(controller.handle, agentId, nodeRef, target);
}

export function requestMoveVelocity(controller: CrowdController, agentId: string, velocity: Vec3): boolean {
    return crowd.requestMoveVelocity(controller.handle, agentId, velocity);
}

export function getAgentPosition(controller: CrowdController, agentId: string): Vec3 | null {
    const agent = controller.handle.agents[agentId];
    if (!agent) return null;
    return agent.position;
}

export function setAgentVelocity(controller: CrowdController, agentId: string, velocity: Vec3): void {
    const agent = controller.handle.agents[agentId];
    if (!agent) return;
    agent.velocity[0] = velocity[0];
    agent.velocity[1] = velocity[1];
    agent.velocity[2] = velocity[2];
}
