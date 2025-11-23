import { type Vec3, vec2, vec3 } from 'mathcat';
import {
    createFindNearestPolyResult,
    createGetClosestPointOnPolyResult,
    createSlicedNodePathQuery,
    finalizeSlicedFindNodePath,
    finalizeSlicedFindNodePathPartial,
    findNearestPoly,
    getClosestPointOnPoly,
    INVALID_NODE_REF,
    initSlicedFindNodePath,
    isValidNodeRef,
    type NavMesh,
    type NodeRef,
    NodeType,
    type QueryFilter,
    SlicedFindNodePathStatusFlags,
    type SlicedNodePathQuery,
    type StraightPathPoint,
    StraightPathPointFlags,
    updateSlicedFindNodePath,
} from 'navcat';
import * as localBoundary from './local-boundary';
import * as obstacleAvoidance from './obstacle-avoidance';
import * as pathCorridor from './path-corridor';

export enum AgentState {
    INVALID,
    WALKING,
    OFFMESH,
}

export enum AgentTargetState {
    NONE,
    FAILED,
    VALID,
    REQUESTING,
    WAITING_FOR_QUEUE,
    WAITING_FOR_PATH,
    VELOCITY,
}

export enum CrowdUpdateFlags {
    ANTICIPATE_TURNS = 1,
    OBSTACLE_AVOIDANCE = 2,
    SEPARATION = 4,
    OPTIMIZE_VIS = 8,
    OPTIMIZE_TOPO = 16,
}

export type AgentParams = {
    /** Agent radius (in world units), used for collision detection and avoidance calculations */
    radius: number;

    /** Agent height (in world units), used for visualization and spatial queries */
    height: number;

    /** Maximum acceleration (in world units per second squared), controls how quickly an agent can change velocity. */
    maxAcceleration: number;

    /** Maximum speed (in world units per second), the agent will not exceed this speed. */
    maxSpeed: number;

    /** Collision query range (in world units), determines how far to look for neighboring agents and obstacles. */
    collisionQueryRange: number;

    /**
     * Path visibility optimization range (in world units), the maximum distance to raycast for path shortcuts.
     * @default radius * 30.0
     */
    pathOptimizationRange?: number;

    /** Separation weight, controls the strength of separation behavior from other agents, only applied when the flag CrowdUpdateFlags.SEPARATION is given */
    separationWeight: number;

    /**
     * Flags that control agent behavior
     * @see CrowdUpdateFlags
     */
    updateFlags: number;

    /** Query filter used for navmesh queries, determines which polygons the agent can traverse and the cost of traversal */
    queryFilter: QueryFilter;

    /**
     * Obstacle avoidance parameters, configures the adaptive sampling algorithm for velocity planning
     * @default @see DEFAULT_OBSTACLE_AVOIDANCE_PARAMS
     **/
    obstacleAvoidance?: obstacleAvoidance.ObstacleAvoidanceParams;

    /**
     * If true, agents will automatically traverse off-mesh connections with a linear interpolation.
     * If false, the agent will enter OFFMESH state and populate offMeshAnimation data,
     * but the animation must be implemented externally, and completeOffMeshConnection must be called when done.
     * @default true
     */
    autoTraverseOffMeshConnections?: boolean;

    /**
     * Whether to collect debug data for obstacle avoidance visualization.
     * @default false
     */
    debugObstacleAvoidance?: boolean;
};

