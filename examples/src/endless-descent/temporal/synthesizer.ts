import { DEFAULT_QUERY_FILTER, findPath, getTileAndPolyByRef, type NavMesh, type NodeRef, type QueryFilter } from 'navcat';
import * as THREE from 'three';
import { computeRunupDistance, estimateRunupTime, solveLaunch } from './ballistic';
import type { AgentKinodynamics, KinematicSurface, TemporalActionEdge } from './types';

const HALF_EXTENTS: [number, number, number] = [0.35, 1.0, 0.35];

export type TemporalSynthesizerConfig = {
    maxTau: number;
    minTau: number;
    tauStep: number;
    maxActionsPerEdge: number;
};

const defaultSynthConfig: TemporalSynthesizerConfig = {
    minTau: 0.6,
    maxTau: 2.8,
    tauStep: 0.1,
    maxActionsPerEdge: 3,
};

type BoundaryEdge = {
    a: THREE.Vector3;
    b: THREE.Vector3;
    midpoint: THREE.Vector3;
    inward: THREE.Vector3;
};

function extractBoundaryEdges(navMesh: NavMesh, nodeRef: NodeRef): BoundaryEdge[] {
    const result = getTileAndPolyByRef(nodeRef, navMesh);
    if (!result.success || !result.tile || !result.poly) return [];

    const tile = result.tile;
    const poly = result.poly;
    const vertices = poly.vertices.map((index) => {
        const start = index * 3;
        return new THREE.Vector3(tile.vertices[start], tile.vertices[start + 1], tile.vertices[start + 2]);
    });

    const center = vertices.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / vertices.length);

    const edges: BoundaryEdge[] = [];
    for (let i = 0; i < vertices.length; i++) {
        const j = (i + 1) % vertices.length;
        const a = vertices[i];
        const b = vertices[j];
        const neighbour = poly.neis?.[i];
        if (neighbour && neighbour !== 0) {
            continue;
        }
        const midpoint = a.clone().add(b).multiplyScalar(0.5);
        const inward = midpoint.clone().sub(center).normalize().negate();
        edges.push({ a: a.clone(), b: b.clone(), midpoint, inward });
    }
    return edges;
}

function sampleEdgePoints(edge: BoundaryEdge, samples: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < samples; i++) {
        const t = samples === 1 ? 0.5 : i / (samples - 1);
        points.push(edge.a.clone().lerp(edge.b, t));
    }
    return points;
}

function computeLandingMargin(footprint: THREE.Vector3[], landing: THREE.Vector3): number {
    if (footprint.length < 3) return 0;
    let min = Infinity;
    for (let i = 0; i < footprint.length; i++) {
        const a = footprint[i];
        const b = footprint[(i + 1) % footprint.length];
        const edge = new THREE.Vector2(b.x - a.x, b.z - a.z);
        const normal = new THREE.Vector2(-edge.y, edge.x).normalize();
        const point = new THREE.Vector2(landing.x - a.x, landing.z - a.z);
        const distance = normal.dot(point);
        min = Math.min(min, distance);
    }
    return min;
}

function sampleLandingPoints(footprint: THREE.Vector3[]): THREE.Vector3[] {
    if (footprint.length === 0) return [];
    const centroid = footprint.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / footprint.length);
    const points = [centroid];
    for (let i = 0; i < footprint.length; i++) {
        const next = footprint[(i + 1) % footprint.length];
        points.push(footprint[i].clone().lerp(next, 0.25));
        points.push(footprint[i].clone().lerp(next, 0.75));
    }
    return points;
}

function computePathLength(points: THREE.Vector3[]): number {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
        length += points[i - 1].distanceTo(points[i]);
    }
    return length;
}

function toVec3(vec: THREE.Vector3): [number, number, number] {
    return [vec.x, vec.y, vec.z];
}

function filterSurfacesByCone(
    surfaces: readonly KinematicSurface[],
    launchPoint: THREE.Vector3,
    inward: THREE.Vector3,
    now: number,
    lookahead: number,
): KinematicSurface[] {
    const maxDistance = 60;
    const coneCos = Math.cos(THREE.MathUtils.degToRad(80));
    const list: KinematicSurface[] = [];
    for (const surface of surfaces) {
        for (let t = now; t <= now + lookahead; t += lookahead / 4) {
            const footprint = surface.footprintAt(t);
            if (footprint.length === 0) continue;
            const centroid = footprint.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / footprint.length);
            const dir = centroid.clone().sub(launchPoint);
            const distance = dir.length();
            if (distance > maxDistance) continue;
            dir.normalize();
            if (dir.dot(inward.clone().negate()) > coneCos) {
                list.push(surface);
                break;
            }
        }
    }
    return list;
}

