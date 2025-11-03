import { DEFAULT_QUERY_FILTER, createFindNearestPolyResult, findNearestPoly, type NavMesh } from 'navcat';
import * as THREE from 'three/webgpu';
import { synthesizeTemporalActions } from './synthesizer';
import type { AgentKinodynamics, KinematicSurface, TemporalPlan, TemporalPlanStep } from './types';

function toVec3(vec: THREE.Vector3): [number, number, number] {
    return [vec.x, vec.y, vec.z];
}

function createWaitStep(position: THREE.Vector3, tStart: number, tEnd: number): TemporalPlanStep {
    return { kind: 'WAIT', position: position.clone(), tStart, tEnd };
}

function createSurfaceStep(waypoints: THREE.Vector3[], tStart: number, tEnd: number): TemporalPlanStep {
    return { kind: 'SURFACE', waypoints: waypoints.map((p) => p.clone()), tStart, tEnd };
}

export function planSpatioTemporalPath(
    navMesh: NavMesh,
    startPos: THREE.Vector3,
    goalRegion: THREE.Box3,
    clockNow: number,
    kin: AgentKinodynamics,
    surfaces: KinematicSurface[],
): TemporalPlan {
    const nearest = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        toVec3(startPos),
        [0.5, 1.0, 0.5],
        DEFAULT_QUERY_FILTER,
    );

    if (!nearest.success) {
        return { steps: [], eta: 0, success: false };
    }

    const candidates = synthesizeTemporalActions({
        navMesh,
        nodeRef: nearest.nodeRef,
        agentPosition: startPos,
        now: clockNow,
        kin,
        surfaces,
    });

    if (candidates.length === 0) {
        return {
            steps: [createWaitStep(startPos, clockNow, clockNow + kin.timeStep)],
            eta: kin.timeStep,
            success: false,
        };
    }

    let best = candidates[0];
    let bestScore = best.t0 + best.tau;
    for (const candidate of candidates) {
        const score = candidate.t0 + candidate.tau;
        if (score < bestScore) {
            best = candidate;
            bestScore = score;
        }
    }

    const steps: TemporalPlanStep[] = [];

    const runupTime = best.v0h / Math.max(kin.runAccel, 0.01);
    const walkEndTime = Math.max(clockNow, best.t0 - runupTime);
    const surfaceWaypoints = [...best.approachPath.map((p) => p.clone()), best.launchPoint.clone()];
    if (surfaceWaypoints.length > 0) {
        steps.push(createSurfaceStep(surfaceWaypoints, clockNow, walkEndTime));
    }

    if (best.t0 - runupTime > walkEndTime) {
        steps.push(createWaitStep(best.launchPoint, walkEndTime, best.t0 - runupTime));
    }

    steps.push({ kind: 'ACTION', edge: best });

    const rideStart = best.t0;
    const rideEnd = best.t0 + best.tau;

    steps.push({ kind: 'RIDE', surfaceId: best.toSurfaceId, tStart: rideStart, tEnd: rideEnd });

    const success = goalRegion.containsPoint(best.landingPoint);
    const eta = rideEnd - clockNow;

    return { steps, eta, success };
}
