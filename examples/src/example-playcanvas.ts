import type { Vec3 } from 'mathcat';
import {
    DEFAULT_QUERY_FILTER,
    FindStraightPathResultFlags,
    findPath,
    getNodeRefType,
    NodeType,
} from 'navcat';
import * as pc from 'playcanvas';
import {
    generateTiledNavMesh,
    type TiledNavMeshInput,
    type TiledNavMeshOptions,
} from 'navcat/blocks';
import {
    createNavMeshHelper,
    createNavMeshPolyHelper,
    createSearchNodesHelper,
    getPositionsAndIndices,
} from 'navcat/playcanvas';

type Visual = { object: pc.Entity; dispose: () => void };

/* Helper: Create PlayCanvas application with basic setup */
async function createExampleBase() {
    let canvas = document.getElementById('canvas') as HTMLCanvasElement | null;

    // Create canvas if it doesn't exist
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'canvas';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        const root = document.getElementById('root');
        if (root) {
            root.appendChild(canvas);
        } else {
            document.body.appendChild(canvas);
        }
    }

    const app = new pc.Application(canvas, {
        mouse: new pc.Mouse(canvas),
        keyboard: new pc.Keyboard(canvas),
        touch: new pc.TouchDevice(canvas),
        graphicsDeviceOptions: {
            antialias: true,
        },
    });

    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);

    // Create camera entity
    const camera = new pc.Entity();
    camera.addComponent('camera', {
        clearColor: new pc.Color(0.2, 0.2, 0.2),
        fov: 75,
    });
    camera.setPosition(0, 10, 20);
    camera.lookAt(0, 0, 0);
    app.root.addChild(camera);

    // Create lighting
    const ambientLight = new pc.Entity();
    ambientLight.addComponent('light', {
        type: 'directional',
        color: new pc.Color(1, 1, 1),
        intensity: 0.5,
    });
    ambientLight.setEulerAngles(-45, 45, 0);
    app.root.addChild(ambientLight);

    const directionalLight = new pc.Entity();
    directionalLight.addComponent('light', {
        type: 'directional',
        color: new pc.Color(1, 1, 1),
        intensity: 1,
    });
    directionalLight.setPosition(5, 10, 5);
    directionalLight.lookAt(0, 0, 0);
    app.root.addChild(directionalLight);

    window.addEventListener('resize', () => {
        app.resizeCanvas();
    });

    app.start();

    return { app, camera, canvas };
}

/* Helper: Load GLTF model */
async function loadGLTF(app: pc.Application, url: string): Promise<pc.Entity> {
    return new Promise((resolve, reject) => {
        const containerAsset = new pc.Asset(url, 'container', { url });

        containerAsset.on('load', () => {
            // Container asset creates entities automatically
            const containerResource = containerAsset.resource as pc.ContainerResource;

            // Create parent entity to hold the instantiated model
            const modelEntity = new pc.Entity('Model');
            app.root.addChild(modelEntity);

            // Instantiate all entities from the container
            const entities = containerResource.instantiateRenderEntity({
                graphicsDevice: app.graphicsDevice,
            });

            if (entities) {
                // entities can be a single entity or an array
                const entityList = Array.isArray(entities) ? entities : [entities];
                for (const entity of entityList) {
                    modelEntity.addChild(entity);
                }
            }

            console.log('Model loaded from container');
            console.log('Model entity children:', modelEntity.children.length);

            resolve(modelEntity);
        });

        containerAsset.on('error', (error: Error) => {
            reject(error);
        });

        app.assets.add(containerAsset);
        app.assets.load(containerAsset);
    });
}

/* Helper: Create flag visual (pole + flag) */
function createFlag(color: number): Visual {
    const group = new pc.Entity();
    group.name = 'flag';

    // Create pole
    const pole = new pc.Entity();
    pole.name = 'pole';
    pole.addComponent('model', { type: 'box' });
    pole.setLocalScale(0.12, 1.2, 0.12);
    pole.setPosition(0, 0.6, 0);

    const poleMaterial = new pc.StandardMaterial();
    poleMaterial.diffuse = new pc.Color(0.533, 0.533, 0.533);
    poleMaterial.update();
    if (pole.model?.meshInstances?.[0]) {
        pole.model.meshInstances[0].material = poleMaterial;
    }

    group.addChild(pole);

    // Create flag
    const flag = new pc.Entity();
    flag.name = 'flag-part';
    flag.addComponent('model', { type: 'box' });
    flag.setLocalScale(0.32, 0.22, 0.04);
    flag.setPosition(0.23, 1.0, 0);

    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;

    const flagMaterial = new pc.StandardMaterial();
    flagMaterial.diffuse = new pc.Color(r, g, b);
    flagMaterial.update();
    if (flag.model?.meshInstances?.[0]) {
        flag.model.meshInstances[0].material = flagMaterial;
    }

    group.addChild(flag);

    return {
        object: group,
        dispose: () => {
            poleMaterial.destroy();
            flagMaterial.destroy();
        },
    };
}

