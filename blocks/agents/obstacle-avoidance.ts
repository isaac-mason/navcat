import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';

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
    circleCount: number;
    segmentCount: number;
    
    // Internal state for sampling
    params: ObstacleAvoidanceParams;
    invHorizTime: number;
    vmax: number;
    invVmax: number;
    
    // Pre-allocated pattern array for adaptive sampling
    pattern: Float32Array;
};

/**
 * Creates a new obstacle avoidance query.
 */
export const createObstacleAvoidanceQuery = (maxCircles: number, maxSegments: number): ObstacleAvoidanceQuery => {
    // pre-allocate obstacle objects
    const circles: ObstacleCircle[] = [];
    const segments: ObstacleSegment[] = [];
    
    for (let i = 0; i < maxCircles; i++) {
        circles.push({
            p: [0, 0, 0],
            vel: [0, 0, 0],
            dvel: [0, 0, 0],
            rad: 0,
            dp: [0, 0, 0],
            np: [0, 0, 0],
        });
    }
    
    for (let i = 0; i < maxSegments; i++) {
        segments.push({
            p: [0, 0, 0],
            q: [0, 0, 0],
            touch: false,
        });
    }
    
    return {
        circles,
        segments,
        maxCircles,
        maxSegments,
        circleCount: 0,
        segmentCount: 0,
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
        pattern: new Float32Array((DT_MAX_PATTERN_DIVS * DT_MAX_PATTERN_RINGS + 1) * 2),
    };
};

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
    query.circleCount = 0;
    query.segmentCount = 0;
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
    if (query.circleCount >= query.maxCircles) return;

    const circle = query.circles[query.circleCount];
    
    // Copy data to pre-allocated object
    vec3.copy(circle.p, pos);
    vec3.copy(circle.vel, vel);
    vec3.copy(circle.dvel, dvel);
    circle.rad = rad;
    
    // Reset computed values
    vec3.set(circle.dp, 0, 0, 0);
    vec3.set(circle.np, 0, 0, 0);

    query.circleCount++;
};

/**
 * Adds a segment obstacle to the query.
 */