/** Sensible default obstacle avoidance parameters */
export const DEFAULT_OBSTACLE_AVOIDANCE_PARAMS: obstacleAvoidance.ObstacleAvoidanceParams = {
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

export type Agent = {
    /** The agent radius */
    radius: number;

    /** The agent height */
    height: number;

    /** The agent maximum acceleration */
    maxAcceleration: number;

    /** The agent maximum speed */
    maxSpeed: number;

    /** The agent collision query range */
    collisionQueryRange: number;

    /** The agent path visibility optimization range */
    pathOptimizationRange: number;

    /** The agent separation weight */
    separationWeight: number;

    /** The agent update flags */
    updateFlags: number;

    /** The agent query filter */
    queryFilter: QueryFilter;

    /** The agent obstacle avoidance parameters */
    obstacleAvoidance: obstacleAvoidance.ObstacleAvoidanceParams;

    /** Whether the agent automatically traverses off-mesh connections */
    autoTraverseOffMeshConnections: boolean;

    /** The current state of the agent */
    state: AgentState;

    /** Path corridor for navigation */
    corridor: pathCorridor.PathCorridor;

    /** Local boundary for obstacle avoidance */
    boundary: localBoundary.LocalBoundary;

    /** Sliced pathfinding query state */
    slicedQuery: SlicedNodePathQuery;

    /** Obstacle avoidance query for velocity planning */
    obstacleAvoidanceQuery: obstacleAvoidance.ObstacleAvoidanceQuery;

    /** Debug data for obstacle avoidance visualization */
    obstacleAvoidanceDebugData: obstacleAvoidance.ObstacleAvoidanceDebugData | undefined;

    /** Neighboring agents within collision query range */
    neis: Array<{ agentId: string; dist: number }>;

    /** Steering corners extracted from the corridor */
    corners: StraightPathPoint[];

    /** Current position in world space */
    position: Vec3;

    /** Desired speed magnitude */
    desiredSpeed: number;

    /** Desired velocity from steering */
    desiredVelocity: Vec3;

    /** Planned velocity after obstacle avoidance */
    newVelocity: Vec3;

    /** Current velocity */
    velocity: Vec3;

    /** Displacement vector for collision resolution */
    displacement: Vec3;

    /** @see AgentTargetState */
    targetState: number;

    /** Target polygon reference */
    targetRef: NodeRef | null;

    /** Target position */
    targetPosition: Vec3;

    /** Whether the agent needs to replan its path to the target */
    targetReplan: boolean;

    /** Time spent pathfinding to current target */
    targetPathfindingTime: number;

    /** True if pathfinding returned a partial result (best-effort path) */
    targetPathIsPartial: boolean;

    /** Time since last topology optimization (seconds) */
    topologyOptTime: number;

    /** Off-mesh connection animation state (null when not traversing an off-mesh connection) */
    offMeshAnimation: {
        t: number;
        startPosition: Vec3;
        endPosition: Vec3;
        nodeRef: NodeRef;
        duration: number;
    } | null;
};

export type Crowd = {
    agents: Record<string, Agent>;
    agentIdCounter: number;
    maxAgentRadius: number;
    agentPlacementHalfExtents: Vec3;

    /**
     * Maximum pathfinding iterations distributed across all agents per update.
     * Higher values allow more agents to complete pathfinding faster but increase CPU cost.
     * @default 600
     */
    maxIterationsPerUpdate: number;

    /**
     * Maximum pathfinding iterations per agent per update.
     * Limits how much CPU time a single agent can consume.
     * @default 200
     */
    maxIterationsPerAgent: number;

    /**
     * Initial quick search iterations when pathfinding request starts.
     * Helps find short paths immediately, and is used as the initial partial corridor to
     * start moving towards the target while the full path is still being computed.
     * @default 20
     */
    quickSearchIterations: number;
};

/**
 * Creates a new crowd
 * @param maxAgentRadius the maximum agent radius in the crowd
 * @returns the created crowd
 */
export const create = (maxAgentRadius: number): Crowd => {
    return {
        agents: {},
        agentIdCounter: 0,
        maxAgentRadius,
        agentPlacementHalfExtents: [maxAgentRadius, maxAgentRadius, maxAgentRadius],
        maxIterationsPerUpdate: 600,
        maxIterationsPerAgent: 200,
        quickSearchIterations: 20,
    };
};

/**
 * Adds an agent to the crowd.
 * @param crowd the crowd
 * @param position the initial position of the agent
 * @param agentParams the parameters for the agent
 * @returns the ID of the added agent
 */
export const addAgent = (crowd: Crowd, navMesh: NavMesh, position: Vec3, agentParams: AgentParams): string => {
    const agentId = String(crowd.agentIdCounter++);

    const agent: Agent = {
        radius: agentParams.radius,
        height: agentParams.height,
        maxAcceleration: agentParams.maxAcceleration,
        maxSpeed: agentParams.maxSpeed,
        collisionQueryRange: agentParams.collisionQueryRange,
        pathOptimizationRange: agentParams.pathOptimizationRange ?? agentParams.radius * 30.0,
        separationWeight: agentParams.separationWeight,
        updateFlags: agentParams.updateFlags,
        queryFilter: agentParams.queryFilter,
        obstacleAvoidance: agentParams.obstacleAvoidance ?? DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
        autoTraverseOffMeshConnections: agentParams.autoTraverseOffMeshConnections ?? true,
        state: AgentState.WALKING,
        corridor: pathCorridor.create(),
        slicedQuery: createSlicedNodePathQuery(),
        boundary: localBoundary.create(),
        obstacleAvoidanceQuery: obstacleAvoidance.createObstacleAvoidanceQuery(32, 32),
        obstacleAvoidanceDebugData: agentParams.debugObstacleAvoidance
            ? obstacleAvoidance.createObstacleAvoidanceDebugData()
            : undefined,

        neis: [],

        corners: [],

        position,
        desiredSpeed: 0,
        desiredVelocity: [0, 0, 0],
        newVelocity: [0, 0, 0],
        velocity: [0, 0, 0],
        displacement: [0, 0, 0],

        targetState: AgentTargetState.NONE,
        targetRef: null,
        targetPosition: [0, 0, 0],
        targetReplan: false,
        targetPathfindingTime: 0,
        targetPathIsPartial: false,

        topologyOptTime: 0,

        offMeshAnimation: null,
    };

    crowd.agents[agentId] = agent;

    // find nearest position on navmesh and place the agent there
    const nearestPolyResult = createFindNearestPolyResult();
    findNearestPoly(nearestPolyResult, navMesh, position, crowd.agentPlacementHalfExtents, agent.queryFilter);

    let nearestPos = position;
    let nearestRef = INVALID_NODE_REF;

    if (nearestPolyResult.success) {
        nearestPos = nearestPolyResult.position;
        nearestRef = nearestPolyResult.nodeRef;
    }

    // reset corridor with the found (or invalid) reference
    vec3.copy(agent.position, nearestPos);
    pathCorridor.reset(agent.corridor, nearestRef, nearestPos);

    // set agent state based on whether we found a valid polygon
    if (nearestRef !== INVALID_NODE_REF) {
        agent.state = AgentState.WALKING;
    } else {
        agent.state = AgentState.INVALID;
    }

    return agentId;
};

/**
 * Removes an agent from the crowd.
 * @param crowd the crowd
 * @param agentId the ID of the agent
 * @returns true if the agent was removed, false otherwise
 */
export const removeAgent = (crowd: Crowd, agentId: string): boolean => {
    if (crowd.agents[agentId]) {
        delete crowd.agents[agentId];
        return true;
    }
    return false;
};

/**
 * Requests a move target for an agent.
 * @param crowd the crowd
 * @param agentId the ID of the agent
 * @param targetRef the target reference
 * @param targetPos the target position
 * @returns true if the move target was set, false otherwise
 */
export const requestMoveTarget = (crowd: Crowd, agentId: string, targetRef: NodeRef, targetPos: Vec3): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    agent.targetRef = targetRef;
    vec3.copy(agent.targetPosition, targetPos);

    // if the agent already has a corridor path, this is a replan
    agent.targetReplan = false;
    agent.targetState = AgentTargetState.REQUESTING;
    agent.targetPathIsPartial = false;
    agent.targetPathfindingTime = 0; // Reset timer for new request

    return true;
};

const requestMoveTargetReplan = (crowd: Crowd, agentId: string, targetRef: NodeRef | null, targetPos: Vec3): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    agent.targetRef = targetRef;
    vec3.copy(agent.targetPosition, targetPos);

    agent.targetReplan = true;
    agent.targetState = AgentTargetState.REQUESTING;

    return true;
};

/**
 * Request a move velocity for an agent.
 * @param crowd the crowd
 * @param agentId the ID of the agent
 * @param velocity the desired velocity
 * @returns true if the move velocity was set, false otherwise
 */
export const requestMoveVelocity = (crowd: Crowd, agentId: string, velocity: Vec3): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    vec3.copy(agent.targetPosition, velocity);
    agent.targetState = AgentTargetState.VELOCITY;
    agent.targetReplan = false;
    agent.targetRef = INVALID_NODE_REF;

    return true;
};

