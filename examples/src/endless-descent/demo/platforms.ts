import Rapier from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import type { KinematicSurface } from '../temporal/types';

export type PlatformPath =
    | {
          kind: 'circle';
          center: THREE.Vector3;
          radius: number;
          speed: number;
          phase: number;
      }
    | {
          kind: 'line';
          start: THREE.Vector3;
          end: THREE.Vector3;
          period: number;
      };

export type PlatformConfig = {
    id: string;
    size: THREE.Vector2;
    height: number;
    path: PlatformPath;
    spawnTime: number;
};

export class MovingPlatform implements KinematicSurface {
    readonly id: string;
    readonly size: THREE.Vector2;
    readonly height: number;
    readonly path: PlatformPath;
    readonly mesh: THREE.Mesh;
    readonly body: Rapier.RigidBody;
    private readonly footprint: THREE.Vector3[];

    constructor(config: PlatformConfig, world: Rapier.World, material: THREE.Material) {
        this.id = config.id;
        this.size = config.size;
        this.height = config.height;
        this.path = config.path;
        const geometry = new THREE.BoxGeometry(config.size.x, 0.4, config.size.y);
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        this.footprint = Array.from({ length: 4 }, () => new THREE.Vector3());

        const rigidBodyDesc = Rapier.RigidBodyDesc.kinematicPositionBased();
        rigidBodyDesc.setTranslation(0, config.height, 0);
        this.body = world.createRigidBody(rigidBodyDesc);

        const colliderDesc = Rapier.ColliderDesc.cuboid(config.size.x / 2, 0.2, config.size.y / 2);
        world.createCollider(colliderDesc, this.body);
    }

    footprintAt(t: number): THREE.Vector3[] {
        const pose = this.poseAt(t);
        const halfX = this.size.x / 2;
        const halfZ = this.size.y / 2;
        const corners = [
            new THREE.Vector3(-halfX, 0, -halfZ),
            new THREE.Vector3(halfX, 0, -halfZ),
            new THREE.Vector3(halfX, 0, halfZ),
            new THREE.Vector3(-halfX, 0, halfZ),
        ];
        return corners.map((corner) => corner.applyQuaternion(pose.quaternion).add(pose.position.clone()).setY(this.height));
    }

    velocityAt(t: number): THREE.Vector3 {
        const delta = 0.05;
        const poseA = this.poseAt(t - delta);
        const poseB = this.poseAt(t + delta);
        const vel = poseB.position.clone().sub(poseA.position).multiplyScalar(1 / (2 * delta));
        return vel;
    }

    aabbAt(t: number): THREE.Box3 {
        const footprint = this.footprintAt(t);
        const box = new THREE.Box3();
        for (const point of footprint) {
            box.expandByPoint(point);
        }
        box.min.y = this.height - 0.1;
        box.max.y = this.height + 0.2;
        return box;
    }

    update(worldTime: number): void {
        const pose = this.poseAt(worldTime);
        this.mesh.position.copy(pose.position);
        this.mesh.quaternion.copy(pose.quaternion);
        this.body.setTranslation(pose.position, true);
        this.body.setRotation({ x: pose.quaternion.x, y: pose.quaternion.y, z: pose.quaternion.z, w: pose.quaternion.w }, true);
    }

    private poseAt(t: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
        switch (this.path.kind) {
            case 'circle': {
                const angle = this.path.phase + this.path.speed * t;
                const position = new THREE.Vector3(
                    this.path.center.x + Math.cos(angle) * this.path.radius,
                    this.height,
                    this.path.center.z + Math.sin(angle) * this.path.radius,
                );
                return { position, quaternion: new THREE.Quaternion() };
            }
            case 'line': {
                const halfPeriod = this.path.period / 2;
                const mod = ((t % this.path.period) + this.path.period) % this.path.period;
                const forward = mod <= halfPeriod;
                const localT = forward ? mod / halfPeriod : (this.path.period - mod) / halfPeriod;
                const position = this.path.start.clone().lerp(this.path.end, localT);
                position.y = this.height;
                return { position, quaternion: new THREE.Quaternion() };
            }
            default:
                return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
        }
    }
}

export class PlatformsManager {
    readonly world: Rapier.World;
    readonly platforms: MovingPlatform[] = [];
    private readonly material: THREE.Material;

    constructor(world: Rapier.World, scene: THREE.Scene) {
        this.world = world;
        this.material = new THREE.MeshStandardMaterial({ color: 0x4b9deb });
        scene.add(new THREE.AmbientLight(0x333333));
    }

    addPlatform(config: PlatformConfig, scene: THREE.Scene): MovingPlatform {
        const platform = new MovingPlatform(config, this.world, this.material);
        scene.add(platform.mesh);
        this.platforms.push(platform);
        return platform;
    }

    update(sceneTime: number): void {
        for (const platform of this.platforms) {
            platform.update(sceneTime);
        }
    }

    surfaces(): MovingPlatform[] {
        return this.platforms;
    }
}
