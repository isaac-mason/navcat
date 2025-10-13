import { type Vec3, vec2, vec3 } from 'maaths';
import {
    createFindNearestPolyResult,
    createSlicedNodePathQuery,
    finalizeSlicedFindNodePath,
    findNearestPoly,
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
import {
    createLocalBoundary,
    isLocalBoundaryValid,
    type LocalBoundary,
    resetLocalBoundary,
    updateLocalBoundary,
} from './local-boundary';
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
    corridorIsValid,
    corridorMovePosition,
    createPathCorridor,
    findCorridorCorners,
    fixPathStart,
    moveOverOffMeshConnection,
    type PathCorridor,
    resetCorridor,
    setCorridorPath,
} from './path-corridor';

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
    PATHFINDING,
    VELOCITY,
}

export enum CrowdUpdateFlags {
    ANTICIPATE_TURNS = 1,
    OBSTACLE_AVOIDANCE = 2,
    SEPARATION = 4,
}

export type AgentParams = {
    radius: number;
    height: number;
    maxAcceleration: number;
    maxSpeed: number;

    collisionQueryRange: number;
    // pathOptimizationRange: number;
    separationWeight: number;

    /** @see CrowdUpdateFlags */
    updateFlags: number;
    queryFilter: QueryFilter;
    obstacleAvoidance: ObstacleAvoidanceParams;
};

export type Agent = {
    params: AgentParams;

    /** @see AgentState */
    state: number;

    corridor: PathCorridor;
    boundary: LocalBoundary;
    slicedQuery: SlicedNodePathQuery;
    obstacleAvoidanceQuery: ObstacleAvoidanceQuery;
    topologyOptTime: number;

    neis: Array<{ agentId: string; dist: number }>;

    corners: StraightPathPoint[];

    position: Vec3;
    desiredSpeed: number;
    desiredVelocity: Vec3;
    newVelocity: Vec3;
    velocity: Vec3;
    displacement: Vec3;

    /** @see AgentTargetState */
    targetState: number;
    targetRef: NodeRef | null;
    targetPos: Vec3;
    targetReplan: boolean;
    targetPathfindingTime: number;

    offMeshAnimation: {
        t: number;
        startPos: Vec3;
        endPos: Vec3;
        duration: number;
    } | null;
};

export type Crowd = {
    agents: Record<string, Agent>;
    agentIdCounter: number;
    maxAgentRadius: number;
    agentPlacementHalfExtents: Vec3;
};

export const createCrowd = (maxAgentRadius: number): Crowd => {
    return {
        agents: {},
        agentIdCounter: 0,
        maxAgentRadius,
        agentPlacementHalfExtents: [maxAgentRadius, maxAgentRadius, maxAgentRadius],
    };
};

export const addAgent = (crowd: Crowd, position: Vec3, agentParams: AgentParams): string => {
    const agentId = String(crowd.agentIdCounter++);

    const agent: Agent = {
        params: agentParams,

        state: AgentState.WALKING,

        corridor: createPathCorridor(256),
        slicedQuery: createSlicedNodePathQuery(),
        boundary: createLocalBoundary(),
        obstacleAvoidanceQuery: createObstacleAvoidanceQuery(32, 32),
        topologyOptTime: 0,

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
        targetPos: [0, 0, 0],
        targetReplan: false,
        targetPathfindingTime: 0,

        offMeshAnimation: null,
    };

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

export const requestMoveTarget = (crowd: Crowd, agentId: string, targetRef: NodeRef, targetPos: Vec3): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    agent.targetRef = targetRef;
    vec3.copy(agent.targetPos, targetPos);

    agent.targetReplan = false;
    agent.targetState = AgentTargetState.REQUESTING;

    return true;
};

const requestMoveTargetReplan = (crowd: Crowd, agentId: string, targetRef: NodeRef | null, targetPos: Vec3): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    agent.targetRef = targetRef;
    vec3.copy(agent.targetPos, targetPos);

    agent.targetReplan = false;
    agent.targetState = AgentTargetState.REQUESTING;

    return true;
};

export const requestMoveVelocity = (crowd: Crowd, agentId: string, velocity: Vec3): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    vec3.copy(agent.targetPos, velocity);
    agent.targetState = AgentTargetState.VELOCITY;

    return true;
};

