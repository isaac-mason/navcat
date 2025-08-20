import type { Vec3 } from 'maaths';
import { vec3 } from 'maaths';

const DT_PI = Math.PI;
const DT_MAX_PATTERN_DIVS = 32; // Max number of adaptive divs
const DT_MAX_PATTERN_RINGS = 4; // Max number of adaptive rings

export type ObstacleCircle = {
    /** Position of the obstacle */
    p: Vec3;
    /** Velocity of the obstacle */
    vel: Vec3;
    /** Desired velocity of the obstacle */
    dvel: Vec3;
    /** Radius of the obstacle */
    rad: number;
    /** Direction to obstacle center (used for side selection during sampling) */
    dp: Vec3;
    /** Normal pointing away from velocity (used for side selection during sampling) */
    np: Vec3;
};

export type ObstacleSegment = {
    /** End points of the obstacle segment */
    p: Vec3;
    q: Vec3;
    /** True if agent is very close to segment */
    touch: boolean;
};

export type ObstacleAvoidanceParams = {
    velBias: number;
    weightDesVel: number;
    weightCurVel: number;
    weightSide: number;
    weightToi: number;
    horizTime: number;
    gridSize: number; // for grid sampling
    adaptiveDivs: number; // for adaptive sampling
    adaptiveRings: number; // for adaptive sampling
    adaptiveDepth: number; // for adaptive sampling
};

export type ObstacleAvoidanceDebugData = {
    samples: Array<{
        vel: Vec3;
        ssize: number;
        pen: number;
        vpen: number;
        vcpen: number;
        spen: number;
        tpen: number;
    }>;
};

export type ObstacleAvoidanceQuery = {
    circles: ObstacleCircle[];
    segments: ObstacleSegment[];
    maxCircles: number;
    maxSegments: number;
    
    // Internal state for sampling
    params: ObstacleAvoidanceParams;
    invHorizTime: number;
    vmax: number;
    invVmax: number;
};

/**
 * Creates a new obstacle avoidance query.
 */
export const createObstacleAvoidanceQuery = (maxCircles: number, maxSegments: number): ObstacleAvoidanceQuery => ({
    circles: [],
    segments: [],
    maxCircles,
    maxSegments,
    params: {
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
    },
    invHorizTime: 0,
    vmax: 0,
    invVmax: 0,
});

/**
 * Creates debug data for obstacle avoidance.
 */
export const createObstacleAvoidanceDebugData = (): ObstacleAvoidanceDebugData => ({
    samples: [],
});

/**
 * Resets the obstacle avoidance query.
 */
export const resetObstacleAvoidanceQuery = (query: ObstacleAvoidanceQuery): void => {
    query.circles.length = 0;
    query.segments.length = 0;
};

/**
 * Resets debug data.
 */
export const resetObstacleAvoidanceDebugData = (debug: ObstacleAvoidanceDebugData): void => {
    debug.samples.length = 0;
};

/**
 * Adds a circular obstacle to the query.
 */
export const addCircleObstacle = (
    query: ObstacleAvoidanceQuery,
    pos: Vec3,
    rad: number,
    vel: Vec3,
    dvel: Vec3,
): void => {
    if (query.circles.length >= query.maxCircles) return;

    const circle: ObstacleCircle = {
        p: vec3.clone(pos),
        vel: vec3.clone(vel),
        dvel: vec3.clone(dvel),
        rad,
        dp: [0, 0, 0],
        np: [0, 0, 0],
    };

    query.circles.push(circle);
};

/**
 * Adds a segment obstacle to the query.
 */
export const addSegmentObstacle = (query: ObstacleAvoidanceQuery, p: Vec3, q: Vec3): void => {
    if (query.segments.length >= query.maxSegments) return;

    const segment: ObstacleSegment = {
        p: vec3.clone(p),
        q: vec3.clone(q),
        touch: false,
    };

    query.segments.push(segment);
};

/**
 * Helper function to calculate 2D triangle area.
 */
const triArea2D = (a: Vec3, b: Vec3, c: Vec3): number => {
    const abx = b[0] - a[0];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acz = c[2] - a[2];
    return acx * abz - abx * acz;
};

/**
 * Helper function to calculate 2D dot product.
 */
const vdot2D = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[2] * b[2];

/**
 * Helper function to calculate 2D perpendicular dot product.
 */
const vperp2D = (a: Vec3, b: Vec3): number => a[0] * b[2] - a[2] * b[0];

/**
 * Helper function to calculate 2D distance.
 */
const vdist2D = (a: Vec3, b: Vec3): number => {
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    return Math.sqrt(dx * dx + dz * dz);
};

/**
 * Helper function to calculate squared distance from point to segment in 2D.
 */