/**
 * Reset the move target for an agent.
 * @param crowd the crowd
 * @param agentId the ID of the agent
 * @returns true if the move target was reset, false otherwise
 */
export const resetMoveTarget = (crowd: Crowd, agentId: string): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    agent.targetRef = null;
    vec3.set(agent.targetPosition, 0, 0, 0);
    vec3.set(agent.desiredVelocity, 0, 0, 0);
    agent.targetReplan = false;
    agent.targetState = AgentTargetState.NONE;
    agent.targetPathIsPartial = false;

    return true;
};

const CHECK_LOOKAHEAD = 10;
const TARGET_REPLAN_DELAY_SECONDS = 1.0;

const _checkPathValidityNearestPolyResult = createFindNearestPolyResult();

const checkPathValidity = (crowd: Crowd, navMesh: NavMesh, deltaTime: number): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (agent.state !== AgentState.WALKING) continue;

        agent.targetPathfindingTime += deltaTime;

        let replan = false;

        // first check that the current location is valid
        const agentNodeRef = agent.corridor.path[0];

        if (!isValidNodeRef(navMesh, agentNodeRef)) {
            // current location is invalid, try to reposition
            console.warn(`Agent ${agentId} has invalid current node ref, repositioning`, {
                agentNodeRef,
                corridorPath: agent.corridor.path,
                corridorPosition: agent.corridor.position,
                agentPosition: agent.position,
                velocity: agent.velocity,
                state: agent.state,
                targetState: agent.targetState,
            });

            const nearestPolyResult = findNearestPoly(
                _checkPathValidityNearestPolyResult,
                navMesh,
                agent.position,
                crowd.agentPlacementHalfExtents,
                agent.queryFilter,
            );

            if (!nearestPolyResult.success) {
                // could not find location in navmesh, set agent state to invalid
                console.error(`Agent ${agentId} could not find valid position on navmesh, marking as INVALID`);
                agent.state = AgentState.INVALID;
                pathCorridor.reset(agent.corridor, INVALID_NODE_REF, agent.position);
                localBoundary.resetLocalBoundary(agent.boundary);

                continue;
            }

            // Fix: Use nearestPolyResult.position (which is ON the navmesh) instead of agent.position
            pathCorridor.fixPathStart(agent.corridor, nearestPolyResult.nodeRef, nearestPolyResult.position);
            localBoundary.resetLocalBoundary(agent.boundary);
            vec3.copy(agent.position, nearestPolyResult.position);

            replan = true;
        }

        // if the agent doesn't have a move target, or is controlled by velocity, no need to recover the target or replan
        if (agent.targetState === AgentTargetState.NONE || agent.targetState === AgentTargetState.VELOCITY) {
            continue;
        }

        // try to recover move request position
        if (agent.targetState !== AgentTargetState.NONE && agent.targetState !== AgentTargetState.FAILED) {
            if (
                agent.targetRef === null ||
                !isValidNodeRef(navMesh, agent.targetRef) ||
                !agent.queryFilter.passFilter(agent.targetRef, navMesh)
            ) {
                // current target is not valid, try to reposition
                const nearestPolyResult = findNearestPoly(
                    _checkPathValidityNearestPolyResult,
                    navMesh,
                    agent.targetPosition,
                    crowd.agentPlacementHalfExtents,
                    agent.queryFilter,
                );

                if (!nearestPolyResult.success) {
                    // could not find location in navmesh, set agent state to invalid
                    agent.targetState = AgentTargetState.NONE;
                    agent.targetRef = null;
                    pathCorridor.reset(agent.corridor, INVALID_NODE_REF, agent.position);
                } else {
                    // target poly became invalid, update to nearest valid poly
                    agent.targetRef = nearestPolyResult.nodeRef;
                    vec3.copy(agent.targetPosition, nearestPolyResult.position);
                    replan = true;
                }
            }
        }

        // if nearby corridor is not valid, replan
        const corridorValid = pathCorridor.corridorIsValid(agent.corridor, CHECK_LOOKAHEAD, navMesh, agent.queryFilter);
        if (!corridorValid) {
            replan = true;
        }

        // if the end of the path is near and it is not the requested location, replan
        if (agent.targetState === AgentTargetState.VALID) {
            if (
                agent.targetPathfindingTime > TARGET_REPLAN_DELAY_SECONDS &&
                agent.corridor.path.length < CHECK_LOOKAHEAD &&
                agent.corridor.path[agent.corridor.path.length - 1] !== agent.targetRef
            ) {
                replan = true;
            }
        }

        // try to replan path to goal
        if (replan && agent.targetState !== AgentTargetState.NONE) {
            requestMoveTargetReplan(crowd, agentId, agent.targetRef, agent.targetPosition);
        }
    }
};