export const resetMoveTarget = (crowd: Crowd, agentId: string): boolean => {
    const agent = crowd.agents[agentId];
    if (!agent) return false;

    agent.targetRef = null;
    vec3.set(agent.targetPos, 0, 0, 0);
    vec3.set(agent.desiredVelocity, 0, 0, 0);
    agent.targetReplan = false;
    agent.targetState = AgentTargetState.NONE;

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

        if (!agentNodeRef || !isValidNodeRef(navMesh, agentNodeRef)) {
            // current location is invalid, try to reposition
            const nearestPolyResult = findNearestPoly(
                _checkPathValidityNearestPolyResult,
                navMesh,
                agent.position,
                crowd.agentPlacementHalfExtents,
                agent.params.queryFilter,
            );

            if (!nearestPolyResult.success) {
                // could not find location in navmesh, set agent state to invalid
                agent.state = AgentState.INVALID;
                resetCorridor(agent.corridor, 0, agent.position);
                resetLocalBoundary(agent.boundary);

                continue;
            }

            fixPathStart(agent.corridor, nearestPolyResult.ref, agent.position);
            resetLocalBoundary(agent.boundary);
            vec3.copy(agent.position, nearestPolyResult.point);

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
                !agent.params.queryFilter.passFilter(agent.targetRef, navMesh)
            ) {
                // current target is not valid, try to reposition
                const nearestPolyResult = findNearestPoly(
                    _checkPathValidityNearestPolyResult,
                    navMesh,
                    agent.targetPos,
                    crowd.agentPlacementHalfExtents,
                    agent.params.queryFilter,
                );

                vec3.copy(agent.targetPos, nearestPolyResult.point);
                replan = true;

                if (!nearestPolyResult.success) {
                    // could not find location in navmesh, set agent state to invalid
                    agent.targetState = AgentTargetState.NONE;
                    resetCorridor(agent.corridor, 0, agent.position);
                }
            }
        }

        // if nearby corridor is not valid, replan
        if (!corridorIsValid(agent.corridor, CHECK_LOOKAHEAD, navMesh, agent.params.queryFilter)) {
            replan = true;
        }

        // if the end of the apth is near and it is not the requested location, replan
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
            requestMoveTargetReplan(crowd, agentId, agent.targetRef, agent.targetPos);
        }
    }
};

const GLOBAL_MAX_ITERATIONS = 500;
const AGENT_MAX_ITERATIONS = 100;
const QUICK_SEARCH_ITERATIONS = 20;

const updateMoveRequests = (crowd: Crowd, navMesh: NavMesh, deltaTime: number): void => {
    // first, update pathfinding time for all agents in PATHFINDING state
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        if (agent.targetState === AgentTargetState.PATHFINDING) {
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
                agent.targetPos,
                agent.params.queryFilter,
            );

            // quick search
            updateSlicedFindNodePath(navMesh, agent.slicedQuery, QUICK_SEARCH_ITERATIONS);

            agent.targetState = AgentTargetState.PATHFINDING;
            agent.targetPathfindingTime = 0;
        }

        if (agent.targetState === AgentTargetState.PATHFINDING) {
            pathfindingAgents.push(agentId);
        }
    }

    // sort agents by targetReplanTime (longest waiting gets priority)
    pathfindingAgents.sort((a, b) => crowd.agents[b].targetPathfindingTime - crowd.agents[a].targetPathfindingTime);

    // distribute global iteration budget across prioritized agents
    let remainingIterations = GLOBAL_MAX_ITERATIONS;

    for (const agentId of pathfindingAgents) {
        const agent = crowd.agents[agentId];

        if ((agent.slicedQuery.status & SlicedFindNodePathStatusFlags.IN_PROGRESS) !== 0 && remainingIterations > 0) {
            // allocate iterations for this agent (minimum 1, maximum remaining)
            const iterationsForAgent = Math.min(AGENT_MAX_ITERATIONS, remainingIterations);
    
            const iterationsPerformed = updateSlicedFindNodePath(navMesh, agent.slicedQuery, iterationsForAgent);
            remainingIterations -= iterationsPerformed;
        }

        if ((agent.slicedQuery.status & SlicedFindNodePathStatusFlags.FAILURE) !== 0) {
            // pathfinding failed
            agent.targetState = AgentTargetState.FAILED;
            agent.targetPathfindingTime = 0;
        } else if ((agent.slicedQuery.status & SlicedFindNodePathStatusFlags.SUCCESS) !== 0) {
            // pathfinding succeeded
            agent.targetState = AgentTargetState.VALID;
            agent.targetPathfindingTime = 0;

            const result = finalizeSlicedFindNodePath(agent.slicedQuery);
            setCorridorPath(agent.corridor, agent.targetPos, result.path);
            resetLocalBoundary(agent.boundary);
        }
    }
};

