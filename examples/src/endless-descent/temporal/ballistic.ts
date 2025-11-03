import * as THREE from 'three';

export type LaunchSolution = {
    velocity: THREE.Vector3;
    horizontalSpeed: number;
};

export function solveLaunch(L: THREE.Vector3, C: THREE.Vector3, tau: number, g = 9.81): LaunchSolution {
    const dx = C.x - L.x;
    const dy = C.y - L.y;
    const dz = C.z - L.z;

    const v0x = dx / tau;
    const v0y = (dy + 0.5 * g * tau * tau) / tau;
    const v0z = dz / tau;

    const velocity = new THREE.Vector3(v0x, v0y, v0z);
    const horizontalSpeed = Math.hypot(v0x, v0z);

    return { velocity, horizontalSpeed };
}

export function sampleArc(
    origin: THREE.Vector3,
    velocity: THREE.Vector3,
    g: number,
    duration: number,
    segments: number,
): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = (duration * i) / segments;
        const point = new THREE.Vector3(
            origin.x + velocity.x * t,
            origin.y + velocity.y * t - 0.5 * g * t * t,
            origin.z + velocity.z * t,
        );
        points.push(point);
    }
    return points;
}

export function computeRunupDistance(targetHorizontalSpeed: number, initialSpeed: number, accel: number): number {
    const deltaV = Math.max(0, targetHorizontalSpeed - initialSpeed);
    return (deltaV * deltaV) / (2 * Math.max(accel, 1e-5));
}

export function estimateRunupTime(targetHorizontalSpeed: number, initialSpeed: number, accel: number): number {
    const deltaV = Math.max(0, targetHorizontalSpeed - initialSpeed);
    return deltaV / Math.max(accel, 1e-5);
}