const distancePtSegSqr2D = (pt: Vec3, p: Vec3, q: Vec3): { distSqr: number; t: number } => {
    const pqx = q[0] - p[0];
    const pqz = q[2] - p[2];
    const dx = pt[0] - p[0];
    const dz = pt[2] - p[2];

    const d = pqx * pqx + pqz * pqz;
    let t = pqx * dx + pqz * dz;
    if (d > 0) t /= d;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const nearestX = p[0] + t * pqx;
    const nearestZ = p[2] + t * pqz;

    const distX = pt[0] - nearestX;
    const distZ = pt[2] - nearestZ;

    return { distSqr: distX * distX + distZ * distZ, t };
};

/**
 * Sweep test between two circles.
 */
const sweepCircleCircle = (
    c0: Vec3,
    r0: number,
    v: Vec3,
    c1: Vec3,
    r1: number,
): { hit: boolean; tmin: number; tmax: number } => {
    const EPS = 0.0001;
    
    const s: Vec3 = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
    const r = r0 + r1;
    const c = vdot2D(s, s) - r * r;
    const a = vdot2D(v, v);
    
    if (a < EPS) return { hit: false, tmin: 0, tmax: 0 }; // not moving

    // Overlap, calc time to exit.
    const b = vdot2D(v, s);
    const d = b * b - a * c;
    if (d < 0.0) return { hit: false, tmin: 0, tmax: 0 }; // no intersection

    const invA = 1.0 / a;
    const rd = Math.sqrt(d);
    const tmin = (b - rd) * invA;
    const tmax = (b + rd) * invA;
    
    return { hit: true, tmin, tmax };
};

/**
 * Ray-segment intersection test.
 */
const intersectRaySegment = (
    ap: Vec3,
    u: Vec3,
    bp: Vec3,
    bq: Vec3,
): { hit: boolean; t: number } => {
    const v: Vec3 = [bq[0] - bp[0], bq[1] - bp[1], bq[2] - bp[2]];
    const w: Vec3 = [ap[0] - bp[0], ap[1] - bp[1], ap[2] - bp[2]];
    
    const d = vperp2D(u, v);
    if (Math.abs(d) < 1e-6) return { hit: false, t: 0 };
    
    const invD = 1.0 / d;
    const t = vperp2D(v, w) * invD;
    if (t < 0 || t > 1) return { hit: false, t: 0 };
    
    const s = vperp2D(u, w) * invD;
    if (s < 0 || s > 1) return { hit: false, t: 0 };
    
    return { hit: true, t };
};

/**
 * Prepares obstacles for sampling by calculating side information.
 */
const prepareObstacles = (query: ObstacleAvoidanceQuery, pos: Vec3, dvel: Vec3): void => {
    // Prepare circular obstacles
    for (const cir of query.circles) {
        // Side calculation
        const pa = pos;
        const pb = cir.p;

        const orig: Vec3 = [0, 0, 0];
        vec3.sub(cir.dp, pb, pa);
        vec3.normalize(cir.dp, cir.dp);
        
        const dv: Vec3 = [0, 0, 0];
        vec3.sub(dv, cir.dvel, dvel);

        const a = triArea2D(orig, cir.dp, dv);
        if (a < 0.01) {
            cir.np[0] = -cir.dp[2];
            cir.np[1] = 0;
            cir.np[2] = cir.dp[0];
        } else {
            cir.np[0] = cir.dp[2];
            cir.np[1] = 0;
            cir.np[2] = -cir.dp[0];
        }
    }

    // Prepare segment obstacles
    for (const seg of query.segments) {
        // Check if agent is very close to segment
        const r = 0.01;
        const { distSqr } = distancePtSegSqr2D(pos, seg.p, seg.q);
        seg.touch = distSqr < r * r;
    }
};

/**
 * Process a velocity sample and calculate its penalty.
 */
