import type * as THREE from 'three/webgpu';
import type { NavMesh, NodeRef } from 'navcat';

export type AgentKinodynamics = {
    g: number;
    walkSpeed: number;
    runMax: number;
    runAccel: number;
    jumpVMax: number;
    safeDrop: number;
    lookahead: number;
    timeStep: number;
    ledgeSamples: number;
};

export type KinematicSurface = {
    id: string;
    footprintAt(t: number): THREE.Vector3[];
    velocityAt(t: number): THREE.Vector3;
    aabbAt(t: number): THREE.Box3;
};

export type TemporalActionEdge = {
    kind: 'JUMP';
    fromNodeRef: NodeRef;
    toSurfaceId: string;
    t0: number;
    tau: number;
    launchPoint: THREE.Vector3;
    landingPoint: THREE.Vector3;
    v0h: number;
    v0y: number;
    heading: THREE.Vector3;
    runUp: number;
    margin: number;
    runupStart: THREE.Vector3;
    approachPath: THREE.Vector3[];
};

export type TemporalNode = {
    nodeRef: NodeRef;
    tIdx: number;
};

export type TemporalPlanSurfaceStep = {
    kind: 'SURFACE';
    waypoints: THREE.Vector3[];
    tStart: number;
    tEnd: number;
};

export type TemporalPlanWaitStep = {
    kind: 'WAIT';
    position: THREE.Vector3;
    tStart: number;
    tEnd: number;
};

export type TemporalPlanActionStep = {
    kind: 'ACTION';
    edge: TemporalActionEdge;
};

export type TemporalPlanRideStep = {
    kind: 'RIDE';
    surfaceId: string;
    tStart: number;
    tEnd: number;
};

export type TemporalPlanStep =
    | TemporalPlanSurfaceStep
    | TemporalPlanWaitStep
    | TemporalPlanActionStep
    | TemporalPlanRideStep;

export type TemporalPlan = {
    steps: TemporalPlanStep[];
    eta: number;
    success: boolean;
};

export type TemporalPlanContext = {
    navMesh: NavMesh;
    kin: AgentKinodynamics;
    surfaces: Map<string, KinematicSurface>;
};
