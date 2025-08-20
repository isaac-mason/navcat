import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';
import {
    createFindNearestPolyResult,
    createSlicedNodePathQuery,
    DEFAULT_QUERY_FILTER,
    finalizeSlicedFindNodePath,
    findNearestPoly,
    findRandomPoint,
    findRandomPointAroundCircle,
    findStraightPath,
    initSlicedFindNodePath,
    moveAlongSurface,
    type NavMesh,
    type NodeRef,
    type QueryFilter,
    SlicedFindNodePathStatusFlags,
    type SlicedNodePathQuery,
    three as threeUtils,
    updateSlicedFindNodePath,
} from 'nav3d';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createExample } from './common/example-boilerplate';
import { generateTiledNavMesh, type TiledNavMeshInput, type TiledNavMeshOptions } from './common/generate-tiled-nav-mesh';
import { loadGLTF } from './common/load-gltf';

/* path corridor - based on Detour's dtPathCorridor */

type PathCorridor = {
    position: Vec3;
    target: Vec3;
    path: NodeRef[];
    maxPath: number;
};

const createPathCorridor = (maxPath: number): PathCorridor => ({
    position: [0, 0, 0],
    target: [0, 0, 0],
    path: [],
    maxPath,
});

const resetCorridor = (corridor: PathCorridor, ref: NodeRef, position: Vec3): void => {
    vec3.copy(corridor.position, position);
    vec3.copy(corridor.target, position);
    corridor.path = [ref];
};

const setCorridorPath = (corridor: PathCorridor, target: Vec3, path: NodeRef[]): void => {
    vec3.copy(corridor.target, target);
    corridor.path = path.slice(0, corridor.maxPath);
};

// Merge corridor path when the start has moved (equivalent to dtMergeCorridorStartMoved)
const mergeCorridorStartMoved = (currentPath: NodeRef[], visited: NodeRef[], maxPath: number): NodeRef[] => {
    if (visited.length === 0) return currentPath;
    
    let furthestPath = -1;
    let furthestVisited = -1;
    
    // Find furthest common polygon
    for (let i = currentPath.length - 1; i >= 0; i--) {
        for (let j = visited.length - 1; j >= 0; j--) {
            if (currentPath[i] === visited[j]) {
                furthestPath = i;
                furthestVisited = j;
                break;
            }
        }
        if (furthestPath !== -1) break;
    }
    
    // If no intersection found, just return current path
    if (furthestPath === -1 || furthestVisited === -1) {
        return currentPath;
    }
    
    // Concatenate paths
    const req = visited.length - furthestVisited;
    const orig = Math.min(furthestPath + 1, currentPath.length);
    let size = Math.max(0, currentPath.length - orig);
    
    if (req + size > maxPath) {
        size = maxPath - req;
    }
    
    const newPath: NodeRef[] = [];
    
    // Store visited polygons (in reverse order)
    for (let i = 0; i < Math.min(req, maxPath); i++) {
        newPath[i] = visited[visited.length - 1 - i];
    }
    
    // Add remaining current path
    if (size > 0) {
        for (let i = 0; i < size; i++) {
            newPath[req + i] = currentPath[orig + i];
        }
    }
    
    return newPath.slice(0, req + size);
};

const corridorMovePosition = (corridor: PathCorridor, newPos: Vec3, navMesh: NavMesh, filter: QueryFilter): boolean => {
    if (corridor.path.length === 0) return false;

    const result = moveAlongSurface(navMesh, corridor.path[0], corridor.position, newPos, filter);
    if (result.success) {
        // Update corridor path using the visited polygons (like Detour does)
        corridor.path = mergeCorridorStartMoved(corridor.path, result.visited, corridor.maxPath);
        
        // Update corridor position
        vec3.copy(corridor.position, result.resultPosition);
        return true;
    }
    return false;
};

