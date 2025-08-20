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
import {
    corridorMovePosition,
    createPathCorridor,
    findCorridorCorners,
    type PathCorridor,
    setCorridorPath,
} from './path-corridor';
import { createLocalBoundary, isLocalBoundaryValid, type LocalBoundary, updateLocalBoundary } from './local-boundary';
import { addCircleObstacle, addSegmentObstacle, createObstacleAvoidanceQuery, type ObstacleAvoidanceQuery, resetObstacleAvoidanceQuery, sampleVelocityAdaptive } from './obstacle-avoidance';

/* basic agent movement */

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

export const createAgent = (id: string, position: Vec3, maxSpeed: number, radius: number): Agent => {
    return {
        id,

        position: vec3.clone(position),
        velocity: [0, 0, 0],
        desiredVelocity: [0, 0, 0],
        newVelocity: [0, 0, 0],
        maxSpeed,
        radius,
        collisionQueryRange: radius * 8, // Default collision query range
        
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

export const updateAgentPathfinding = (agent: Agent, navMesh: NavMesh): void => {
    if (agent.targetState !== AgentTargetState.REQUESTING) return;

    const maxIterations = 100;
    const result = updateSlicedFindNodePath(navMesh, agent.slicedQuery, maxIterations);

    if (result.status & SlicedFindNodePathStatusFlags.SUCCESS) {
        // finalize the path
        const finalResult = finalizeSlicedFindNodePath(agent.slicedQuery);

        if (finalResult.status & SlicedFindNodePathStatusFlags.SUCCESS && finalResult.pathCount > 0) {
            setCorridorPath(agent.corridor, agent.target, finalResult.path);
            agent.targetState = AgentTargetState.VALID;
        } else {
            agent.targetState = AgentTargetState.FAILED;
        }
    } else if (result.status & SlicedFindNodePathStatusFlags.FAILURE) {
        agent.targetState = AgentTargetState.FAILED;
    }
};

/**
 * Find neighboring agents within collision query range.
 */
export const findNeighbors = (agent: Agent, allAgents: Agent[]): void => {
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
export const updateAgentBoundary = (agent: Agent, navMesh: NavMesh, filter: QueryFilter): void => {
    if (agent.state !== AgentState.WALKING || agent.corridor.path.length === 0) {
        return;
    }

    // Update boundary if agent has moved significantly or if boundary is invalid
    const updateThreshold = agent.collisionQueryRange * 0.25;
    const movedDistance = vec3.distance(agent.position, agent.localBoundary.center);
    
    if (movedDistance > updateThreshold || !isLocalBoundaryValid(agent.localBoundary, navMesh, filter)) {
        updateLocalBoundary(
            agent.localBoundary,
            agent.corridor.path[0],
            agent.position,
            agent.collisionQueryRange,
            navMesh,
            filter
        );
    }
};

/**
 * Calculate desired velocity using DetourCrowd-style steering.
 */
export const calculateDesiredVelocity = (agent: Agent, navMesh: NavMesh): void => {
    if (agent.state !== AgentState.WALKING || agent.targetState !== AgentTargetState.VALID) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    // Get corridor corners for steering
    const corners = findCorridorCorners(agent.corridor, navMesh, 10);

    if (corners.length === 0) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    // DetourCrowd-style corner selection with anticipation
    let targetCorner: Vec3 | null = null;

    const MIN_TARGET_DISTANCE = 0.1;
    const ANTICIPATION_DISTANCE = agent.radius * 4;

    // Find the best corner to target using DetourCrowd's anticipation logic
    for (let i = 0; i < corners.length; i++) {
        const corner = corners[i];
        const dist = vec3.distance(agent.position, corner);

        if (dist < MIN_TARGET_DISTANCE) {
            continue;
        }

        if (!targetCorner) {
            targetCorner = corner;

            // Try to anticipate - if this corner is close, see if we can target a further one
            if (dist < ANTICIPATION_DISTANCE && i + 1 < corners.length) {
                const nextCorner = corners[i + 1];
                const nextDist = vec3.distance(agent.position, nextCorner);

                if (nextDist > MIN_TARGET_DISTANCE) {
                    targetCorner = nextCorner;
                }
            }
            break;
        }
    }

    // If no valid corner found, use the final target
    if (!targetCorner) {
        targetCorner = agent.corridor.target;
    }

    // Calculate steering direction
    const direction = vec3.subtract([0, 0, 0], targetCorner, agent.position);
    direction[1] = 0; // Keep movement on XZ plane

    const dirLength = vec3.length(direction);
    if (dirLength > 0.001) {
        vec3.scale(direction, direction, 1.0 / dirLength);

        // Calculate speed scale for slowdown near target
        const slowDownRadius = agent.radius * 2;
        const finalTargetDistance = vec3.distance(agent.position, agent.corridor.target);
        const speedScale = Math.min(1.0, finalTargetDistance / slowDownRadius);

        const speed = agent.maxSpeed * Math.max(0.1, speedScale); // Minimum 10% speed
        vec3.scale(agent.desiredVelocity, direction, speed);
    } else {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
    }
};

/**
 * Perform obstacle avoidance using local boundary and neighbors.
 */
export const performObstacleAvoidance = (agent: Agent): void => {
    // Reset obstacle query
    resetObstacleAvoidanceQuery(agent.obstacleAvoidanceQuery);

    // Add neighboring agents as circular obstacles
    for (const neighbor of agent.neighbors) {
        addCircleObstacle(
            agent.obstacleAvoidanceQuery,
            neighbor.position,
            neighbor.radius,
            neighbor.velocity,
            neighbor.desiredVelocity
        );
    }

    // Add boundary segments as obstacles
    for (const segment of agent.localBoundary.segments) {
        const s = segment.s;
        const p1: Vec3 = [s[0], s[1], s[2]];
        const p2: Vec3 = [s[3], s[4], s[5]];
        
        // Only add segments that are in front of the agent (DetourCrowd logic)
        const triArea = (agent.position[0] - p1[0]) * (p2[2] - p1[2]) - (agent.position[2] - p1[2]) * (p2[0] - p1[0]);
        if (triArea < 0.0) {
            continue;
        }
        
        addSegmentObstacle(agent.obstacleAvoidanceQuery, p1, p2);
    }

    // Sample safe velocity using adaptive sampling
    const params = {
        velBias: 0.4,
        weightDesVel: 2.0,
        weightCurVel: 0.75,
        weightSide: 0.75,
        weightToi: 2.5,
        horizTime: 2.5,
        gridSize: 33,
        adaptiveDivs: 7,
        adaptiveRings: 2,
        adaptiveDepth: 5,
    };

    const result = sampleVelocityAdaptive(
        agent.obstacleAvoidanceQuery,
        agent.position,
        agent.radius,
        agent.maxSpeed,
        agent.velocity,
        agent.desiredVelocity,
        params
    );

    vec3.copy(agent.newVelocity, result.nvel);
};

export const updateAgentMovement = (agent: Agent, navMesh: NavMesh, filter: QueryFilter, deltaTime: number): void => {
    if (agent.state !== AgentState.WALKING) {
        return;
    }

    if (agent.targetState !== AgentTargetState.VALID) {
        return;
    }

    // Step 1: Update local boundary (DetourCrowd does this first)
    updateAgentBoundary(agent, navMesh, filter);

    // Step 2: Calculate desired velocity based on path steering
    calculateDesiredVelocity(agent, navMesh);

    // Step 3: Perform obstacle avoidance to get safe velocity
    performObstacleAvoidance(agent);

    // Step 4: Use the obstacle-avoided velocity for movement
    const finalVelocity = vec3.clone(agent.newVelocity);

    // Step 5: Integrate movement
    const movement = vec3.scale([0, 0, 0], finalVelocity, deltaTime);
    const newPos = vec3.add([0, 0, 0], agent.position, movement);

    if (corridorMovePosition(agent.corridor, newPos, navMesh, filter)) {
        // Update agent position and velocity
        vec3.copy(agent.position, agent.corridor.position);
        vec3.copy(agent.velocity, finalVelocity);
    } else {
        // If corridor movement fails, stop the agent
        vec3.set(agent.velocity, 0, 0, 0);
        vec3.set(agent.newVelocity, 0, 0, 0);
    }

    // Step 6: Check if reached target
    const finalTargetDistance = vec3.distance(agent.position, agent.corridor.target);
    if (finalTargetDistance < 0.5) {
        agent.targetState = AgentTargetState.NONE;
        agent.state = AgentState.WAITING;
        vec3.set(agent.velocity, 0, 0, 0);
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        vec3.set(agent.newVelocity, 0, 0, 0);
    }
};

/**
 * Update multiple agents following DetourCrowd pattern.
 * This should be called instead of individual updateAgentMovement calls for proper multi-agent simulation.
 */
export const updateAgents = (agents: Agent[], navMesh: NavMesh, filter: QueryFilter, deltaTime: number): void => {
    // Step 1: Find neighbors for all walking agents (DetourCrowd pattern)
    const walkingAgents = agents.filter(agent => agent.state === AgentState.WALKING);
    
    for (const agent of walkingAgents) {
        findNeighbors(agent, walkingAgents);
    }

    // Step 2: Update movement for all agents
    for (const agent of agents) {
        updateAgentMovement(agent, navMesh, filter, deltaTime);
    }
};