/* Helper: Create sphere visual */
function createSphere(radius: number, color: number): Visual {
    const entity = new pc.Entity();
    entity.addComponent('model', { type: 'sphere' });

    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;

    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(r, g, b);
    material.update();

    if (entity.model?.meshInstances?.[0]) {
        entity.model.meshInstances[0].material = material;
    }
    entity.setLocalScale(radius * 2, radius * 2, radius * 2);

    return {
        object: entity,
        dispose: () => {
            material.destroy();
        },
    };
}

/* Helper: Create line connecting two points */
function createLine(
    from: [number, number, number],
    to: [number, number, number],
    color: number
): Visual {
    const entity = new pc.Entity();
    entity.addComponent('model', { type: 'box' });

    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];

    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const midpoint = [
        (from[0] + to[0]) / 2,
        (from[1] + to[1]) / 2,
        (from[2] + to[2]) / 2,
    ] as [number, number, number];

    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;

    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(r, g, b);
    material.emissive = new pc.Color(r, g, b);
    material.update();

    if (entity.model?.meshInstances?.[0]) {
        entity.model.meshInstances[0].material = material;
    }
    entity.setPosition(...midpoint);
    entity.setLocalScale(0.05, 0.05, distance || 0.01);

    // Rotate to align with direction
    if (distance > 0.001) {
        const dir = new pc.Vec3(dx, dy, dz);
        dir.normalize();
        const up = Math.abs(dir.y) < 0.99 ? new pc.Vec3(0, 1, 0) : new pc.Vec3(1, 0, 0);
        const right = new pc.Vec3();
        right.cross(up, dir);
        right.normalize();
        const newUp = new pc.Vec3();
        newUp.cross(dir, right);
        newUp.normalize();

        const mat = new pc.Mat4();
        mat.data[0] = right.x;
        mat.data[1] = right.y;
        mat.data[2] = right.z;
        mat.data[4] = newUp.x;
        mat.data[5] = newUp.y;
        mat.data[6] = newUp.z;
        mat.data[8] = dir.x;
        mat.data[9] = dir.y;
        mat.data[10] = dir.z;

        const quat = new pc.Quat();
        quat.setFromMat4(mat);
        entity.setLocalRotation(quat);
    }

    return {
        object: entity,
        dispose: () => {
            material.destroy();
        },
    };
}

/* setup example scene */
const { app, camera, canvas } = await createExampleBase();

camera.setLocalPosition(-2, 10, 10);
camera.setLocalEulerAngles(-45, -10, 0);

/* Camera controls using PlayCanvas built-in input system */
class CameraControls {
    private desktopInput: pc.KeyboardMouseSource;
    private mobileInput: pc.MultiTouchSource;
    private orbitController: pc.OrbitController;
    private pose: pc.Pose;
    private camera: pc.CameraComponent;
    private frame: pc.InputFrame<{ move: number[]; rotate: number[] }>;
    
    orbitSpeed = 18;
    wheelSpeed = 0.06;
    
    constructor(app: pc.Application, cameraEntity: pc.Entity) {
        this.camera = cameraEntity.camera!;
        this.desktopInput = new pc.KeyboardMouseSource();
        this.mobileInput = new pc.MultiTouchSource();
        this.orbitController = new pc.OrbitController();
        this.pose = new pc.Pose();
        
        // Setup input frame
        this.frame = new pc.InputFrame({
            move: [0, 0, 0],
            rotate: [0, 0, 0]
        });
        
        // Configure orbit controller
        this.orbitController.zoomRange = new pc.Vec2(1, 100);
        this.orbitController.pitchRange = new pc.Vec2(-90, 90);
        this.orbitController.rotateDamping = 0.97;
        this.orbitController.moveDamping = 0.97;
        this.orbitController.zoomDamping = 0.97;
        
        // Attach inputs
        this.desktopInput.attach(app.graphicsDevice.canvas);
        this.mobileInput.attach(app.graphicsDevice.canvas);
        
        // Initialize pose
        this.pose.look(cameraEntity.getPosition(), pc.Vec3.ZERO);
        this.orbitController.attach(this.pose, false);
    }
    
    reset(focus: pc.Vec3, position: pc.Vec3) {
        const pose = new pc.Pose();
        pose.look(position, focus);
        this.orbitController.attach(pose);
    }
    