const findCorridorCorners = (corridor: PathCorridor, navMesh: NavMesh, maxCorners: number): Vec3[] => {
    if (corridor.path.length === 0) return [];

    const straightPathResult = findStraightPath(navMesh, corridor.position, corridor.target, corridor.path, maxCorners);
    
    if (!straightPathResult.success || straightPathResult.path.length === 0) {
        return [];
    }

    // Get initial corners from findStraightPath
    let corners = straightPathResult.path.map((p) => p.position);
    
    // Prune points in the beginning of the path which are too close (like DetourPathCorridor)
    const MIN_TARGET_DIST = 0.01; // Same as DT_MIN_TARGET_DIST
    
    while (corners.length > 0) {
        const firstCorner = corners[0];
        const distance = vec3.distance(corridor.position, firstCorner);
        
        // If the first corner is far enough, we're done pruning
        if (distance > MIN_TARGET_DIST) {
            break;
        }
        
        // Remove the first corner as it's too close
        corners = corners.slice(1);
    }
    
    // Note: We don't need to prune off-mesh connections since nav3d doesn't expose 
    // the cornerFlags that would indicate DT_STRAIGHTPATH_OFFMESH_CONNECTION
    // This is a limitation of the current nav3d API
    
    return corners;
};

/* basic agent movement */

enum AgentState {
    INVALID,
    WALKING,
    WAITING,
}

enum AgentTargetState {
    NONE,
    REQUESTING,
    VALID,
    FAILED,
}