const updateMoveRequests = (crowd: Crowd, navMesh: NavMesh, deltaTime: number): void => {
    // first, update pathfinding time for all agents in WAITING_FOR_PATH state
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        if (agent.targetState === AgentTargetState.WAITING_FOR_PATH) {
            agent.targetPathfindingTime += deltaTime;
        }
    }

    // collect all agents that need pathfinding processing
    const pathfindingAgents: string[] = [];

    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (
            agent.state === AgentState.INVALID ||
            agent.targetState === AgentTargetState.NONE ||
            agent.targetState === AgentTargetState.VELOCITY ||
            agent.targetRef === null
        ) {
            continue;
        }

        if (agent.targetState === AgentTargetState.REQUESTING) {
            // init the pathfinding query and state
            initSlicedFindNodePath(
                navMesh,
                agent.slicedQuery,
                agent.corridor.path[0],
                agent.targetRef,
                agent.position,
                agent.targetPosition,
                agent.queryFilter,
            );

            // quick search
            updateSlicedFindNodePath(navMesh, agent.slicedQuery, crowd.quickSearchIterations);

            // finalize the partial path from quick search
            const partialResult = agent.targetReplan
                ? finalizeSlicedFindNodePathPartial(navMesh, agent.slicedQuery, agent.corridor.path)
                : finalizeSlicedFindNodePath(navMesh, agent.slicedQuery);

            const reqPath = partialResult.path;
            const reqPathCount = reqPath.length;
            let reqPos = vec3.clone(agent.targetPosition);

            // if we got a path from the quick search
            if (reqPathCount > 0) {
                // check if this is a partial path (didn't reach target)
                if (reqPath[reqPathCount - 1] !== agent.targetRef) {
                    // partial path - constrain target position inside the last polygon
                    const closestPointResult = createGetClosestPointOnPolyResult();
                    const closestPoint = getClosestPointOnPoly(
                        closestPointResult,
                        navMesh,
                        reqPath[reqPathCount - 1],
                        agent.targetPosition,
                    );

                    if (closestPoint.success) {
                        reqPos = closestPoint.position;
                    } else {
                        // failed to constrain position, fall back to current position
                        reqPos = vec3.clone(agent.position);
                        reqPath[0] = agent.corridor.path[0];
                        reqPath.length = 1;
                    }
                }
            } else {
                // could not find any path, start the request from current location
                reqPos = vec3.clone(agent.position);
                reqPath[0] = agent.corridor.path[0];
                reqPath.length = 1;
            }

            // immediately set the corridor with the partial path
            pathCorridor.setPath(agent.corridor, reqPos, reqPath);
            localBoundary.resetLocalBoundary(agent.boundary);
            agent.targetPathIsPartial = false;

            // check if we reached the target with the quick search
            if (reqPathCount > 0 && reqPath[reqPathCount - 1] === agent.targetRef) {
                // reached target - we're done!
                agent.targetState = AgentTargetState.VALID;
                agent.targetPathfindingTime = 0;
            } else {
                // partial path - queue for full pathfinding
                agent.targetState = AgentTargetState.WAITING_FOR_QUEUE;
            }
        }
    }

    // process agents in WAITING_FOR_QUEUE - transition all waiting agents to full pathfinding
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (agent.targetState === AgentTargetState.WAITING_FOR_QUEUE) {
            // initialize the full pathfinding query once when entering WAITING_FOR_PATH
            // start from the last polygon in the corridor (where partial path ended)
            const corridorPath = agent.corridor.path;
            const startRef = corridorPath[corridorPath.length - 1];

            initSlicedFindNodePath(
                navMesh,
                agent.slicedQuery,
                startRef,
                agent.targetRef!,
                agent.corridor.target,
                agent.targetPosition,
                agent.queryFilter,
            );

            agent.targetState = AgentTargetState.WAITING_FOR_PATH;
            pathfindingAgents.push(agentId);
        } else if (agent.targetState === AgentTargetState.WAITING_FOR_PATH) {
            pathfindingAgents.push(agentId);
        }
    }

    // sort agents by targetReplanTime (longest waiting gets priority)
    pathfindingAgents.sort((a, b) => crowd.agents[b].targetPathfindingTime - crowd.agents[a].targetPathfindingTime);

    // distribute global iteration budget across prioritized agents
    let remainingIterations = crowd.maxIterationsPerUpdate;

    for (const agentId of pathfindingAgents) {
        const agent = crowd.agents[agentId];

        if ((agent.slicedQuery.status & SlicedFindNodePathStatusFlags.IN_PROGRESS) !== 0 && remainingIterations > 0) {
            // allocate iterations for this agent (minimum 1, maximum remaining)
            const iterationsForAgent = Math.min(crowd.maxIterationsPerAgent, remainingIterations);

            const iterationsPerformed = updateSlicedFindNodePath(navMesh, agent.slicedQuery, iterationsForAgent);
            remainingIterations -= iterationsPerformed;
        }

        if ((agent.slicedQuery.status & SlicedFindNodePathStatusFlags.FAILURE) !== 0) {
            // pathfinding failed
            agent.targetState = AgentTargetState.FAILED;
            agent.targetPathfindingTime = 0;
            agent.targetPathIsPartial = false;
        } else if ((agent.slicedQuery.status & SlicedFindNodePathStatusFlags.SUCCESS) !== 0) {
            // pathfinding succeeded - now we need to merge the result with the current corridor

            // check if this is a partial path (best effort)
            agent.targetPathIsPartial = (agent.slicedQuery.status & SlicedFindNodePathStatusFlags.PARTIAL_RESULT) !== 0;

            const result = finalizeSlicedFindNodePath(navMesh, agent.slicedQuery);
            const newPath = result.path;

            const currentPath = agent.corridor.path;
            const currentPathCount = currentPath.length;

            let valid = true;
            let targetPos = vec3.clone(agent.targetPosition);

            // the agent might have moved whilst the pathfinding request was being processed,
            // so the path may have changed. We assume that the end of the current path is at
            // the same location where the pathfinding request was issued.

            // the last polygon in the current corridor should be the same as the first polygon
            // in the new pathfinding result.
            if (currentPathCount > 0 && newPath.length > 0) {
                if (currentPath[currentPathCount - 1] !== newPath[0]) {
                    valid = false;
                }
            }

            if (valid) {
                let mergedPath: number[] = [];

                // merge the current corridor path with the new pathfinding result
                if (currentPathCount > 1) {
                    // copy the current path (excluding the last polygon, which is the start of the new path)
                    mergedPath = currentPath.slice(0, currentPathCount - 1);

                    // append the new path
                    mergedPath.push(...newPath);

                    // remove trackbacks (A -> B -> A sequences)
                    for (let j = 0; j < mergedPath.length; j++) {
                        if (j - 1 >= 0 && j + 1 < mergedPath.length) {
                            if (mergedPath[j - 1] === mergedPath[j + 1]) {
                                // found a trackback: remove the middle and next element
                                mergedPath.splice(j - 1, 2);
                                j -= 2;
                            }
                        }
                    }
                } else {
                    // current path is just the start polygon, use the new path directly
                    mergedPath = [...newPath];
                }

                // check if this is a partial path - constrain target position if needed
                if (mergedPath.length > 0 && mergedPath[mergedPath.length - 1] !== agent.targetRef) {
                    // partial path - constrain target position to the last polygon
                    const lastPoly = mergedPath[mergedPath.length - 1];
                    const closestPointResult = createGetClosestPointOnPolyResult();
                    const closestPoint = getClosestPointOnPoly(closestPointResult, navMesh, lastPoly, agent.targetPosition);

                    if (closestPoint.success) {
                        targetPos = closestPoint.position;
                    } else {
                        valid = false;
                    }
                }

                if (valid) {
                    pathCorridor.setPath(agent.corridor, targetPos, mergedPath);
                    localBoundary.resetLocalBoundary(agent.boundary);
                    agent.targetState = AgentTargetState.VALID;
                    agent.targetPathfindingTime = 0; // Reset on success
                } else {
                    // something went wrong with constraining the target position
                    // retry if target is still valid
                    if (agent.targetRef !== null) {
                        agent.targetState = AgentTargetState.REQUESTING;
                        // Keep targetPathfindingTime so agent maintains priority when retrying
                    } else {
                        agent.targetState = AgentTargetState.FAILED;
                        agent.targetPathfindingTime = 0; // Reset on failure
                    }
                }
            } else {
                // paths don't connect - the agent has moved too far from where pathfinding started
                // retry pathfinding from the new position if target is still valid
                if (agent.targetRef !== null) {
                    agent.targetState = AgentTargetState.REQUESTING;
                    // keep targetPathfindingTime so agent maintains priority when retrying
                } else {
                    agent.targetState = AgentTargetState.FAILED;
                    agent.targetPathfindingTime = 0; // Reset on failure
                }
            }
        }
    }
};