    update(dt: number) {
        const { button, mouse, wheel } = this.desktopInput.read();
        const { touch, pinch, count } = this.mobileInput.read();
        
        const { deltas } = this.frame;
        
        const v = new pc.Vec3();
        const double = +(count[0] > 1);
        const pan = button[2] || +(button[2] === -1) || double;
        
        // Desktop rotate
        const mouseRotate = new pc.Vec3(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - pan) * this.orbitSpeed * dt));
        deltas.rotate.append([v.x, v.y, v.z]);
        
        // Wheel zoom
        const wheelMove = new pc.Vec3(0, 0, -wheel[0]);
        v.set(0, 0, 0);
        v.add(wheelMove.mulScalar(this.wheelSpeed * dt));
        deltas.move.append([v.x, v.y, -v.z]); // flip z for orbit
        
        // Mobile rotate
        v.set(0, 0, 0);
        const orbitRotate = new pc.Vec3(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar((1 - pan) * this.orbitSpeed * dt));
        deltas.rotate.append([v.x, v.y, v.z]);
        
        // Mobile pinch zoom
        const pinchMove = new pc.Vec3(0, 0, pinch[0]);
        v.set(0, 0, 0);
        v.add(pinchMove.mulScalar(double * 0.4 * dt));
        deltas.move.append([v.x, v.y, v.z]);
        
        // Update controller
        this.pose.copy(this.orbitController.update(this.frame, dt));
        this.camera.entity.setPosition(this.pose.position);
        this.camera.entity.setEulerAngles(this.pose.angles);
    }
    
    destroy() {
        this.desktopInput.destroy();
        this.mobileInput.destroy();
        this.orbitController.destroy();
    }
}

const cameraControls = new CameraControls(app, camera);
cameraControls.reset(pc.Vec3.ZERO, new pc.Vec3(0, 10, 20));

/* Test box to verify rendering works */
const testBox = new pc.Entity('test-box');
testBox.addComponent('render');
testBox.render!.meshInstances = [
    new pc.MeshInstance(
        pc.Mesh.fromGeometry(
            app.graphicsDevice,
            new pc.BoxGeometry({ halfExtents: new pc.Vec3(2, 2, 2) }),
        ),
        new pc.StandardMaterial(),
    ),
];
testBox.setPosition(0, 0, 0);
app.root.addChild(testBox);
console.log('Test box added');

const navTestModel = await loadGLTF(app, './models/nav-test.glb');
console.log('Model loaded:', navTestModel);
console.log('Model has render?', navTestModel.render);
console.log('Model children:', navTestModel.children.length);

// Log model bounds
if (navTestModel.render?.meshInstances?.[0]) {
    const aabb = navTestModel.render.meshInstances[0].mesh?.aabb;
    if (aabb) {
        const min = aabb.getMin();
        const max = aabb.getMax();
        const center = aabb.center;
        console.log('Model AABB - min:', min, 'max:', max, 'center:', center);

        // Position model at origin
        navTestModel.setLocalPosition(-center.x, 0, -center.z);
    }
}

console.log('Model world position:', navTestModel.getPosition());

/* generate navmesh */
const walkableMeshInstances: pc.MeshInstance[] = [];

function collectMeshInstances(entity: pc.Entity, depth = 0) {
    const indent = '  '.repeat(depth);
    console.log(`${indent}Entity:`, entity.name, 'has render?', !!entity.render);

    if (entity.render) {
        const count = entity.render.meshInstances?.length || 0;
        console.log(`${indent}  - Found ${count} mesh instances`);
        walkableMeshInstances.push(...entity.render.meshInstances);
    }

    console.log(`${indent}  - Has ${entity.children.length} children`);
    for (let i = 0; i < entity.children.length; i++) {
        const child = entity.children[i];
        if (child instanceof pc.Entity) {
            collectMeshInstances(child, depth + 1);
        }
    }
}

collectMeshInstances(navTestModel);
console.log('Total mesh instances collected:', walkableMeshInstances.length);

if (walkableMeshInstances.length === 0) {
    console.error('No mesh instances found! Cannot generate navmesh.');
    throw new Error('No mesh instances found in model');
}

const [positions, indices] = getPositionsAndIndices(walkableMeshInstances);

const navMeshInput: TiledNavMeshInput = {
    positions,
    indices,
};

const cellSize = 0.15;
const cellHeight = 0.15;

const tileSizeVoxels = 64;
const tileSizeWorld = tileSizeVoxels * cellSize;

const walkableRadiusWorld = 0.1;
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbWorld = 0.5;
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightWorld = 0.25;
const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);
const walkableSlopeAngleDegrees = 45;

const borderSize = 4;
const minRegionArea = 8;
const mergeRegionArea = 20;

const maxSimplificationError = 1.3;
const maxEdgeLength = 12;

const maxVerticesPerPoly = 5;