// Core agent type focused on movement
type Agent = {
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

const createAgent = (id: string, position: Vec3, maxSpeed: number, radius: number): Agent => {
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

const requestMoveTarget = (
    agent: Agent,
    targetRef: NodeRef,
    targetPos: Vec3,
    navMesh: NavMesh,
    filter: QueryFilter,
    targetMesh?: THREE.Mesh,
): void => {
    agent.targetRef = targetRef;
    vec3.copy(agent.target, targetPos);
    agent.targetState = AgentTargetState.REQUESTING;
    agent.state = AgentState.WALKING;
    agent.targetReplanTime = 0; // Reset replan timer

    if (targetMesh) {
        targetMesh.position.set(targetPos[0], targetPos[1] + 0.5, targetPos[2]);
    }

    console.log(`Agent ${agent.id} requesting move to target`);

    // Follow DetourCrowd pattern for immediate pathfinding
    if (agent.corridor.path.length > 0) {
        const status = initSlicedFindNodePath(
            navMesh,
            agent.slicedQuery,
            agent.corridor.path[0], // start from first poly in corridor
            targetRef,
            agent.corridor.position, // use corridor position, not agent position
            targetPos,
            filter,
        );

        if (status & SlicedFindNodePathStatusFlags.SUCCESS) {
            // Path found immediately - finalize it
            const finalResult = finalizeSlicedFindNodePath(agent.slicedQuery);
            if (finalResult.status & SlicedFindNodePathStatusFlags.SUCCESS && finalResult.pathCount > 0) {
                // Use setCorridor like DetourCrowd does
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

const updateAgentPathfinding = (agent: Agent, navMesh: NavMesh): void => {
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
    // Otherwise keep requesting (IN_PROGRESS)
};

const updateAgentMovement = (agent: Agent, navMesh: NavMesh, filter: QueryFilter, deltaTime: number, mesh?: THREE.Mesh): void => {
    // Update visual position if mesh is provided
    if (mesh) {
        mesh.position.set(agent.position[0], agent.position[1] + agent.radius, agent.position[2]);
    }

    // Debug: Log agent state occasionally
    if (Math.random() < 0.1) { // 10% of frames
        console.log(`Agent ${agent.id} movement debug:`, {
            state: agent.state,
            targetState: agent.targetState,
            position: agent.position,
            corridorPosition: agent.corridor.position,
            corridorPathLength: agent.corridor.path.length,
            corridorTarget: agent.corridor.target
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
                
                console.log(`Agent ${agent.id} calculated speed: ${speed.toFixed(3)} (scale: ${speedScale.toFixed(3)}, urgency: ${urgency.toFixed(3)})`);

                // Set desired velocity
                vec3.scale(agent.velocity, direction, speed);

                // Integrate movement with better collision handling
                const movement = vec3.scale([0, 0, 0], agent.velocity, deltaTime);
                const newPos = vec3.add([0, 0, 0], agent.position, movement);

                console.log(`Agent ${agent.id} attempting move from [${agent.position[0].toFixed(2)}, ${agent.position[1].toFixed(2)}, ${agent.position[2].toFixed(2)}] to [${newPos[0].toFixed(2)}, ${newPos[1].toFixed(2)}, ${newPos[2].toFixed(2)}]`);

                // Move corridor position (this handles collision with navmesh boundaries)
                if (corridorMovePosition(agent.corridor, newPos, navMesh, filter)) {
                    // Sync agent position with corridor
                    vec3.copy(agent.position, agent.corridor.position);
                    console.log(`Agent ${agent.id} moved successfully to [${agent.position[0].toFixed(2)}, ${agent.position[1].toFixed(2)}, ${agent.position[2].toFixed(2)}]`);
                } else {
                    // If corridor movement fails, stop the agent
                    vec3.set(agent.velocity, 0, 0, 0);
                    console.warn(`Agent ${agent.id} corridor movement failed`);
                }
            }
        } else {
            console.log(`Agent ${agent.id} target too close (${targetDistance.toFixed(3)}), skipping movement`);
        }

        // Check if reached target
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

const updateAgentVisualPath = (
    agent: Agent, 
    scene: THREE.Scene, 
    pathLine: THREE.Line | null, 
    polyHelpers: threeUtils.DebugObject[] | null,
    agentColor: number
): [THREE.Line | null, threeUtils.DebugObject[] | null] => {
    // Remove old path line
    if (pathLine) {
        scene.remove(pathLine);
        pathLine = null;
    }

    // Remove old polygon helpers
    if (polyHelpers) {
        for (const helper of polyHelpers) {
            scene.remove(helper.object);
        }
        polyHelpers = null;
    }

    // Create new polygon helpers array
    polyHelpers = [];

    // Get corridor path and create polygon visualizations
    if (agent.corridor.path.length > 0) {
        // Convert hex color to RGB array for createNavMeshPolyHelper
        const r = ((agentColor >> 16) & 255) / 255;
        const g = ((agentColor >> 8) & 255) / 255;
        const b = (agentColor & 255) / 255;
        const color: [number, number, number] = [r, g, b];

        // Create polygon helpers for each polygon in the corridor path
        for (const polyRef of agent.corridor.path) {
            const polyHelper = threeUtils.createNavMeshPolyHelper(navMesh, polyRef, color);
            
            // Make the polygons semi-transparent
            polyHelper.object.traverse((child: any) => {
                if (child instanceof THREE.Mesh && child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(mat => {
                            if (mat instanceof THREE.Material) {
                                mat.transparent = true;
                                mat.opacity = 0.3;
                            }
                        });
                    } else if (child.material instanceof THREE.Material) {
                        child.material.transparent = true;
                        child.material.opacity = 0.3;
                    }
                }
            });

            polyHelper.object.position.y += 0.15; // Adjust height for visibility
            
            polyHelpers.push(polyHelper);
            scene.add(polyHelper.object);
        }
    }

    // Create new path line
    const corners = findCorridorCorners(agent.corridor, navMesh, 20);
    if (corners.length > 1) {
        // Validate coordinates before creating THREE.js objects
        const validPoints: THREE.Vector3[] = [];

        // Add agent position
        if (Number.isFinite(agent.position[0]) && Number.isFinite(agent.position[1]) && Number.isFinite(agent.position[2])) {
            validPoints.push(new THREE.Vector3(agent.position[0], agent.position[1] + 0.2, agent.position[2]));
        }

        // Add corners
        for (const corner of corners) {
            if (Number.isFinite(corner[0]) && Number.isFinite(corner[1]) && Number.isFinite(corner[2])) {
                validPoints.push(new THREE.Vector3(corner[0], corner[1] + 0.2, corner[2]));
            } else {
                console.warn(`Invalid corner coordinate: [${corner[0]}, ${corner[1]}, ${corner[2]}]`);
            }
        }

        if (validPoints.length > 1) {
            const geometry = new THREE.BufferGeometry().setFromPoints(validPoints);
            const material = new THREE.LineBasicMaterial({ color: agentColor, linewidth: 2 });
            pathLine = new THREE.Line(geometry, material);
            scene.add(pathLine);
        }
    }

    return [pathLine, polyHelpers];
};

/* Leader and follower agents */

// Leader agent that contains base agent + timing + visuals
type LeaderAgent = {
    agent: Agent;

    // Timing for leader behavior
    lastTargetTime: number;
    targetInterval: number;

    // Visual components
    mesh: THREE.Mesh;
    targetMesh: THREE.Mesh;
    pathLine: THREE.Line | null;
    polyHelpers: threeUtils.DebugObject[] | null;
};

// Follower agent that contains base agent + visuals
type FollowerAgent = {
    agent: Agent;

    // Visual components
    mesh: THREE.Mesh;
    targetMesh: THREE.Mesh;
    pathLine: THREE.Line | null;
    polyHelpers: threeUtils.DebugObject[] | null;
};

const createLeaderAgent = (
    id: string,
    position: Vec3,
    scene: THREE.Scene,
    color: number,
    maxSpeed: number,
    radius: number,
): LeaderAgent => {
    // Create visual representation
    const geometry = new THREE.CapsuleGeometry(radius, radius * 2, 4, 8);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1] + radius, position[2]);
    scene.add(mesh);

    // Create target indicator
    const targetGeometry = new THREE.SphereGeometry(0.1);
    const targetMaterial = new THREE.MeshBasicMaterial({ color });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    scene.add(targetMesh);

    return {
        agent: createAgent(id, position, maxSpeed, radius),
        lastTargetTime: 0,
        targetInterval: 2000,
        mesh,
        targetMesh,
        pathLine: null,
        polyHelpers: null,
    };
};

const createFollowerAgent = (
    id: string,
    position: Vec3,
    scene: THREE.Scene,
    color: number,
    maxSpeed = 1.5,
    radius = 0.25,
): FollowerAgent => {
    // Create visual representation
    const geometry = new THREE.CapsuleGeometry(radius, radius * 2, 4, 8);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1] + radius, position[2]);
    scene.add(mesh);

    // Create target indicator
    const targetGeometry = new THREE.SphereGeometry(0.1);
    const targetMaterial = new THREE.MeshBasicMaterial({ color });
    const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    scene.add(targetMesh);

    return {
        agent: createAgent(id, position, maxSpeed, radius),
        mesh,
        targetMesh,
        pathLine: null,
        polyHelpers: null,
    };
};

const updateLeaderBehavior = (leaderAgent: LeaderAgent, navMesh: NavMesh, filter: QueryFilter, currentTime: number): void => {
    // Pick new random target every interval OR if agent is waiting (stuck)
    const timeSinceLastTarget = currentTime - leaderAgent.lastTargetTime;
    const shouldGetNewTarget = timeSinceLastTarget > leaderAgent.targetInterval;

    if (shouldGetNewTarget) {
        // Use findRandomPointAroundCircle for more localized movement
        const radius = 5.0; // Search radius around current position
        
        // Get current polygon reference for starting the circle search
        const halfExtents: Vec3 = [1, 1, 1];
        const nearestResult = createFindNearestPolyResult();
        findNearestPoly(nearestResult, navMesh, leaderAgent.agent.position, halfExtents, filter);
        
        if (nearestResult.success && nearestResult.nearestPolyRef) {
            const randomResult = findRandomPointAroundCircle(
                navMesh,
                nearestResult.nearestPolyRef,
                leaderAgent.agent.position,
                radius,
                filter,
                Math.random
            );
            
            if (randomResult.success) {
                requestMoveTarget(
                    leaderAgent.agent,
                    randomResult.randomRef,
                    randomResult.position,
                    navMesh,
                    filter,
                    leaderAgent.targetMesh,
                );
                leaderAgent.lastTargetTime = currentTime;
                console.log(
                    `Leader got new target: [${randomResult.position[0].toFixed(2)}, ${randomResult.position[1].toFixed(2)}, ${randomResult.position[2].toFixed(2)}]`,
                );
                return;
            }
        }
        
        // Fallback to global random point if circle search fails
        const fallbackResult = findRandomPoint(navMesh, filter, Math.random);
        if (fallbackResult.success) {
            requestMoveTarget(
                leaderAgent.agent,
                fallbackResult.ref,
                fallbackResult.position,
                navMesh,
                filter,
                leaderAgent.targetMesh,
            );
            leaderAgent.lastTargetTime = currentTime;
            console.log(
                `Leader got fallback target: [${fallbackResult.position[0].toFixed(2)}, ${fallbackResult.position[1].toFixed(2)}, ${fallbackResult.position[2].toFixed(2)}]`,
            );
        }
    }
};

const updateFollowerBehavior = (
    followerAgent: FollowerAgent,
    leaderAgent: LeaderAgent,
    navMesh: NavMesh,
    filter: QueryFilter,
): void => {
    // Follow leader if they're far enough away
    const distance = vec3.distance(followerAgent.agent.position, leaderAgent.agent.position);
    const followDistance = 1.0;

    // console.log(`Follower distance to leader: ${distance}, targetState: ${followerAgent.agent.targetState}`);

    if (distance > followDistance && followerAgent.agent.targetState === AgentTargetState.NONE) {
        // console.log(`Follower requesting new target towards leader`);

        // Find nearest poly to leader position
        const halfExtents: Vec3 = [1, 1, 1];
        const nearestResult = createFindNearestPolyResult();
        findNearestPoly(nearestResult, navMesh, leaderAgent.agent.position, halfExtents, filter);

        if (nearestResult.success && nearestResult.nearestPolyRef) {
            // console.log(`Follower found leader poly, requesting move`);
            requestMoveTarget(
                followerAgent.agent,
                nearestResult.nearestPolyRef,
                nearestResult.nearestPoint,
                navMesh,
                filter,
                followerAgent.targetMesh,
            );
        } else {
            console.warn(`Follower failed to find poly near leader`);
        }
    }
    //  else if (distance <= followDistance) {
    //     // console.log(`Follower close enough to leader (${distance} <= ${followDistance})`);
    // } else {
    //     // console.log(`Follower already has target (state: ${followerAgent.agent.targetState})`);
    // }
};

/* setup example scene */
const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const navTestModel = await loadGLTF('/models/nav-test.glb');
scene.add(navTestModel.scene);

/* generate navmesh */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = threeUtils.getPositionsAndIndices(walkableMeshes);

const navMeshInput: TiledNavMeshInput = {
    positions,
    indices,
};

const cellSize = 0.15;
const cellHeight = 0.15;

const tileSizeVoxels = 64;
const tileSizeWorld = tileSizeVoxels * cellSize;

const walkableRadiusWorld = 0.15;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 1;
const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);
const walkableSlopeAngleDegrees = 45;

const borderSize = 4;
const minRegionArea = 8;
const mergeRegionArea = 20;

const maxSimplificationError = 1.3;
const maxEdgeLength = 12;

const maxVerticesPerPoly = 5;
const detailSampleDistance = 6;
const detailSampleMaxError = 1;

const navMeshConfig: TiledNavMeshOptions = {
    cellSize,
    cellHeight,
    tileSizeVoxels,
    tileSizeWorld,
    walkableRadiusWorld,
    walkableRadiusVoxels,
    walkableClimbWorld,
    walkableClimbVoxels,
    walkableHeightWorld,
    walkableHeightVoxels,
    walkableSlopeAngleDegrees,
    borderSize,
    minRegionArea,
    mergeRegionArea,
    maxSimplificationError,
    maxEdgeLength,
    maxVerticesPerPoly,
    detailSampleDistance,
    detailSampleMaxError,
};

const navMeshResult = generateTiledNavMesh(navMeshInput, navMeshConfig);
const navMesh = navMeshResult.navMesh;

const navMeshHelper = threeUtils.createNavMeshHelper(navMesh);
navMeshHelper.object.position.y += 0.1;
scene.add(navMeshHelper.object);

/* create agents */
const startPosition: Vec3 = [-3, 0.5, 4];
const followerPosition: Vec3 = [-2, 0.5, 3];

// Create leader agent (blue)
const leader = createLeaderAgent('leader', startPosition, scene, 0x0000ff, 5, 0.3);
const follower = createFollowerAgent('follower', followerPosition, scene, 0x00ff00, 3, 0.25);

console.log('Created agents:', { leader: leader.agent.id, follower: follower.agent.id });
console.log('Leader mesh:', leader.mesh);
console.log('Follower mesh:', follower.mesh);

// Initialize agents
const filter = DEFAULT_QUERY_FILTER;
const halfExtents: Vec3 = [1, 1, 1];

// Initialize leader
const leaderNearestResult = createFindNearestPolyResult();
findNearestPoly(leaderNearestResult, navMesh, leader.agent.position, halfExtents, filter);
if (leaderNearestResult.success && leaderNearestResult.nearestPolyRef) {
    resetCorridor(leader.agent.corridor, leaderNearestResult.nearestPolyRef, leaderNearestResult.nearestPoint);
    // IMPORTANT: Sync agent position with corridor position (like DetourCrowd)
    vec3.copy(leader.agent.position, leader.agent.corridor.position);
    leader.agent.state = AgentState.WALKING;
    console.log('Leader initialized:');
    console.log('  Agent position:', leader.agent.position);
    console.log('  Corridor position:', leader.agent.corridor.position);
    console.log('  Corridor path length:', leader.agent.corridor.path.length);
    console.log('  First poly:', leader.agent.corridor.path[0]);

    // Give leader an immediate target
    const randomResult = findRandomPoint(navMesh, filter, Math.random);
    if (randomResult.success) {
        requestMoveTarget(leader.agent, randomResult.ref, randomResult.position, navMesh, filter, leader.targetMesh);
        console.log('Leader initial target set:', randomResult.position);
    }
}

// Initialize follower
const followerNearestResult = createFindNearestPolyResult();
findNearestPoly(followerNearestResult, navMesh, follower.agent.position, halfExtents, filter);
if (followerNearestResult.success && followerNearestResult.nearestPolyRef) {
    resetCorridor(follower.agent.corridor, followerNearestResult.nearestPolyRef, followerNearestResult.nearestPoint);
    vec3.copy(follower.agent.position, followerNearestResult.nearestPoint);
    follower.agent.state = AgentState.WALKING;
}

let lastTime = performance.now();

/* start loop */
function update() {
    requestAnimationFrame(update);

    const currentTime = performance.now();
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    // update leader behavior
    updateLeaderBehavior(leader, navMesh, filter, currentTime);

    // update follower behavior
    updateFollowerBehavior(follower, leader, navMesh, filter);

    // update agents
    updateAgentPathfinding(leader.agent, navMesh);
    updateAgentMovement(leader.agent, navMesh, filter, deltaTime, leader.mesh);
    [leader.pathLine, leader.polyHelpers] = updateAgentVisualPath(leader.agent, scene, leader.pathLine, leader.polyHelpers, 0x0000ff);

    updateAgentPathfinding(follower.agent, navMesh);
    updateAgentMovement(follower.agent, navMesh, filter, deltaTime, follower.mesh);
    [follower.pathLine, follower.polyHelpers] = updateAgentVisualPath(follower.agent, scene, follower.pathLine, follower.polyHelpers, 0x00ff00);

    orbitControls.update();
    renderer.render(scene, camera);
}

update();
