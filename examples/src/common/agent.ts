import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import {
    createSlicedNodePathQuery,
    finalizeSlicedFindNodePath,
    initSlicedFindNodePath,
    type NavMesh,
    type NodeRef,
    type QueryFilter,
    SlicedFindNodePathStatusFlags,
    type SlicedNodePathQuery,
    updateSlicedFindNodePath,
} from 'nav3d';
import { createLocalBoundary, isLocalBoundaryValid, type LocalBoundary, updateLocalBoundary } from './local-boundary';
import {
    addCircleObstacle,
    addSegmentObstacle,
    createObstacleAvoidanceQuery,
    type ObstacleAvoidanceParams,
    type ObstacleAvoidanceQuery,
    resetObstacleAvoidanceQuery,
    sampleVelocityAdaptive,
} from './obstacle-avoidance';
import {
    corridorMovePosition,
    createPathCorridor,
    findCorridorCorners,
    type PathCorridor,
    setCorridorPath,
} from './path-corridor';

export enum AgentState {
    INVALID,
    WALKING,
    WAITING,
}

export enum AgentTargetState {
    NONE,
    REQUESTING,
    VALID,
    FAILED,
}

export type Agent = {
    id: string;

    position: Vec3;
    velocity: Vec3;
    desiredVelocity: Vec3; // desired velocity before obstacle avoidance
    newVelocity: Vec3; // result of obstacle avoidance sampling
    maxSpeed: number;
    radius: number;
    collisionQueryRange: number; // range for boundary and neighbor queries

    state: AgentState;
    target: Vec3;
    targetState: AgentTargetState;
    targetRef: NodeRef;

    corridor: PathCorridor;
    slicedQuery: SlicedNodePathQuery;
    localBoundary: LocalBoundary;
    obstacleAvoidanceQuery: ObstacleAvoidanceQuery;

    targetReplanTime: number; // Time since last replan

    // neighbors for collision avoidance
    neighbors: Agent[];
};

export const createAgent = (id: string, position: Vec3, maxSpeed: number, radius: number, collisionQueryRange: number): Agent => {
    return {
        id,

        position: vec3.clone(position),
        velocity: [0, 0, 0],
        desiredVelocity: [0, 0, 0],
        newVelocity: [0, 0, 0],
        maxSpeed,
        radius,
        collisionQueryRange,

        state: AgentState.INVALID,
        target: vec3.clone(position),
        targetState: AgentTargetState.NONE,
        targetRef: '0,0,0' as NodeRef,

        corridor: createPathCorridor(256),
        slicedQuery: createSlicedNodePathQuery(),
        localBoundary: createLocalBoundary(),
        obstacleAvoidanceQuery: createObstacleAvoidanceQuery(32, 32),

        targetReplanTime: 0,
        neighbors: [],
    };
};

export const requestMoveTarget = (
    agent: Agent,
    targetRef: NodeRef,
    targetPos: Vec3,
    navMesh: NavMesh,
    filter: QueryFilter,
): void => {
    agent.targetRef = targetRef;
    vec3.copy(agent.target, targetPos);
    agent.targetState = AgentTargetState.REQUESTING;
    agent.state = AgentState.WALKING;
    agent.targetReplanTime = 0;

    if (agent.corridor.path.length > 0) {
        const status = initSlicedFindNodePath(
            navMesh,
            agent.slicedQuery,
            agent.corridor.path[0],
            targetRef,
            agent.corridor.position,
            targetPos,
            filter,
        );

        if (status & SlicedFindNodePathStatusFlags.SUCCESS) {
            // path found immediately - finalize it
            const finalResult = finalizeSlicedFindNodePath(agent.slicedQuery);
            if (finalResult.status & SlicedFindNodePathStatusFlags.SUCCESS && finalResult.pathCount > 0) {
                setCorridorPath(agent.corridor, targetPos, finalResult.path);
                agent.targetState = AgentTargetState.VALID;
            } else {
                agent.targetState = AgentTargetState.FAILED;
            }
        } else if (status & SlicedFindNodePathStatusFlags.IN_PROGRESS) {
            agent.targetState = AgentTargetState.REQUESTING;
        } else {
            agent.targetState = AgentTargetState.FAILED;
        }
    } else {
        agent.targetState = AgentTargetState.FAILED;
    }
};