const updateNeighbours = (crowd: Crowd): void => {
    // uniform grid spatial partitioning, rebuilt each frame

    // find bounds and determine max query range
    let minX = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxZ = -Infinity;
    let maxQueryRange = 0;

    const agentIds: string[] = [];

    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        agent.neis.length = 0;

        if (agent.state !== AgentState.WALKING) continue;

        agentIds.push(agentId);

        const x = agent.position[0];
        const z = agent.position[2];

        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);

        maxQueryRange = Math.max(maxQueryRange, agent.collisionQueryRange);
    }

    if (agentIds.length === 0) return;

    // grid cell size = max query range (each agent checks its cell + surrounding 8 cells)
    const cellSize = maxQueryRange;
    if (cellSize < 0.01) return; // safety check

    const gridWidth = Math.ceil((maxX - minX) / cellSize) + 1;
    const gridHeight = Math.ceil((maxZ - minZ) / cellSize) + 1;

    // build grid - flat array with direct indexing (faster than Map)
    const gridSize = gridWidth * gridHeight;
    const grid: (string[] | undefined)[] = new Array(gridSize);

    // insert agents into grid
    for (const agentId of agentIds) {
        const agent = crowd.agents[agentId];

        const x = agent.position[0];
        const z = agent.position[2];
        const ix = Math.floor((x - minX) / cellSize);
        const iz = Math.floor((z - minZ) / cellSize);
        const key = iz * gridWidth + ix;

        let cell = grid[key];
        if (!cell) {
            cell = [];
            grid[key] = cell;
        }
        cell.push(agentId);
    }

    // query neighbors using grid
    for (const agentId of agentIds) {
        const agent = crowd.agents[agentId];
        const queryRangeSqr = agent.collisionQueryRange * agent.collisionQueryRange;

        const x = agent.position[0];
        const z = agent.position[2];
        const ix = Math.floor((x - minX) / cellSize);
        const iz = Math.floor((z - minZ) / cellSize);

        // check 3x3 grid around agent (including own cell)
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                const checkZ = iz + dz;
                const checkX = ix + dx;

                if (checkX < 0 || checkX >= gridWidth || checkZ < 0 || checkZ >= gridHeight) continue;

                const cellKey = checkZ * gridWidth + checkX;
                const cell = grid[cellKey];

                if (!cell) continue;

                for (const otherAgentId of cell) {
                    if (otherAgentId === agentId) continue;

                    const other = crowd.agents[otherAgentId];

                    const dx = agent.position[0] - other.position[0];
                    const dy = agent.position[1] - other.position[1];
                    const dz = agent.position[2] - other.position[2];
                    const distSqr = dx * dx + dy * dy + dz * dz;

                    if (distSqr < queryRangeSqr) {
                        agent.neis.push({ agentId: otherAgentId, dist: distSqr });
                    }
                }
            }
        }
    }
};

const updateLocalBoundaries = (crowd: Crowd, navMesh: NavMesh): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        if (agent.state !== AgentState.WALKING || agent.corridor.path.length === 0) {
            continue;
        }

        // update boundary if agent has moved significantly or if boundary is invalid
        const updateThreshold = agent.collisionQueryRange * 0.25;
        const movedDistance = vec3.distance(agent.position, agent.boundary.center);

        if (movedDistance > updateThreshold || !localBoundary.isLocalBoundaryValid(agent.boundary, navMesh, agent.queryFilter)) {
            localBoundary.updateLocalBoundary(
                agent.boundary,
                agent.corridor.path[0],
                agent.position,
                agent.collisionQueryRange,
                navMesh,
                agent.queryFilter,
            );
        }
    }
};

const updateCorners = (crowd: Crowd, navMesh: NavMesh): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (
            agent.state !== AgentState.WALKING ||
            agent.targetState === AgentTargetState.NONE ||
            agent.targetState === AgentTargetState.VELOCITY
        ) {
            vec3.set(agent.desiredVelocity, 0, 0, 0);
            continue;
        }

        if (agent.state !== AgentState.WALKING || agent.targetState !== AgentTargetState.VALID) {
            vec3.set(agent.desiredVelocity, 0, 0, 0);
            continue;
        }

        // get corridor corners for steering
        const corners = pathCorridor.findCorners(agent.corridor, navMesh, 3);

        if (!corners) {
            vec3.set(agent.desiredVelocity, 0, 0, 0);
            continue;
        }

        agent.corners = corners;

        // check to see if the corner after the next corner is directly visible, and short cut to there
        if ((agent.updateFlags & CrowdUpdateFlags.OPTIMIZE_VIS) !== 0 && agent.corners.length > 0) {
            const targetIndex = Math.min(1, agent.corners.length - 1);
            const target = agent.corners[targetIndex].position;
            pathCorridor.optimizePathVisibility(agent.corridor, target, agent.pathOptimizationRange, navMesh, agent.queryFilter);
        }
    }
};

const dist2dSqr = (a: Vec3, b: Vec3): number => {
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    return dx * dx + dz * dz;
};

const agentIsOverOffMeshConnection = (agent: Agent, radius: number): boolean => {
    if (agent.corners.length === 0) return false;

    const lastCorner = agent.corners[agent.corners.length - 1];

    if (lastCorner.type !== NodeType.OFFMESH) return false;

    const dist = dist2dSqr(agent.position, lastCorner.position);

    return dist < radius * radius;
};