const processSample = (
    query: ObstacleAvoidanceQuery,
    vcand: Vec3,
    cs: number,
    pos: Vec3,
    rad: number,
    vel: Vec3,
    dvel: Vec3,
    minPenalty: number,
    debug?: ObstacleAvoidanceDebugData,
): number => {
    const params = query.params;
    
    // Penalty for straying away from desired and current velocities
    const vpen = params.weightDesVel * (vdist2D(vcand, dvel) * query.invVmax);
    const vcpen = params.weightCurVel * (vdist2D(vcand, vel) * query.invVmax);

    // Find threshold hit time to bail out based on early out penalty
    const minPen = minPenalty - vpen - vcpen;
    const tThreshold = (params.weightToi / minPen - 0.1) * params.horizTime;
    if (tThreshold - params.horizTime > -Number.EPSILON) {
        return minPenalty; // already too much
    }

    // Find min time of impact and exit amongst all obstacles
    let tmin = params.horizTime;
    let side = 0;
    let nside = 0;

    // Check circular obstacles
    for (const cir of query.circles) {
        // RVO (Reciprocal Velocity Obstacles)
        const vab: Vec3 = [0, 0, 0];
        vec3.scale(vab, vcand, 2);
        vec3.sub(vab, vab, vel);
        vec3.sub(vab, vab, cir.vel);

        // Side bias
        side += Math.max(0, Math.min(1, Math.min(vdot2D(cir.dp, vab) * 0.5 + 0.5, vdot2D(cir.np, vab) * 2)));
        nside++;

        const sweep = sweepCircleCircle(pos, rad, vab, cir.p, cir.rad);
        if (!sweep.hit) continue;

        let htmin = sweep.tmin;
        const htmax = sweep.tmax;

        // Handle overlapping obstacles
        if (htmin < 0.0 && htmax > 0.0) {
            // Avoid more when overlapped
            htmin = -htmin * 0.5;
        }

        if (htmin >= 0.0) {
            // The closest obstacle is somewhere ahead of us
            if (htmin < tmin) {
                tmin = htmin;
                if (tmin < tThreshold) {
                    return minPenalty;
                }
            }
        }
    }

    // Check segment obstacles
    for (const seg of query.segments) {
        let htmin = 0;

        if (seg.touch) {
            // Special case when agent is very close to segment
            const sdir: Vec3 = [seg.q[0] - seg.p[0], seg.q[1] - seg.p[1], seg.q[2] - seg.p[2]];
            const snorm: Vec3 = [-sdir[2], sdir[1], sdir[0]];
            
            // If velocity is pointing towards segment, no collision
            if (vdot2D(snorm, vcand) < 0.0) continue;
            
            // Else immediate collision
            htmin = 0.0;
        } else {
            const intersection = intersectRaySegment(pos, vcand, seg.p, seg.q);
            if (!intersection.hit) continue;
            htmin = intersection.t;
        }

        // Avoid less when facing walls
        htmin *= 2.0;

        // Track nearest obstacle
        if (htmin < tmin) {
            tmin = htmin;
            if (tmin < tThreshold) {
                return minPenalty;
            }
        }
    }

    // Normalize side bias
    if (nside > 0) {
        side /= nside;
    }

    const spen = params.weightSide * side;
    const tpen = params.weightToi * (1.0 / (0.1 + tmin * query.invHorizTime));

    const penalty = vpen + vcpen + spen + tpen;

    // Store debug info
    if (debug) {
        debug.samples.push({
            vel: vec3.clone(vcand),
            ssize: cs,
            pen: penalty,
            vpen,
            vcpen,
            spen,
            tpen,
        });
    }

    return penalty;
};

/**
 * Sample velocity using grid-based approach.
 */
export const sampleVelocityGrid = (
    query: ObstacleAvoidanceQuery,
    pos: Vec3,
    rad: number,
    vmax: number,
    vel: Vec3,
    dvel: Vec3,
    params: ObstacleAvoidanceParams,
    debug?: ObstacleAvoidanceDebugData,
): { nvel: Vec3; samples: number } => {
    prepareObstacles(query, pos, dvel);

    query.params = { ...params };
    query.invHorizTime = 1.0 / params.horizTime;
    query.vmax = vmax;
    query.invVmax = vmax > 0 ? 1.0 / vmax : Number.MAX_VALUE;

    const nvel: Vec3 = [0, 0, 0];

    if (debug) {
        resetObstacleAvoidanceDebugData(debug);
    }

    const cvx = dvel[0] * params.velBias;
    const cvz = dvel[2] * params.velBias;
    const cs = (vmax * 2 * (1 - params.velBias)) / (params.gridSize - 1);
    const half = ((params.gridSize - 1) * cs) * 0.5;

    let minPenalty = Number.MAX_VALUE;
    let ns = 0;

    for (let y = 0; y < params.gridSize; ++y) {
        for (let x = 0; x < params.gridSize; ++x) {
            const vcand: Vec3 = [
                cvx + x * cs - half,
                0,
                cvz + y * cs - half,
            ];

            if (vcand[0] * vcand[0] + vcand[2] * vcand[2] > (vmax + cs / 2) * (vmax + cs / 2)) {
                continue;
            }

            const penalty = processSample(query, vcand, cs, pos, rad, vel, dvel, minPenalty, debug);
            ns++;
            
            if (penalty < minPenalty) {
                minPenalty = penalty;
                vec3.copy(nvel, vcand);
            }
        }
    }

    return { nvel, samples: ns };
};

