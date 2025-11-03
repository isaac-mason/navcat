import * as THREE from 'three';
import type { TemporalPlan, TemporalPlanActionStep } from '../temporal/types';

export class DebugDraw {
    private readonly scene: THREE.Scene;
    private readonly group: THREE.Group;

    constructor(scene: THREE.Scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);
    }

    clear(): void {
        this.scene.remove(this.group);
        this.group.clear();
        this.scene.add(this.group);
    }

    drawArc(points: THREE.Vector3[], color = 0xffffff): void {
        if (points.length < 2) return;
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(geometry, material);
        this.group.add(line);
    }

    drawPlan(plan: TemporalPlan, color = 0x7df9ff): void {
        for (const step of plan.steps) {
            if (step.kind === 'SURFACE') {
                this.drawArc(step.waypoints, color);
            }
            if (step.kind === 'ACTION') {
                this.drawAction(step, color);
            }
        }
    }

    private drawAction(step: TemporalPlanActionStep, color: number): void {
        const geometry = new THREE.BufferGeometry().setFromPoints([
            step.edge.launchPoint,
            step.edge.landingPoint,
        ]);
        const material = new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.25 });
        const line = new THREE.Line(geometry, material);
        line.computeLineDistances();
        this.group.add(line);
    }
}