const updateOffMeshConnectionTriggers = (crowd: Crowd, navMesh: NavMesh): void => {
    // trigger off mesh connections depending on next corners
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (
            agent.state !== AgentState.WALKING ||
            agent.targetState === AgentTargetState.NONE ||
            agent.targetState === AgentTargetState.VELOCITY
        ) {
            continue;
        }

        const triggerRadius = agent.radius * 2.25;

        if (agentIsOverOffMeshConnection(agent, triggerRadius)) {
            const offMeshConnectionNode = agent.corners[agent.corners.length - 1].nodeRef;

            if (!offMeshConnectionNode) continue;

            const result = pathCorridor.moveOverOffMeshConnection(agent.corridor, offMeshConnectionNode, navMesh);

            if (result === false) continue;

            agent.state = AgentState.OFFMESH;

            // if autoTraverseOffMeshConnections is true, set up automatic animation
            // otherwise, still populate the data but the user must call completeOffMeshConnection manually
            agent.offMeshAnimation = {
                t: 0,
                duration: agent.autoTraverseOffMeshConnections ? 0.5 : -1,
                startPosition: vec3.clone(agent.position),
                endPosition: vec3.clone(result.endPosition),
                nodeRef: result.offMeshNodeRef,
            };
        }
    }
};

/**
 * Manually completes an off-mesh connection for an agent.
 * This should be called after custom off-mesh animation is complete.
 * @param crowd the crowd
 * @param agentId the agent id
 * @returns true if the off-mesh connection was completed successfully, false otherwise
 */
export const completeOffMeshConnection = (crowd: Crowd, agentId: string): boolean => {
    const agent = crowd.agents[agentId];

    if (!agent) return false;

    if (agent.state !== AgentState.OFFMESH) return false;

    if (!agent.offMeshAnimation) return false;

    vec3.copy(agent.position, agent.offMeshAnimation.endPosition);

    // update velocity - set to zero during off-mesh connection
    vec3.set(agent.velocity, 0, 0, 0);
    vec3.set(agent.desiredVelocity, 0, 0, 0);

    // finish animation
    agent.offMeshAnimation = null;

    // prepare agent for walking
    agent.state = AgentState.WALKING;

    return true;
};

const _calcStraightSteerDirection_direction = vec3.create();

/**
 * Calculate straight steering direction (no anticipation).
 * Steers directly toward the first corner.
 */
const calcStraightSteerDirection = (agent: Agent, corners: StraightPathPoint[]): void => {
    if (corners.length === 0) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    const direction = vec3.subtract(_calcStraightSteerDirection_direction, corners[0].position, agent.position);
    direction[1] = 0; // Keep movement on XZ plane
    vec3.normalize(direction, direction);

    const speed = agent.maxSpeed;
    vec3.scale(agent.desiredVelocity, direction, speed);
};

const _calcSmoothSteerDirection_dir0 = vec3.create();
const _calcSmoothSteerDirection_dir1 = vec3.create();
const _calcSmoothSteerDirection_direction = vec3.create();

/**
 * Calculate smooth steering direction (with anticipation).
 * Blends between first and second corner for smoother turns.
 */
const calcSmoothSteerDirection = (agent: Agent, corners: StraightPathPoint[]): void => {
    if (corners.length === 0) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    const ip0 = 0;
    const ip1 = Math.min(1, corners.length - 1);
    const p0 = corners[ip0].position;
    const p1 = corners[ip1].position;

    const dir0 = vec3.subtract(_calcSmoothSteerDirection_dir0, p0, agent.position);
    const dir1 = vec3.subtract(_calcSmoothSteerDirection_dir1, p1, agent.position);
    dir0[1] = 0;
    dir1[1] = 0;

    const len0 = vec3.length(dir0);
    const len1 = vec3.length(dir1);

    if (len1 > 0.001) {
        vec3.scale(dir1, dir1, 1.0 / len1);
    }

    const direction = _calcSmoothSteerDirection_direction;
    direction[0] = dir0[0] - dir1[0] * len0 * 0.5;
    direction[1] = 0;
    direction[2] = dir0[2] - dir1[2] * len0 * 0.5;

    vec3.normalize(direction, direction);

    const speed = agent.maxSpeed;
    vec3.scale(agent.desiredVelocity, direction, speed);
};

const _getDistanceToGoalStart = vec2.create();
const _getDistanceToGoalEnd = vec2.create();

const getDistanceToGoal = (agent: Agent, range: number) => {
    if (agent.corners.length === 0) return range;

    const endPosition = agent.corners[agent.corners.length - 1];
    const isEndOfPath = (endPosition.flags & StraightPathPointFlags.END) !== 0;

    if (!isEndOfPath) return range;

    vec2.set(_getDistanceToGoalStart, endPosition.position[0], endPosition.position[2]);
    vec2.set(_getDistanceToGoalEnd, agent.position[0], agent.position[2]);

    const dist = vec2.distance(_getDistanceToGoalStart, _getDistanceToGoalEnd);

    return Math.min(range, dist);
};

const _updateSteering_separationDisp = vec3.create();
const _updateSteering_separationDiff = vec3.create();