const updateAgentPathfinding = (agent: Agent, navMesh: NavMesh): void => {
    if (agent.targetState !== AgentTargetState.REQUESTING) return;

    const maxIterations = 100;
    updateSlicedFindNodePath(navMesh, agent.slicedQuery, maxIterations);

    if (agent.slicedQuery.status & SlicedFindNodePathStatusFlags.SUCCESS) {
        // finalize the path
        const finalResult = finalizeSlicedFindNodePath(agent.slicedQuery);

        if (finalResult.status & SlicedFindNodePathStatusFlags.SUCCESS && finalResult.pathCount > 0) {
            setCorridorPath(agent.corridor, agent.target, finalResult.path);
            agent.targetState = AgentTargetState.VALID;
        } else {
            agent.targetState = AgentTargetState.FAILED;
        }
    } else if (agent.slicedQuery.status & SlicedFindNodePathStatusFlags.FAILURE) {
        agent.targetState = AgentTargetState.FAILED;
    }
};

/**
 * Find neighboring agents within collision query range.
 */
const findNeighbors = (agent: Agent, allAgents: Agent[]): void => {
    agent.neighbors.length = 0;
    const queryRangeSqr = agent.collisionQueryRange * agent.collisionQueryRange;

    for (const other of allAgents) {
        if (other === agent || other.state !== AgentState.WALKING) {
            continue;
        }

        const dx = agent.position[0] - other.position[0];
        const dy = agent.position[1] - other.position[1];
        const dz = agent.position[2] - other.position[2];
        const distSqr = dx * dx + dy * dy + dz * dz;

        if (distSqr < queryRangeSqr) {
            agent.neighbors.push(other);
        }
    }
};

/**
 * Update agent's local boundary.
 */
const updateAgentLocalBoundary = (agent: Agent, navMesh: NavMesh, filter: QueryFilter): void => {
    if (agent.state !== AgentState.WALKING || agent.corridor.path.length === 0) {
        return;
    }

    // update boundary if agent has moved significantly or if boundary is invalid
    const updateThreshold = agent.collisionQueryRange * 0.25;
    const movedDistance = vec3.distance(agent.position, agent.localBoundary.center);

    if (movedDistance > updateThreshold || !isLocalBoundaryValid(agent.localBoundary, navMesh, filter)) {
        updateLocalBoundary(
            agent.localBoundary,
            agent.corridor.path[0],
            agent.position,
            agent.collisionQueryRange,
            navMesh,
            filter,
        );
    }
};

const _direction = vec3.create();

/**
 * Calculate straight steering direction (no anticipation).
 * Steers directly toward the first corner.
 */
const calcStraightSteerDirection = (agent: Agent, corners: Vec3[]): void => {
    if (corners.length === 0) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    const direction = vec3.subtract(_direction, corners[0], agent.position);
    direction[1] = 0; // Keep movement on XZ plane
    vec3.normalize(direction, direction);
    
    const speed = agent.maxSpeed;
    vec3.scale(agent.desiredVelocity, direction, speed);
};

/**
 * Calculate smooth steering direction (with anticipation).
 * Blends between first and second corner for smoother turns.
 */
const calcSmoothSteerDirection = (agent: Agent, corners: Vec3[]): void => {
    if (corners.length === 0) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    const ip0 = 0;
    const ip1 = Math.min(1, corners.length - 1);
    const p0 = corners[ip0];
    const p1 = corners[ip1];

    const dir0 = vec3.subtract(_direction, p0, agent.position);
    const dir1 = vec3.create();
    vec3.subtract(dir1, p1, agent.position);
    dir0[1] = 0;
    dir1[1] = 0;

    const len0 = vec3.length(dir0);
    const len1 = vec3.length(dir1);
    
    if (len1 > 0.001) {
        vec3.scale(dir1, dir1, 1.0 / len1);
    }

    const direction = vec3.create();
    direction[0] = dir0[0] - dir1[0] * len0 * 0.5;
    direction[1] = 0;
    direction[2] = dir0[2] - dir1[2] * len0 * 0.5;
    
    vec3.normalize(direction, direction);
    
    const speed = agent.maxSpeed;
    vec3.scale(agent.desiredVelocity, direction, speed);
};

/**
 * Calculate desired velocity using DetourCrowd-style steering.
 */
