import type { Vec3 } from 'maaths';
import type { NavMesh, NodeRef, QueryFilter } from 'nav3d';
import type { LocalBoundary } from './local-boundary';
import type { ObstacleAvoidanceParams } from './obstacle-avoidance';
import type { PathCorridor } from './path-corridor';

export enum AgentState {
    INVALID,
    WALKING,
    OFFMESH,
}

export enum AgentMoveRequestState {
    TARGET_NONE,
    TARGET_FAILED,
    TARGET_VALID,
    TARGET_REQUESTING,
    TARGET_WAITING_FOR_QUEUE,
    TARGET_WAITING_FOR_PATH,
    TARGET_VELOCITY,
}

export enum CrowdUpdateFlags {
    ANTICIPATE_TURNS = 1,
    OBSTACLE_AVOIDANCE = 2,
    SEPARATION = 4,
    OPTIMIZE_VIS = 8,
    OPTIMIZE_TOPO = 16,
}

export type AgentParms = {
    radius: number;
    height: number;
    maxAcceleration: number;
    maxSpeed: number;

    collisionQueryRange: number;
    pathOptimizationRange: number;

    seperationWeight: number;

    /** @see CrowdUpdateFlags */
    updateFlags: number;

    queryFilter: QueryFilter;
    obstacleAvoidance: ObstacleAvoidanceParams;
};

export type Agent = {
    state: AgentState;

    corridor: PathCorridor;
    boundary: LocalBoundary;
    topologyOptTime: number;

    neis: Array<{ agentId: string; dist: number }>;

    desiredSpeed: number;

    position: Vec3;
    desiredVelocity: Vec3;
    adjustedVelocity: Vec3;
    velocity: Vec3;

    // allocated corners?

    targetState: AgentMoveRequestState;
    targetRef: NodeRef | null;
    targetPos: Vec3;
    targetReplan: boolean;
    targetReplanTime: number;

    params: AgentParms;
};

export type Crowd = {
    agents: Record<string, Agent>;
    agentIdCounter: number;
    maxAgentRadius: number;
};

export const createCrowd = (maxAgentRadius: number): Crowd => {
    return {
        agents: {},
        agentIdCounter: 0,
        maxAgentRadius,
    };
};

export const addAgent = (crowd: Crowd, agent: Agent): string => {
    const agentId = String(crowd.agentIdCounter++);
    crowd.agents[agentId] = agent;
    return agentId;
};

export const removeAgent = (crowd: Crowd, agentId: string): boolean => {
    if (crowd.agents[agentId]) {
        delete crowd.agents[agentId];
        return true;
    }
    return false;
};

export const requestMoveTarget = (crowd: Crowd, agentId: string, targetRef: NodeRef, targetPos: Vec3, navMesh: NavMesh) => {
    // ...
};

export const requestMoveVelocity = (crowd: Crowd, agentId: string, velocity: Vec3, navMesh: NavMesh) => {
    // ...
};

const checkPathValidity = (crowd: Crowd, navMesh: NavMesh): void => {};

const updateMoveRequests = (crowd: Crowd, navMesh: NavMesh): void => {};

const updateTopologyOptimization = (crowd: Crowd, navMesh: NavMesh): void => {};

const updateNeighbours = (crowd: Crowd): void => {};

const updateAgentLocalBoundary = (agent: Agent, navMesh: NavMesh): void => {
    // add local segments
    // add neighbour agent circles
};

const updateNextCorner = (agent: Agent, navMesh: NavMesh): void => {
    // update the next corner for the agent
};

const updateOffMeshConnectionTriggers = (agent: Agent, navMesh: NavMesh): void => {
    // trigger off mesh connections depending on next corners
};

const updateSteering = (agent: Agent, navMesh: NavMesh, deltaTime: number): void => {
    // update the steering behavior for the agent
};

const updateVelocityPlanning = (agent: Agent, navMesh: NavMesh, deltaTime: number): void => {
    // update the velocity planning for the agent
};

const integrate = (agent: Agent, navMesh: NavMesh, deltaTime: number): void => {
    // integrate the agent's position and velocity
};

const handleCollisions = (agent: Agent, navMesh: NavMesh): void => {
    // update the collision detection and response for the agent
};

const offMeshConnectionUpdate = (agent: Agent, navMesh: NavMesh): void => {
    // update off mesh connection triggers for the agent
};

export const updateCrowd = (crowd: Crowd, navMesh: NavMesh, deltaTime: number): void => {
    // check whether agent paths are still valid
    checkPathValidity(crowd, navMesh);

    // handle move requests since last update
    updateMoveRequests(crowd, navMesh);

    // optimize agent topology
    updateTopologyOptimization(crowd, navMesh);

    // update neighbour agents for each agent
    updateNeighbours(crowd);

    // update local boundary for each agent
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        updateAgentLocalBoundary(agent, navMesh);
    }

    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        // if not walking continue
        // if no target or velocity target state continue
        updateNextCorner(agent, navMesh);
    }

    // trigger off mesh connections depending on next corners
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        updateOffMeshConnectionTriggers(agent, navMesh);
    }

    // calculate steering
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        updateSteering(agent, navMesh, deltaTime);
    }

    // velocity planning
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        updateVelocityPlanning(agent, navMesh, deltaTime);
    }

    // integrate
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        integrate(agent, navMesh, deltaTime);
    }

    // handle collisions
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        // if not walking continue
        handleCollisions(agent, navMesh);
    }

    // update corridors
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        // if not walking continue
        // update the agent's corridor
        // corridor movePosition
        // if not using path truncate corridor to one poly (target none, target velocity)
    }

    // off mesh connection agent animation
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        // if not on off mesh connection, continue
        offMeshConnectionUpdate(agent, navMesh);
    }
};