export const addSegmentObstacle = (query: ObstacleAvoidanceQuery, p: Vec3, q: Vec3): void => {
    if (query.segmentCount >= query.maxSegments) return;

    const segment = query.segments[query.segmentCount];
    
    // Copy data to pre-allocated object
    vec3.copy(segment.p, p);
    vec3.copy(segment.q, q);
    segment.touch = false;

    query.segmentCount++;
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
const distancePtSegSqr2D = (pt: Vec3, p: Vec3, q: Vec3): number => {
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

    return distX * distX + distZ * distZ;
};

const _sweepCircleCircle_s = vec3.create();

/**
 * Sweep test between two circles.
 */
const sweepCircleCircle = (
    c0: Vec3,
    r0: number,
    v: Vec3,
    c1: Vec3,
    r1: number,
    out: { hit: boolean; tmin: number; tmax: number },
): void => {
    const EPS = 0.0001;

    const s = _sweepCircleCircle_s;
    const sx = c1[0] - c0[0];
    const sz = c1[2] - c0[2];
    s[0] = sx;
    s[1] = 0;  // Not used, but keep vector valid
    s[2] = sz;
    
    const r = r0 + r1;
    
    // vdot2D(s, s)
    const sSqr = sx * sx + sz * sz;
    const c = sSqr - r * r;
    
    // vdot2D(v, v)
    const a = v[0] * v[0] + v[2] * v[2];
    
    if (a < EPS) {
        out.hit = false;
        out.tmin = 0;
        out.tmax = 0;
        return;
    }

    // vdot2D(v, s)
    const b = v[0] * sx + v[2] * sz;
    const d = b * b - a * c;
    
    if (d < 0.0) {
        out.hit = false;
        out.tmin = 0;
        out.tmax = 0;
        return;
    }

    const invA = 1.0 / a;
    const rd = Math.sqrt(d);
    out.hit = true;
    out.tmin = (b - rd) * invA;
    out.tmax = (b + rd) * invA;
};

const _intersectRaySegment_v = vec3.create();
const _intersectRaySegment_w = vec3.create();

/**
 * Ray-segment intersection test.
 */
const intersectRaySegment = (
    ap: Vec3,
    u: Vec3,
    bp: Vec3,
    bq: Vec3,
    out: { hit: boolean; t: number },
): void => {
    const v = _intersectRaySegment_v;
    v[0] = bq[0] - bp[0];
    v[1] = bq[1] - bp[1];
    v[2] = bq[2] - bp[2];
    
    const w = _intersectRaySegment_w;
    w[0] = ap[0] - bp[0];
    w[1] = ap[1] - bp[1];
    w[2] = ap[2] - bp[2];
    
    const d = vperp2D(u, v);
    if (Math.abs(d) < 1e-6) {
        out.hit = false;
        out.t = 0;
        return;
    }
    
    const invD = 1.0 / d;
    const t = vperp2D(v, w) * invD;
    if (t < 0 || t > 1) {
        out.hit = false;
        out.t = 0;
        return;
    }
    
    const s = vperp2D(u, w) * invD;
    if (s < 0 || s > 1) {
        out.hit = false;
        out.t = 0;
        return;
    }
    
    out.hit = true;
    out.t = t;
};

const _prepareObstacles_orig = vec3.create();
const _prepareObstacles_dv = vec3.create();

/**
 * Prepares obstacles for sampling by calculating side information.
 */
const prepareObstacles = (query: ObstacleAvoidanceQuery, pos: Vec3, dvel: Vec3): void => {
    // prepare circular obstacles
    for (let i = 0; i < query.circleCount; i++) {
        const cir = query.circles[i];
        
        // side calculation
        const pa = pos;
        const pb = cir.p;

        const orig = vec3.set(_prepareObstacles_orig, 0, 0, 0);
        vec3.sub(cir.dp, pb, pa);
        vec3.normalize(cir.dp, cir.dp);
        
        const dv = vec3.sub(_prepareObstacles_dv, cir.dvel, dvel);

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
    for (let i = 0; i < query.segmentCount; i++) {
        const seg = query.segments[i];
        
        // Precalc if the agent is really close to the segment
        const r = 0.01;
        const distSqr = distancePtSegSqr2D(pos, seg.p, seg.q);
        seg.touch = distSqr < r * r;
    }
};

/**
 * Copies parameters to avoid object allocation.
 */
const copyParams = (dest: ObstacleAvoidanceParams, src: ObstacleAvoidanceParams): void => {
    dest.velBias = src.velBias;
    dest.weightDesVel = src.weightDesVel;
    dest.weightCurVel = src.weightCurVel;
    dest.weightSide = src.weightSide;
    dest.weightToi = src.weightToi;
    dest.horizTime = src.horizTime;
    dest.gridSize = src.gridSize;
    dest.adaptiveDivs = src.adaptiveDivs;
    dest.adaptiveRings = src.adaptiveRings;
    dest.adaptiveDepth = src.adaptiveDepth;
};

const _vab = vec3.create();
const _sdir = vec3.create();
const _snorm = vec3.create();
const _sweepResult = { hit: false, tmin: 0, tmax: 0 };
const _intersectionResult = { hit: false, t: 0 };

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
    
    // penalty for straying away from desired and current velocities
    const vpen = params.weightDesVel * (vdist2D(vcand, dvel) * query.invVmax);
    const vcpen = params.weightCurVel * (vdist2D(vcand, vel) * query.invVmax);

    // find threshold hit time to bail out based on early out penalty
    const minPen = minPenalty - vpen - vcpen;
    const tThreshold = (params.weightToi / minPen - 0.1) * params.horizTime;
    if (tThreshold - params.horizTime > -Number.EPSILON) {
        return minPenalty; // already too much
    }

    // find min time of impact and exit amongst all obstacles
    let tmin = params.horizTime;
    let side = 0;
    let nside = 0;

    // check circular obstacles
    for (let i = 0; i < query.circleCount; i++) {
        const cir = query.circles[i];
        // RVO (Reciprocal Velocity Obstacles)
        // vec3.scale(vab, vcand, 2);
        // vec3.sub(vab, vab, vel);
        // vec3.sub(vab, vab, cir.vel);
        const vab = _vab;
        vab[0] = vcand[0] * 2 - vel[0] - cir.vel[0];
        vab[1] = vcand[1] * 2 - vel[1] - cir.vel[1];
        vab[2] = vcand[2] * 2 - vel[2] - cir.vel[2];

        // side bias
        side += Math.max(0, Math.min(1, Math.min(vdot2D(cir.dp, vab) * 0.5 + 0.5, vdot2D(cir.np, vab) * 2)));
        nside++;

        sweepCircleCircle(pos, rad, vab, cir.p, cir.rad, _sweepResult);
        if (!_sweepResult.hit) continue;

        let htmin = _sweepResult.tmin;
        const htmax = _sweepResult.tmax;

        // handle overlapping obstacles
        if (htmin < 0.0 && htmax > 0.0) {
            // avoid more when overlapped
            htmin = -htmin * 0.5;
        }

        if (htmin >= 0.0) {
            // the closest obstacle is somewhere ahead of us
            if (htmin < tmin) {
                tmin = htmin;
                if (tmin < tThreshold) {
                    return minPenalty;
                }
            }
        }
    }

    // check segment obstacles
    for (let i = 0; i < query.segmentCount; i++) {
        const seg = query.segments[i];
        let htmin = 0;

        if (seg.touch) {
            // special case when agent is very close to segment
            const sdir = vec3.set(_sdir, seg.q[0] - seg.p[0], seg.q[1] - seg.p[1], seg.q[2] - seg.p[2]);
            const snorm = vec3.set(_snorm, -sdir[2], sdir[1], sdir[0]);

            // if the velocity is pointing towards the segment, no collision.
            if (vdot2D(snorm, vcand) < 0.0) continue;
            
            // else immediate collision.
            htmin = 0.0;
        } else {
            intersectRaySegment(pos, vcand, seg.p, seg.q, _intersectionResult);
            if (!_intersectionResult.hit) continue;
            htmin = _intersectionResult.t;
        }

        // avoid less when facing walls
        htmin *= 2.0;

        // track nearest obstacle
        if (htmin < tmin) {
            tmin = htmin;
            if (tmin < tThreshold) {
                return minPenalty;
            }
        }
    }

    // normalize side bias
    if (nside > 0) {
        side /= nside;
    }

    const spen = params.weightSide * side;
    const tpen = params.weightToi * (1.0 / (0.1 + tmin * query.invHorizTime));

    const penalty = vpen + vcpen + spen + tpen;

    // store debug info
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

const _sampleVelocityGrid_vcand = vec3.create();

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

    copyParams(query.params, params);
    query.invHorizTime = 1.0 / query.params.horizTime;
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
    
    // pre-compute vmax squared for bounds checking
    const vmaxPlusHalfCs = vmax + cs / 2;
    const vmaxSqr = vmaxPlusHalfCs * vmaxPlusHalfCs;

    for (let y = 0; y < params.gridSize; ++y) {
        for (let x = 0; x < params.gridSize; ++x) {
            const vcand = _sampleVelocityGrid_vcand;
            vcand[0] = cvx + x * cs - half;
            vcand[1] = 0;
            vcand[2] = cvz + y * cs - half;

            if (vcand[0] * vcand[0] + vcand[2] * vcand[2] > vmaxSqr) {
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

const _sampleVelocityAdaptive_ddir = vec3.create();
const _sampleVelocityAdaptive_ddir2 = vec3.create();
const _sampleVelocityAdaptive_res = vec3.create();
const _sampleVelocityAdaptive_bvel = vec3.create();
const _sampleVelocityAdaptive_vcand = vec3.create();

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
    outVelocity: Vec3,
    debug?: ObstacleAvoidanceDebugData,
): number => {
    prepareObstacles(query, pos, dvel);

    copyParams(query.params, params);
    query.invHorizTime = 1.0 / query.params.horizTime;
    query.vmax = vmax;
    query.invVmax = vmax > 0 ? 1.0 / vmax : Number.MAX_VALUE;

    if (debug) {
        resetObstacleAvoidanceDebugData(debug);
    }

    // build sampling pattern aligned to desired velocity
    const pat = query.pattern;
    let npat = 0;

    const ndivs = Math.max(1, Math.min(query.params.adaptiveDivs, DT_MAX_PATTERN_DIVS));
    const nrings = Math.max(1, Math.min(query.params.adaptiveRings, DT_MAX_PATTERN_RINGS));
    const depth = query.params.adaptiveDepth;

    const da = (1.0 / ndivs) * DT_PI * 2;
    const ca = Math.cos(da);
    const sa = Math.sin(da);

    // desired direction - use pre-allocated vectors to avoid cloning
    const ddir = _sampleVelocityAdaptive_ddir;
    vec3.copy(ddir, dvel);
    normalize2D(ddir);
    
    const ddir2 = _sampleVelocityAdaptive_ddir2;
    rotate2D(ddir2, ddir, da * 0.5); // rotated by da/2

    // always add sample at zero
    pat[npat * 2] = 0;
    pat[npat * 2 + 1] = 0;
    npat++;

    for (let j = 0; j < nrings; ++j) {
        const r = (nrings - j) / nrings;
        // use pattern similar to C++: ddir[(j%2)*3] selects between ddir and ddir2
        const baseDir = j % 2 === 0 ? ddir : ddir2;
        
        pat[npat * 2] = baseDir[0] * r;
        pat[npat * 2 + 1] = baseDir[2] * r;
        let last1 = npat * 2;    // Points to current element
        let last2 = last1;       // Both point to same location initially
        npat++;

        for (let i = 1; i < ndivs - 1; i += 2) {
            // Get next point on the "right" (rotate CW)
            pat[npat * 2] = pat[last1] * ca + pat[last1 + 1] * sa;
            pat[npat * 2 + 1] = -pat[last1] * sa + pat[last1 + 1] * ca;
            
            // Get next point on the "left" (rotate CCW)  
            pat[npat * 2 + 2] = pat[last2] * ca - pat[last2 + 1] * sa;
            pat[npat * 2 + 3] = pat[last2] * sa + pat[last2 + 1] * ca;

            last1 = npat * 2;       // Point to current "right" element
            last2 = last1 + 2;      // Point to current "left" element
            npat += 2;
        }

        if ((ndivs & 1) === 0) {
            pat[npat * 2] = pat[last2] * ca - pat[last2 + 1] * sa;
            pat[npat * 2 + 1] = pat[last2] * sa + pat[last2 + 1] * ca;
            npat++;
        }
    }

    // start sampling
    let cr = vmax * (1.0 - query.params.velBias);
    const res = _sampleVelocityAdaptive_res;
    res[0] = dvel[0] * query.params.velBias;
    res[1] = 0;
    res[2] = dvel[2] * query.params.velBias;
    
    let ns = 0;
    
    // pre-compute vmax squared for bounds checking
    const vmaxPlusEpsilon = vmax + 0.001;
    const vmaxSqr = vmaxPlusEpsilon * vmaxPlusEpsilon;

    for (let k = 0; k < depth; ++k) {
        let minPenalty = Number.MAX_VALUE;
        const bvel = _sampleVelocityAdaptive_bvel;
        vec3.set(bvel, 0, 0, 0);
        
        // Cache cr / 10 for this depth iteration
        const crOverTen = cr * 0.1;

        for (let i = 0; i < npat; ++i) {
            const vcand = _sampleVelocityAdaptive_vcand;
            vcand[0] = res[0] + pat[i * 2] * cr;
            vcand[1] = 0;
            vcand[2] = res[2] + pat[i * 2 + 1] * cr;

            if (vcand[0] * vcand[0] + vcand[2] * vcand[2] > vmaxSqr) {
                continue;
            }

            const penalty = processSample(query, vcand, crOverTen, pos, rad, vel, dvel, minPenalty, debug);
            ns++;
            
            if (penalty < minPenalty) {
                minPenalty = penalty;
                vec3.copy(bvel, vcand);
            }
        }

        vec3.copy(res, bvel);
        cr *= 0.5;
    }

    vec3.copy(outVelocity, res);
    return ns;
};