/**
 * Normalize a 2D vector (ignoring Y component).
 */
const normalize2D = (v: Vec3): void => {
    const d = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
    if (d === 0) return;
    const invD = 1.0 / d;
    v[0] *= invD;
    v[2] *= invD;
};

/**
 * Rotate a 2D vector (ignoring Y component).
 */
const rotate2D = (dest: Vec3, v: Vec3, ang: number): void => {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    dest[0] = v[0] * c - v[2] * s;
    dest[2] = v[0] * s + v[2] * c;
    dest[1] = v[1];
};

/**
 * Sample velocity using adaptive approach.
 */
export const sampleVelocityAdaptive = (
    query: ObstacleAvoidanceQuery,
    pos: Vec3,
    rad: number,
    vmax: number,
    vel: Vec3,
    dvel: Vec3,
    params: ObstacleAvoidanceParams,
    debug?: ObstacleAvoidanceDebugData,
): { nvel: Vec3; samples: number } => {
    prepareObstacles(query, pos, dvel);

    query.params = { ...params };
    query.invHorizTime = 1.0 / params.horizTime;
    query.vmax = vmax;
    query.invVmax = vmax > 0 ? 1.0 / vmax : Number.MAX_VALUE;

    const nvel: Vec3 = [0, 0, 0];

    if (debug) {
        resetObstacleAvoidanceDebugData(debug);
    }

    // Build sampling pattern aligned to desired velocity
    const pat: number[] = [];
    let npat = 0;

    const ndivs = Math.max(1, Math.min(params.adaptiveDivs, DT_MAX_PATTERN_DIVS));
    const nrings = Math.max(1, Math.min(params.adaptiveRings, DT_MAX_PATTERN_RINGS));
    const depth = params.adaptiveDepth;

    const da = (1.0 / ndivs) * DT_PI * 2;
    const ca = Math.cos(da);
    const sa = Math.sin(da);

    // Desired direction
    const ddir: Vec3 = vec3.clone(dvel);
    normalize2D(ddir);
    const ddir2: Vec3 = [0, 0, 0];
    rotate2D(ddir2, ddir, da * 0.5); // rotated by da/2

    // Always add sample at zero
    pat.push(0, 0);
    npat++;

    for (let j = 0; j < nrings; ++j) {
        const r = (nrings - j) / nrings;
        const baseDir = j % 2 === 0 ? ddir : ddir2;
        
        pat.push(baseDir[0] * r, baseDir[2] * r);
        let last1Idx = (npat - 1) * 2;
        let last2Idx = last1Idx;
        npat++;

        for (let i = 1; i < ndivs - 1; i += 2) {
            // Get next point on the "right" (rotate CW)
            const rightX = pat[last1Idx] * ca + pat[last1Idx + 1] * sa;
            const rightZ = -pat[last1Idx] * sa + pat[last1Idx + 1] * ca;
            pat.push(rightX, rightZ);

            // Get next point on the "left" (rotate CCW)
            const leftX = pat[last2Idx] * ca - pat[last2Idx + 1] * sa;
            const leftZ = pat[last2Idx] * sa + pat[last2Idx + 1] * ca;
            pat.push(leftX, leftZ);

            last1Idx = (npat - 1) * 2;
            last2Idx = npat * 2;
            npat += 2;
        }

        if ((ndivs & 1) === 0) {
            const lastX = pat[last2Idx] * ca - pat[last2Idx + 1] * sa;
            const lastZ = pat[last2Idx] * sa + pat[last2Idx + 1] * ca;
            pat.push(lastX, lastZ);
            npat++;
        }
    }

    // Start sampling
    let cr = vmax * (1.0 - params.velBias);
    const res: Vec3 = [dvel[0] * params.velBias, 0, dvel[2] * params.velBias];
    let ns = 0;

    for (let k = 0; k < depth; ++k) {
        let minPenalty = Number.MAX_VALUE;
        const bvel: Vec3 = [0, 0, 0];

        for (let i = 0; i < npat; ++i) {
            const vcand: Vec3 = [
                res[0] + pat[i * 2] * cr,
                0,
                res[2] + pat[i * 2 + 1] * cr,
            ];

            if (vcand[0] * vcand[0] + vcand[2] * vcand[2] > (vmax + 0.001) * (vmax + 0.001)) {
                continue;
            }

            const penalty = processSample(query, vcand, cr / 10, pos, rad, vel, dvel, minPenalty, debug);
            ns++;
            
            if (penalty < minPenalty) {
                minPenalty = penalty;
                vec3.copy(bvel, vcand);
            }
        }

        vec3.copy(res, bvel);
        cr *= 0.5;
    }

    vec3.copy(nvel, res);
    return { nvel, samples: ns };
};