const updateNeighbours = (crowd: Crowd): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];
        agent.neis.length = 0;
        const queryRangeSqr = agent.params.collisionQueryRange * agent.params.collisionQueryRange;

        for (const otherAgentId in crowd.agents) {
            const other = crowd.agents[otherAgentId];

            if (other === agent || other.state !== AgentState.WALKING) {
                continue;
            }

            const dx = agent.position[0] - other.position[0];
            const dy = agent.position[1] - other.position[1];
            const dz = agent.position[2] - other.position[2];
            const distSqr = dx * dx + dy * dy + dz * dz;

            if (distSqr < queryRangeSqr) {
                agent.neis.push({ agentId: otherAgentId, dist: distSqr });
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
        const updateThreshold = agent.params.collisionQueryRange * 0.25;
        const movedDistance = vec3.distance(agent.position, agent.boundary.center);

        if (movedDistance > updateThreshold || !isLocalBoundaryValid(agent.boundary, navMesh, agent.params.queryFilter)) {
            updateLocalBoundary(
                agent.boundary,
                agent.corridor.path[0],
                agent.position,
                agent.params.collisionQueryRange,
                navMesh,
                agent.params.queryFilter,
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
        const corners = findCorridorCorners(agent.corridor, navMesh, 3);

        if (!corners) {
            vec3.set(agent.desiredVelocity, 0, 0, 0);
            continue;
        }

        agent.corners = corners;

        // todo: raycast to check for shortcuts
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

        const triggerRadius = agent.params.radius * 2.25;

        if (agentIsOverOffMeshConnection(agent, triggerRadius)) {
            const offMeshConnectionNode = agent.corners[agent.corners.length - 1].nodeRef;

            if (!offMeshConnectionNode) continue;

            const result = moveOverOffMeshConnection(agent.corridor, offMeshConnectionNode, navMesh);

            if (result === false) continue;

            agent.state = AgentState.OFFMESH;
            agent.offMeshAnimation = {
                t: 0,
                duration: 0.5,
                startPos: vec3.clone(agent.position),
                endPos: vec3.clone(result.endPosition),
            };
        }
    }
};

const _direction = vec3.create();

/**
 * Calculate straight steering direction (no anticipation).
 * Steers directly toward the first corner.
 */
const calcStraightSteerDirection = (agent: Agent, corners: StraightPathPoint[]): void => {
    if (corners.length === 0) {
        vec3.set(agent.desiredVelocity, 0, 0, 0);
        return;
    }

    const direction = vec3.subtract(_direction, corners[0].position, agent.position);
    direction[1] = 0; // Keep movement on XZ plane
    vec3.normalize(direction, direction);

    const speed = agent.params.maxSpeed;
    vec3.scale(agent.desiredVelocity, direction, speed);
};

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

    const speed = agent.params.maxSpeed;
    vec3.scale(agent.desiredVelocity, direction, speed);
};

const _getDistanceToGoalStart = vec2.create();
const _getDistanceToGoalEnd = vec2.create();

const getDistanceToGoal = (agent: Agent, range: number) => {
    if (agent.corners.length === 0) return range;

    const endPoint = agent.corners[agent.corners.length - 1];
    const isEndOfPath = (endPoint.flags & StraightPathPointFlags.END) !== 0;

    if (!isEndOfPath) return range;

    vec2.set(_getDistanceToGoalStart, endPoint.position[0], endPoint.position[2]);
    vec2.set(_getDistanceToGoalEnd, agent.position[0], agent.position[2]);

    const dist = vec2.distance(_getDistanceToGoalStart, _getDistanceToGoalEnd);

    return Math.min(range, dist);
}

const updateSteering = (crowd: Crowd): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (agent.targetState === AgentTargetState.VELOCITY) {
            vec3.copy(agent.desiredVelocity, agent.targetPos);
            continue;
        }

        const anticipateTurns = (agent.params.updateFlags & CrowdUpdateFlags.ANTICIPATE_TURNS) !== 0;

        // calculate steering direction
        if (anticipateTurns) {
            calcSmoothSteerDirection(agent, agent.corners);
        } else {
            calcStraightSteerDirection(agent, agent.corners);
        }

        // calculate speed scale, handles slowdown at the end of the path
        const slowDownRadius = agent.params.radius * 2;
        const speedScale = getDistanceToGoal(agent, slowDownRadius) / slowDownRadius;

        agent.desiredSpeed = agent.params.maxSpeed;
        vec3.scale(agent.desiredVelocity, agent.desiredVelocity, speedScale);

        // separation
        if ((agent.params.updateFlags & CrowdUpdateFlags.SEPARATION) !== 0) {
            const separationDist = agent.params.collisionQueryRange;
            const invSeparationDist = 1.0 / separationDist;
            const separationWeight = agent.params.separationWeight;

            let w = 0;
            const disp = vec3.create();

            for (let j = 0; j < agent.neis.length; j++) {
                const neiId = agent.neis[j].agentId;
                const nei = crowd.agents[neiId];
                if (!nei) continue;

                const diff = vec3.subtract(vec3.create(), agent.position, nei.position);
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

        if (agent.params.updateFlags & CrowdUpdateFlags.OBSTACLE_AVOIDANCE) {
            // reset obstacle query
            resetObstacleAvoidanceQuery(agent.obstacleAvoidanceQuery);

            // add neighboring agents as circular obstacles
            for (const neighbor of agent.neis) {
                const neighborAgent = crowd.agents[neighbor.agentId];
                addCircleObstacle(
                    agent.obstacleAvoidanceQuery,
                    neighborAgent.position,
                    neighborAgent.params.radius,
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

                addSegmentObstacle(agent.obstacleAvoidanceQuery, p1, p2);
            }

            // sample safe velocity using adaptive sampling
            sampleVelocityAdaptive(
                agent.obstacleAvoidanceQuery,
                agent.position,
                agent.params.radius,
                agent.params.maxSpeed,
                agent.velocity,
                agent.desiredVelocity,
                agent.params.obstacleAvoidance,
                agent.newVelocity,
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
        const maxDelta = agent.params.maxAcceleration * deltaTime;
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

                const diff = vec3.subtract(vec3.create(), agent.position, nei.position);
                diff[1] = 0; // ignore Y axis

                const distSqr = vec3.squaredLength(diff);
                const combinedRadius = agent.params.radius + nei.params.radius;

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
        corridorMovePosition(agent.corridor, agent.position, navMesh, agent.params.queryFilter);

        // get valid constrained position back
        vec3.copy(agent.position, agent.corridor.position);

        // if not using path, truncate the corridor to one poly
        if (agent.targetState === AgentTargetState.NONE || agent.targetState === AgentTargetState.VELOCITY) {
            resetCorridor(agent.corridor, agent.corridor.path[0], agent.position);
        }
    }
};

// note: this would typically be replaced with specific animation and off mesh finalisation logic
const offMeshConnectionUpdate = (crowd: Crowd, deltaTime: number): void => {
    for (const agentId in crowd.agents) {
        const agent = crowd.agents[agentId];

        if (!agent.offMeshAnimation) {
            continue;
        }

        const anim = agent.offMeshAnimation;

        // progress animation time
        anim.t += deltaTime;

        if (anim.t >= anim.duration) {
            // remove off-mesh connection node from corridor
            agent.corridor.path.shift();

            // finish animation
            agent.offMeshAnimation = null;

            // prepare agent for walking
            agent.state = AgentState.WALKING;

            continue;
        }

        // update position
        const progress = anim.t / anim.duration;
        vec3.lerp(agent.position, anim.startPos, anim.endPos, progress);

        // update velocity - set to zero during off-mesh connection
        vec3.set(agent.velocity, 0, 0, 0);
        vec3.set(agent.desiredVelocity, 0, 0, 0);
    }
};

export const updateCrowd = (crowd: Crowd, navMesh: NavMesh, deltaTime: number): void => {
    // check whether agent paths are still valid
    checkPathValidity(crowd, navMesh, deltaTime);

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
