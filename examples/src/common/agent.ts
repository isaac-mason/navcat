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
import { corridorMovePosition, createPathCorridor, findCorridorCorners, PathCorridor, setCorridorPath } from './path-corridor';

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
    state: AgentState;
    targetState: AgentTargetState;
    position: Vec3;
    velocity: Vec3;
    corridor: PathCorridor;
    maxSpeed: number;
    radius: number;
    target: Vec3;
    targetRef: NodeRef;
    slicedQuery: SlicedNodePathQuery;
    targetReplanTime: number; // Time since last replan
};

export const createAgent = (id: string, position: Vec3, maxSpeed: number, radius: number): Agent => {
    return {
        id,
        position: vec3.clone(position),
        velocity: [0, 0, 0],
        target: vec3.clone(position),
        maxSpeed,
        radius,

        state: AgentState.INVALID,
        targetState: AgentTargetState.NONE,
        targetRef: '0,0,0' as NodeRef,

        corridor: createPathCorridor(256),
        slicedQuery: createSlicedNodePathQuery(),
        targetReplanTime: 0,
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

    console.log(`Agent ${agent.id} requesting move to target`);

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
                console.log(`Agent ${agent.id} path found immediately (${finalResult.pathCount} polygons)`);
            } else {
                agent.targetState = AgentTargetState.FAILED;
                console.log(`Agent ${agent.id} failed to finalize immediate path`);
            }
        } else if (status & SlicedFindNodePathStatusFlags.IN_PROGRESS) {
            agent.targetState = AgentTargetState.REQUESTING;
            console.log(`Agent ${agent.id} pathfinding in progress`);
        } else {
            agent.targetState = AgentTargetState.FAILED;
            console.log(`Agent ${agent.id} pathfinding failed to start`);
        }
    } else {
        console.warn(`Agent ${agent.id} has no path corridor to start from`);
        agent.targetState = AgentTargetState.FAILED;
    }
};

export const updateAgentPathfinding = (agent: Agent, navMesh: NavMesh): void => {
    if (agent.targetState !== AgentTargetState.REQUESTING) return;

    console.log(`Agent ${agent.id} updating pathfinding`);

    const maxIterations = 100;
    const result = updateSlicedFindNodePath(navMesh, agent.slicedQuery, maxIterations);

    console.log(`Agent ${agent.id} pathfinding result:`, result.status, 'iterations:', result.itersDone);

    if (result.status & SlicedFindNodePathStatusFlags.SUCCESS) {
        // finalize the path
        const finalResult = finalizeSlicedFindNodePath(agent.slicedQuery);

        console.log(`Agent ${agent.id} finalized path:`, finalResult.pathCount, 'polygons');

        if (finalResult.status & SlicedFindNodePathStatusFlags.SUCCESS && finalResult.pathCount > 0) {
            setCorridorPath(agent.corridor, agent.target, finalResult.path);
            agent.targetState = AgentTargetState.VALID;
            console.log(`Agent ${agent.id} path is now valid - corridor path length: ${agent.corridor.path.length}`);
        } else {
            agent.targetState = AgentTargetState.FAILED;
            console.log(`Agent ${agent.id} pathfinding failed to finalize`);
        }
    } else if (result.status & SlicedFindNodePathStatusFlags.FAILURE) {
        agent.targetState = AgentTargetState.FAILED;
        console.log(`Agent ${agent.id} pathfinding failed immediately`);
    }
};