export type SynthesizerParams = {
    navMesh: NavMesh;
    nodeRef: NodeRef;
    agentPosition: THREE.Vector3;
    now: number;
    kin: AgentKinodynamics;
    surfaces: readonly KinematicSurface[];
    config?: Partial<TemporalSynthesizerConfig>;
    queryFilter?: QueryFilter;
};

export function synthesizeTemporalActions({
    navMesh,
    nodeRef,
    agentPosition,
    now,
    kin,
    surfaces,
    config,
    queryFilter = DEFAULT_QUERY_FILTER,
}: SynthesizerParams): TemporalActionEdge[] {
    const options: TemporalSynthesizerConfig = { ...defaultSynthConfig, ...(config ?? {}) };
    const edges = extractBoundaryEdges(navMesh, nodeRef);
    const actions: TemporalActionEdge[] = [];
    for (const edge of edges) {
        const launchSamples = sampleEdgePoints(edge, kin.ledgeSamples);
        for (const launchPoint of launchSamples) {
            const runDirection = edge.inward.clone().negate();
            runDirection.y = 0;
            if (runDirection.lengthSq() === 0) {
                runDirection.copy(launchPoint).sub(agentPosition).setY(0);
            }
            runDirection.normalize();
            const runupStart = launchPoint.clone().addScaledVector(edge.inward, 3.0);

            const pathResult = findPath(navMesh, toVec3(agentPosition), toVec3(runupStart), HALF_EXTENTS, queryFilter);
            if (!pathResult.success || pathResult.path.length === 0) {
                continue;
            }
            const pathPoints = pathResult.path.map((p) => new THREE.Vector3(p.position[0], p.position[1], p.position[2]));
            if (pathPoints.length === 0) continue;
            const dWalk = computePathLength(pathPoints);

            const candidateSurfaces = filterSurfacesByCone(surfaces, launchPoint, edge.inward, now, kin.lookahead);
            for (const surface of candidateSurfaces) {
                for (let tau = options.minTau; tau <= options.maxTau; tau += options.tauStep) {
                    for (let offset = kin.timeStep; offset <= kin.lookahead; offset += kin.timeStep) {
                        const hitTime = now + offset;
                        const launchTime = hitTime - tau;
                        if (launchTime < now) continue;
                        const footprint = surface.footprintAt(hitTime);
                        if (footprint.length === 0) continue;
                        const landingCandidates = sampleLandingPoints(footprint);
                        for (const landing of landingCandidates) {
                            const { velocity, horizontalSpeed } = solveLaunch(launchPoint, landing, tau, kin.g);
                            if (horizontalSpeed > kin.runMax) continue;
                            if (velocity.y < 0 || velocity.y > kin.jumpVMax) continue;
                            if (launchPoint.y - landing.y > kin.safeDrop) continue;

                            const runupDistance = computeRunupDistance(horizontalSpeed, 0, kin.runAccel);
                            if (runupDistance > dWalk + 2) continue;

                            const walkTime = dWalk / Math.max(kin.walkSpeed, 0.01);
                            const runupTime = estimateRunupTime(horizontalSpeed, 0, kin.runAccel);
                            const prepTime = walkTime + runupTime;
                            if (launchTime < now + prepTime) {
                                continue;
                            }

                            const margin = computeLandingMargin(footprint, landing);
                            if (margin < 0.2) continue;

                            const heading = new THREE.Vector3(velocity.x, 0, velocity.z);
                            if (heading.lengthSq() === 0) continue;
                            heading.normalize();

                            actions.push({
                                kind: 'JUMP',
                                fromNodeRef: nodeRef,
                                toSurfaceId: surface.id,
                                t0: launchTime,
                                tau,
                                launchPoint: launchPoint.clone(),
                                v0h: horizontalSpeed,
                                v0y: velocity.y,
                                heading,
                                runUp: runupDistance,
                                margin,
                                landingPoint: landing.clone(),
                                runupStart: runupStart.clone(),
                                approachPath: pathPoints.map((p) => p.clone()),
                            });
                        }
                    }
                }
            }
        }
    }
    actions.sort((a, b) => b.margin - a.margin);
    return actions.slice(0, options.maxActionsPerEdge * Math.max(1, edges.length));
}