const updateSteering = (crowd: Crowd): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (agent.targetState === AgentTargetState.VELOCITY) {
            vec3.copy(agent.desiredVelocity, agent.targetPosition);
            continue;
        }

        const anticipateTurns = (agent.updateFlags & CrowdUpdateFlags.ANTICIPATE_TURNS) !== 0;

        // calculate steering direction
        if (anticipateTurns) {
            calcSmoothSteerDirection(agent, agent.corners);
        } else {
            calcStraightSteerDirection(agent, agent.corners);
        }

        // calculate speed scale, handles slowdown at the end of the path
        const slowDownRadius = agent.radius * 2;
        const speedScale = getDistanceToGoal(agent, slowDownRadius) / slowDownRadius;

        agent.desiredSpeed = agent.maxSpeed;
        vec3.scale(agent.desiredVelocity, agent.desiredVelocity, speedScale);

        // separation
        if ((agent.updateFlags & CrowdUpdateFlags.SEPARATION) !== 0) {
            const separationDist = agent.collisionQueryRange;
            const invSeparationDist = 1.0 / separationDist;
            const separationWeight = agent.separationWeight;

            let w = 0;
            const disp = _updateSteering_separationDisp;
            vec3.set(disp, 0, 0, 0);

            for (let j = 0; j < agent.neis.length; j++) {
                const neiId = agent.neis[j].agentId;
                const nei = crowd.agents[neiId];
                if (!nei) continue;

                const diff = vec3.subtract(_updateSteering_separationDiff, agent.position, nei.position);
                diff[1] = 0; // ignore Y axis

                const distSqr = vec3.squaredLength(diff);
                if (distSqr < 0.00001) continue;
                if (distSqr > separationDist * separationDist) continue;

                const dist = Math.sqrt(distSqr);
                const weight = separationWeight * (1.0 - dist * invSeparationDist * (dist * invSeparationDist));

                // disp += diff * (weight / dist)
                vec3.scaleAndAdd(disp, disp, diff, weight / dist);
                w += 1.0;
            }

            if (w > 0.0001) {
                // adjust desired velocity: dvel += disp * (1.0 / w)
                vec3.scaleAndAdd(agent.desiredVelocity, agent.desiredVelocity, disp, 1.0 / w);

                // clamp desired velocity to desired speed
                const speedSqr = vec3.squaredLength(agent.desiredVelocity);
                const desiredSqr = agent.desiredSpeed * agent.desiredSpeed;
                if (speedSqr > desiredSqr && speedSqr > 0) {
                    vec3.scale(agent.desiredVelocity, agent.desiredVelocity, Math.sqrt(desiredSqr / speedSqr));
                }
            }
        }
    }
};

const updateVelocityPlanning = (crowd: Crowd): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (agent.state !== AgentState.WALKING) continue;

        if (agent.updateFlags & CrowdUpdateFlags.OBSTACLE_AVOIDANCE) {
            // reset obstacle query
            obstacleAvoidance.resetObstacleAvoidanceQuery(agent.obstacleAvoidanceQuery);

            // add neighboring agents as circular obstacles
            for (const neighbor of agent.neis) {
                const neighborAgent = crowd.agents[neighbor.agentId];
                obstacleAvoidance.addCircleObstacle(
                    agent.obstacleAvoidanceQuery,
                    neighborAgent.position,
                    neighborAgent.radius,
                    neighborAgent.velocity,
                    neighborAgent.desiredVelocity,
                );
            }

            // add boundary segments as obstacles
            for (const segment of agent.boundary.segments) {
                const s = segment.s;
                const p1: Vec3 = [s[0], s[1], s[2]];
                const p2: Vec3 = [s[3], s[4], s[5]];

                // only add segments that are in front of the agent
                const triArea = (agent.position[0] - p1[0]) * (p2[2] - p1[2]) - (agent.position[2] - p1[2]) * (p2[0] - p1[0]);

                if (triArea < 0.0) {
                    continue;
                }

                obstacleAvoidance.addSegmentObstacle(agent.obstacleAvoidanceQuery, p1, p2);
            }

            // sample safe velocity using adaptive sampling
            obstacleAvoidance.sampleVelocityAdaptive(
                agent.obstacleAvoidanceQuery,
                agent.position,
                agent.radius,
                agent.maxSpeed,
                agent.velocity,
                agent.desiredVelocity,
                agent.obstacleAvoidance,
                agent.newVelocity,
                agent.obstacleAvoidanceDebugData,
            );
        } else {
            // not using obstacle avoidance, set newVelocity to desiredVelocity
            vec3.copy(agent.newVelocity, agent.desiredVelocity);
        }
    }
};

const _integrateDv = vec3.create();

const integrate = (crowd: Crowd, deltaTime: number): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        if (agent.state !== AgentState.WALKING) continue;

        // fake dynamic constraint - limit acceleration
        const maxDelta = agent.maxAcceleration * deltaTime;
        const dv = vec3.subtract(_integrateDv, agent.newVelocity, agent.velocity);
        const ds = vec3.length(dv);

        if (ds > maxDelta) {
            vec3.scale(dv, dv, maxDelta / ds);
        }

        vec3.add(agent.velocity, agent.velocity, dv);

        // integrate position
        if (vec3.length(agent.velocity) > 0.0001) {
            vec3.scaleAndAdd(agent.position, agent.position, agent.velocity, deltaTime);
        } else {
            vec3.set(agent.velocity, 0, 0, 0);
        }
    }
};

const _handleCollisions_diff = vec3.create();

const handleCollisions = (crowd: Crowd): void => {
    const COLLISION_RESOLVE_FACTOR = 0.7;

    // get all agents as an array for easier iteration
    const agentIds = Object.keys(crowd.agents);
    const agents = agentIds.map((id) => crowd.agents[id]);

    for (let iter = 0; iter < 4; iter++) {
        // first pass: calculate displacement for each agent
        for (let i = 0; i < agents.length; i++) {
            const agent = agents[i];

            if (agent.state !== AgentState.WALKING) {
                continue;
            }

            vec3.set(agent.displacement, 0, 0, 0);

            let w = 0;

            for (let j = 0; j < agent.neis.length; j++) {
                const neiAgentId = agent.neis[j].agentId;
                const nei = crowd.agents[neiAgentId];
                if (!nei) continue;

                const diff = vec3.subtract(_handleCollisions_diff, agent.position, nei.position);
                diff[1] = 0; // ignore Y axis

                const distSqr = vec3.squaredLength(diff);
                const combinedRadius = agent.radius + nei.radius;

                if (distSqr > combinedRadius * combinedRadius) {
                    continue;
                }

                const dist = Math.sqrt(distSqr);
                let pen = combinedRadius - dist;

                if (dist < 0.0001) {
                    // agents on top of each other, try to choose diverging separation directions
                    const idx0 = i;
                    const idx1 = agentIds.indexOf(neiAgentId);

                    if (idx0 > idx1) {
                        vec3.set(diff, -agent.desiredVelocity[2], 0, agent.desiredVelocity[0]);
                    } else {
                        vec3.set(diff, agent.desiredVelocity[2], 0, -agent.desiredVelocity[0]);
                    }
                    pen = 0.01;
                } else {
                    pen = (1.0 / dist) * (pen * 0.5) * COLLISION_RESOLVE_FACTOR;
                }

                vec3.scaleAndAdd(agent.displacement, agent.displacement, diff, pen);

                w += 1.0;
            }

            if (w > 0.0001) {
                const iw = 1.0 / w;
                vec3.scale(agent.displacement, agent.displacement, iw);
            }
        }

        // second pass: apply displacement to all agents
        for (let i = 0; i < agents.length; i++) {
            const agent = agents[i];

            if (agent.state !== AgentState.WALKING) {
                continue;
            }

            vec3.add(agent.position, agent.position, agent.displacement);
        }
    }
};