export const updateAgentMovement = (agent: Agent, navMesh: NavMesh, filter: QueryFilter, deltaTime: number): void => {
    // Debug: Log agent state occasionally
    if (Math.random() < 0.1) {
        // 10% of frames
        console.log(`Agent ${agent.id} movement debug:`, {
            state: agent.state,
            targetState: agent.targetState,
            position: agent.position,
            corridorPosition: agent.corridor.position,
            corridorPathLength: agent.corridor.path.length,
            corridorTarget: agent.corridor.target,
        });
    }

    if (agent.state !== AgentState.WALKING) {
        console.log(`Agent ${agent.id} not walking (state: ${agent.state})`);
        return;
    }

    if (agent.targetState !== AgentTargetState.VALID) {
        console.log(`Agent ${agent.id} target not valid (targetState: ${agent.targetState})`);
        return;
    }

    // Get corridor corners for steering (like DetourCrowd does)
    const corners = findCorridorCorners(agent.corridor, navMesh, 10);
    console.log(`Agent ${agent.id} found ${corners.length} corners`);

    if (corners.length > 0) {
        // DetourCrowd-style corner selection with anticipation
        let targetCorner: Vec3 | null = null;
        let targetDistance = 0;

        const MIN_TARGET_DISTANCE = 0.1;
        const ANTICIPATION_DISTANCE = agent.radius * 4; // Look ahead distance

        // Find the best corner to target using DetourCrowd's anticipation logic
        for (let i = 0; i < corners.length; i++) {
            const corner = corners[i];
            const dist = vec3.distance(agent.position, corner);

            console.log(`Agent ${agent.id} corner ${i} distance: ${dist.toFixed(3)}`);

            // Skip corners that are too close (we're basically at them)
            if (dist < MIN_TARGET_DISTANCE) {
                continue;
            }

            // For the first valid corner, check if we can anticipate (skip ahead)
            if (!targetCorner) {
                targetCorner = corner;
                targetDistance = dist;

                // Try to anticipate - if this corner is close, see if we can target a further one
                if (dist < ANTICIPATION_DISTANCE && i + 1 < corners.length) {
                    const nextCorner = corners[i + 1];
                    const nextDist = vec3.distance(agent.position, nextCorner);

                    // Check if we can see the next corner (simple line of sight)
                    if (nextDist > MIN_TARGET_DISTANCE) {
                        console.log(`Agent ${agent.id} anticipating corner ${i + 1} (distance: ${nextDist.toFixed(3)})`);
                        targetCorner = nextCorner;
                        targetDistance = nextDist;
                    }
                }

                console.log(`Agent ${agent.id} using corner ${i} as target`);
                break;
            }
        }

        // If no valid corner found, use the final target
        if (!targetCorner) {
            targetCorner = agent.corridor.target;
            targetDistance = vec3.distance(agent.position, targetCorner);
            console.log(`Agent ${agent.id} no valid corners, using final target (distance: ${targetDistance.toFixed(3)})`);
        }

        // Only move if the target is far enough
        if (targetDistance > MIN_TARGET_DISTANCE) {
            // DetourCrowd-style steering with collision avoidance
            const direction = vec3.subtract([0, 0, 0], targetCorner, agent.position);
            direction[1] = 0; // Keep movement on XZ plane

            // Normalize for steering
            const dirLength = vec3.length(direction);
            if (dirLength > 0.001) {
                vec3.scale(direction, direction, 1.0 / dirLength);

                // Apply steering force based on distance to target
                const urgency = Math.min(1.0, targetDistance / (agent.radius * 6));

                // Calculate desired speed with better slowdown behavior
                const slowDownRadius = agent.radius * 3;
                const finalTargetDistance = vec3.distance(agent.position, agent.corridor.target);
                let speedScale = Math.min(1.0, finalTargetDistance / slowDownRadius);

                // Apply urgency to avoid getting stuck
                speedScale = Math.max(0.3, speedScale * urgency); // Minimum 30% speed

                const speed = agent.maxSpeed * speedScale;

                console.log(
                    `Agent ${agent.id} calculated speed: ${speed.toFixed(3)} (scale: ${speedScale.toFixed(3)}, urgency: ${urgency.toFixed(3)})`,
                );

                // Set desired velocity
                vec3.scale(agent.velocity, direction, speed);

                // Integrate movement with better collision handling
                const movement = vec3.scale([0, 0, 0], agent.velocity, deltaTime);
                const newPos = vec3.add([0, 0, 0], agent.position, movement);

                console.log(
                    `Agent ${agent.id} attempting move from [${agent.position[0].toFixed(2)}, ${agent.position[1].toFixed(2)}, ${agent.position[2].toFixed(2)}] to [${newPos[0].toFixed(2)}, ${newPos[1].toFixed(2)}, ${newPos[2].toFixed(2)}]`,
                );

                if (corridorMovePosition(agent.corridor, newPos, navMesh, filter)) {
                    // sync agent position with corridor
                    vec3.copy(agent.position, agent.corridor.position);
                    console.log(
                        `Agent ${agent.id} moved successfully to [${agent.position[0].toFixed(2)}, ${agent.position[1].toFixed(2)}, ${agent.position[2].toFixed(2)}]`,
                    );
                } else {
                    // if corridor movement fails, stop the agent
                    vec3.set(agent.velocity, 0, 0, 0);
                    console.warn(`Agent ${agent.id} corridor movement failed`);
                }
            }
        } else {
            console.log(`Agent ${agent.id} target too close (${targetDistance.toFixed(3)}), skipping movement`);
        }

        // check if reached target
        const finalTargetDistance = vec3.distance(agent.position, agent.corridor.target);
    
        if (finalTargetDistance < 0.5) {
            agent.targetState = AgentTargetState.NONE;
            agent.state = AgentState.WAITING;
            vec3.set(agent.velocity, 0, 0, 0);
            console.log(`Agent ${agent.id} reached target`);
        }
    } else {
        console.warn(`Agent ${agent.id} has no corners to follow`);
    }
};