const calculateDesiredVelocity = (agent: Agent, navMesh: NavMesh): void => {
    if (agent.state !== AgentState.WALKING || agent.targetState !== AgentTargetState.VALID) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    // get corridor corners for steering
    const cornersResult = findCorridorCorners(agent.corridor, navMesh, 3);

    if (!cornersResult) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    const { corners } = cornersResult;

    const positions = corners.map(corner => corner.position);

    // Use DetourCrowd steering logic
    const anticipateTurns = true; // This could be made configurable like DT_CROWD_ANTICIPATE_TURNS
    
    if (anticipateTurns) {
        calcSmoothSteerDirection(agent, positions);
    } else {
        calcStraightSteerDirection(agent, positions);
    }
};

const OBSTACLE_AVOIDANCE_QUERY_PARAMS: ObstacleAvoidanceParams = {
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
};

/**
 * Perform obstacle avoidance using local boundary and neighbors.
 */
const performObstacleAvoidance = (agent: Agent): void => {
    // reset obstacle query
    resetObstacleAvoidanceQuery(agent.obstacleAvoidanceQuery);

    // add neighboring agents as circular obstacles
    for (const neighbor of agent.neighbors) {
        addCircleObstacle(
            agent.obstacleAvoidanceQuery,
            neighbor.position,
            neighbor.radius,
            neighbor.velocity,
            neighbor.desiredVelocity,
        );
    }

    // add boundary segments as obstacles
    for (const segment of agent.localBoundary.segments) {
        const s = segment.s;
        const p1: Vec3 = [s[0], s[1], s[2]];
        const p2: Vec3 = [s[3], s[4], s[5]];

        // only add segments that are in front of the agent
        const triArea = (agent.position[0] - p1[0]) * (p2[2] - p1[2]) - (agent.position[2] - p1[2]) * (p2[0] - p1[0]);

        if (triArea < 0.0) {
            continue;
        }

        addSegmentObstacle(agent.obstacleAvoidanceQuery, p1, p2);
    }

    // sample safe velocity using adaptive sampling
    sampleVelocityAdaptive(
        agent.obstacleAvoidanceQuery,
        agent.position,
        agent.radius,
        agent.maxSpeed,
        agent.velocity,
        agent.desiredVelocity,
        OBSTACLE_AVOIDANCE_QUERY_PARAMS,
        agent.newVelocity,
    );
};

export const updateAgentMovement = (agent: Agent, navMesh: NavMesh, filter: QueryFilter, deltaTime: number): void => {
    if (agent.state !== AgentState.WALKING) {
        return;
    }

    if (agent.targetState !== AgentTargetState.VALID) {
        return;
    }

    /* update local boundary */
    updateAgentLocalBoundary(agent, navMesh, filter);

    /* calculate desired velocity based on path steering */
    calculateDesiredVelocity(agent, navMesh);

    /* perform obstacle avoidance to get safe velocity */
    performObstacleAvoidance(agent);

    /* use the velocity that considers velocity for movement */
    const finalVelocity = vec3.clone(agent.newVelocity);

    /* integrate movement */
    const movement = vec3.scale([0, 0, 0], finalVelocity, deltaTime);
    const newPos = vec3.add([0, 0, 0], agent.position, movement);

    if (corridorMovePosition(agent.corridor, newPos, navMesh, filter)) {
        // update agent position and velocity
        vec3.copy(agent.position, agent.corridor.position);
        vec3.copy(agent.velocity, finalVelocity);
    } else {
        // if corridor movement fails, stop the agent
        vec3.set(agent.velocity, 0, 0, 0);
        vec3.set(agent.newVelocity, 0, 0, 0);
    }

    /* check if we reached the target */
    const finalTargetDistance = vec3.distance(agent.position, agent.corridor.target);

    if (finalTargetDistance < 0.1) {
        agent.targetState = AgentTargetState.NONE;
        agent.state = AgentState.WAITING;
        vec3.set(agent.velocity, 0, 0, 0);
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        vec3.set(agent.newVelocity, 0, 0, 0);
    }
};

/**
 * Update multiple agents
 */
export const updateAgents = (agents: Agent[], navMesh: NavMesh, filter: QueryFilter, deltaTime: number): void => {
    for (const agent of agents) {
        findNeighbors(agent, agents);
    }

    for (const agent of agents) {
        updateAgentPathfinding(agent, navMesh);
        updateAgentMovement(agent, navMesh, filter, deltaTime);
    }
};