const updateCorridors = (crowd: Crowd, navMesh: NavMesh): void => {
    // update corridors for each agent
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (agent.state !== AgentState.WALKING) continue;

        // move along navmesh
        pathCorridor.movePosition(agent.corridor, agent.position, navMesh, agent.queryFilter);

        // get valid constrained position back
        vec3.copy(agent.position, agent.corridor.position);

        // if not using path, truncate the corridor to one poly
        if (agent.targetState === AgentTargetState.NONE || agent.targetState === AgentTargetState.VELOCITY) {
            pathCorridor.reset(agent.corridor, agent.corridor.path[0], agent.position);
        }
    }
};

const offMeshConnectionUpdate = (crowd: Crowd, deltaTime: number): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (!agent.offMeshAnimation) {
            continue;
        }

        // only auto-update if autoTraverseOffMeshConnections is enabled
        // otherwise, the user is responsible for animation and calling completeOffMeshConnection
        if (!agent.autoTraverseOffMeshConnections) {
            continue;
        }

        const anim = agent.offMeshAnimation;

        // progress animation time
        anim.t += deltaTime;

        if (anim.t >= anim.duration) {
            // finish animation
            agent.offMeshAnimation = null;

            // prepare agent for walking
            agent.state = AgentState.WALKING;

            continue;
        }

        // update position
        const progress = anim.t / anim.duration;
        vec3.lerp(agent.position, anim.startPosition, anim.endPosition, progress);

        // update velocity - set to zero during off-mesh connection
        vec3.set(agent.velocity, 0, 0, 0);
        vec3.set(agent.desiredVelocity, 0, 0, 0);
    }
};

const updateTopologyOptimization = (crowd: Crowd, navMesh: NavMesh, deltaTime: number): void => {
    const OPT_TIME_THR = 0.5; // seconds
    const OPT_MAX_AGENTS = 1;

    const queue: Array<{ agentId: string; time: number }> = [];

    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (agent.state !== AgentState.WALKING) continue;
        if (agent.targetState === AgentTargetState.NONE || agent.targetState === AgentTargetState.VELOCITY) continue;
        if ((agent.updateFlags & CrowdUpdateFlags.OPTIMIZE_TOPO) === 0) continue;

        agent.topologyOptTime += deltaTime;

        if (agent.topologyOptTime >= OPT_TIME_THR) {
            // Insert into queue based on greatest time (longest waiting gets priority)
            if (queue.length === 0) {
                queue.push({ agentId, time: agent.topologyOptTime });
            } else if (agent.topologyOptTime <= queue[queue.length - 1].time) {
                if (queue.length < OPT_MAX_AGENTS) {
                    queue.push({ agentId, time: agent.topologyOptTime });
                }
            } else {
                // Find insertion point (sorted by topologyOptTime descending)
                let insertIdx = 0;
                for (let i = 0; i < queue.length; i++) {
                    if (agent.topologyOptTime >= queue[i].time) {
                        insertIdx = i;
                        break;
                    }
                }
                queue.splice(insertIdx, 0, { agentId, time: agent.topologyOptTime });
                // Trim to max size
                if (queue.length > OPT_MAX_AGENTS) {
                    queue.length = OPT_MAX_AGENTS;
                }
            }
        }
    }

    for (const item of queue) {
        const agent = crowd.agents[item.agentId];
        pathCorridor.optimizePathTopology(agent.corridor, navMesh, agent.queryFilter);
        agent.topologyOptTime = 0;
    }
};

/**
 * Update the crowd simulation.
 * @param crowd the crowd
 * @param navMesh the navigation mesh
 * @param deltaTime the time since the last update
 */
export const update = (crowd: Crowd, navMesh: NavMesh, deltaTime: number): void => {
    // check whether agent paths are still valid
    checkPathValidity(crowd, navMesh, deltaTime);

    // optimize path topology for agents periodically
    updateTopologyOptimization(crowd, navMesh, deltaTime);

    // handle move requests since last update
    updateMoveRequests(crowd, navMesh, deltaTime);

    // update neighbour agents for each agent
    updateNeighbours(crowd);

    // update local boundary for each agent
    updateLocalBoundaries(crowd, navMesh);

    // update desired velocity based on steering to corners or velocity target
    updateCorners(crowd, navMesh);

    // trigger off mesh connections depending on next corners
    updateOffMeshConnectionTriggers(crowd, navMesh);

    // calculate steering
    updateSteering(crowd);

    // obstacle avoidance with other agents and local boundary
    updateVelocityPlanning(crowd);

    // integrate
    integrate(crowd, deltaTime);

    // handle agent x agent collisions
    handleCollisions(crowd);

    // update corridors
    updateCorridors(crowd, navMesh);

    // off mesh connection agent animations
    offMeshConnectionUpdate(crowd, deltaTime);
};

/**
 * Check if an agent is at or near the end of their corridor.
 * Works for both complete and partial paths - if the path is partial,
 * this checks if the agent reached the best-effort position.
 *
 * @param crowd the crowd
 * @param agentId the agent id
 * @param threshold distance threshold to consider "at target"
 * @returns true if the agent is at the end of their path
 */
export const isAgentAtTarget = (crowd: Crowd, agentId: string, threshold: number): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    // must have a valid target
    if (agent.targetState !== AgentTargetState.VALID) return false;

    // check if we have corners and the last corner is marked as END
    if (agent.corners.length === 0) return false;

    const endPosition = agent.corners[agent.corners.length - 1];
    const isEndOfPath = (endPosition.flags & StraightPathPointFlags.END) !== 0;

    if (!isEndOfPath) return false;

    // check distance to the end point
    const arrivalThreshold = threshold ?? agent.radius;
    const dist = vec3.distance(agent.position, endPosition.position);

    return dist <= arrivalThreshold;
};