const detailSampleDistanceVoxels = 6;
const detailSampleDistance =
    detailSampleDistanceVoxels < 0.9 ? 0 : cellSize * detailSampleDistanceVoxels;

const detailSampleMaxErrorVoxels = 1;
const detailSampleMaxError = cellHeight * detailSampleMaxErrorVoxels;

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

const navMeshHelper = createNavMeshHelper(navMesh, app.graphicsDevice);
navMeshHelper.object.setLocalPosition(0, 0.1, 0);
app.root.addChild(navMeshHelper.object);

/* find path */
let start: Vec3 = [-3.94, 0.26, 4.71];
let end: Vec3 = [2.52, 2.39, -2.2];
const halfExtents: Vec3 = [1, 1, 1];

let visuals: Visual[] = [];

function clearVisuals() {
    for (const visual of visuals) {
        app.root.removeChild(visual.object);
        visual.object.destroy();
        visual.dispose();
    }
    visuals = [];
}

function addVisual(visual: Visual) {
    visuals.push(visual);
    app.root.addChild(visual.object);
}

function updatePath() {
    clearVisuals();

    const startFlag = createFlag(0x2196f3);
    startFlag.object.setPosition(...start);
    addVisual(startFlag);

    const endFlag = createFlag(0x00ff00);
    endFlag.object.setPosition(...end);
    addVisual(endFlag);

    console.time('findPath');

    const pathResult = findPath(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER);

    console.timeEnd('findPath');

    console.log('pathResult', pathResult);
    console.log(
        'partial?',
        (pathResult.straightPathFlags & FindStraightPathResultFlags.PARTIAL_PATH) !== 0
    );

    const { path, nodePath } = pathResult;

    if (nodePath) {
        const searchNodesHelper = createSearchNodesHelper(nodePath.nodes, app.graphicsDevice);
        addVisual(searchNodesHelper);

        for (let i = 0; i < nodePath.path.length; i++) {
            const node = nodePath.path[i];
            if (getNodeRefType(node) === NodeType.POLY) {
                const polyHelper = createNavMeshPolyHelper(navMesh, node, app.graphicsDevice);
                polyHelper.object.setLocalPosition(0, 0.15, 0);
                addVisual(polyHelper);
            }
        }
    }

    if (path) {
        for (let i = 0; i < path.length; i++) {
            const point = path[i];
            // point
            const sphere = createSphere(0.2, 0xff0000);
            sphere.object.setPosition(...point.position);
            addVisual(sphere);
            // line
            if (i > 0) {
                const prevPoint = path[i - 1];
                const line = createLine(
                    prevPoint.position as [number, number, number],
                    point.position as [number, number, number],
                    0xffff00
                );
                addVisual(line);
            }
        }
    }
}

/* interaction */
function getPointOnNavMesh(event: PointerEvent): Vec3 | null {
    const cameraComponent = camera.camera;
    if (!cameraComponent) return null;

    // Use PlayCanvas's built-in screen-to-ray conversion
    const ray = cameraComponent.screenToWorld(event.clientX, event.clientY, 1);
    const origin = cameraComponent.entity.getPosition();
    const direction = new pc.Vec3().sub2(ray, origin).normalize();

    // Raycast against all mesh instances
    let closestHit: pc.RaycastResult | null = null;
    let closestDist = Infinity;

    for (const meshInstance of walkableMeshInstances) {
        const results = meshInstance.mesh.raycast(
            origin,
            direction,
            meshInstance.node.getWorldTransform()
        );

        if (results && results.length > 0) {
            for (const result of results) {
                if (result.distance < closestDist) {
                    closestDist = result.distance;
                    closestHit = result;
                }
            }
        }
    }

    if (closestHit) {
        return [closestHit.point.x, closestHit.point.y, closestHit.point.z];
    }

    return null;
}

let moving: 'start' | 'end' | null = null;

canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    const point = getPointOnNavMesh(event);
    console.log("point", point)

    if (!point) return;

    if (event.button === 0) {
        if (moving === 'start') {
            moving = null;
            canvas.style.cursor = '';
            start = point;
        } else {
            moving = 'start';
            canvas.style.cursor = 'crosshair';
            start = point;
        }
    } else if (event.button === 2) {
        if (moving === 'end') {
            moving = null;
            canvas.style.cursor = '';
            end = point;
        } else {
            moving = 'end';
            canvas.style.cursor = 'crosshair';
            end = point;
        }
    }
    updatePath();
});

canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (!moving) return;

    const point = getPointOnNavMesh(event);
    if (!point) return;

    if (moving === 'start') {
        start = point;
    } else if (moving === 'end') {
        end = point;
    }

    updatePath();
});

canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());

/* initial update */
updatePath();

/* start loop */
app.on('update', (dt: number) => {
    // Update camera controls
    cameraControls.update(dt);
});
