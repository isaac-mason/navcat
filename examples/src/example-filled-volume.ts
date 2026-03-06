import { type Box3, type Vec3, vec2 } from 'mathcat';
import { BuildContext, calculateGridSize, createHeightfield, rasterizeBox, rasterizeCylinder, rasterizeSphere, WALKABLE_AREA } from 'navcat';
import { createHeightfieldHelper } from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createExample } from './common/example-base';

const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(4, 6, 8);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.target.set(0, 1, 0);

const cellSize = 0.1;
const cellHeight = 0.1;
const bounds: Box3 = [-100, -100, -100, 100, 100, 100];

const [width, height] = calculateGridSize(vec2.create(), bounds, cellSize);
const heightfield = createHeightfield(width, height, bounds, cellSize, cellHeight);

const ctx = BuildContext.create();

const box_center: Vec3 = [0, 0, 0];
const halfEdges: Vec3[] = [
	[1, 0, 0],
	[0, 2, 0],
	[0, 0, 3],
];
rasterizeBox(heightfield, box_center, halfEdges, WALKABLE_AREA, 1, ctx);

const cylinder_start: Vec3 = [5, 0, 0];
const cylinder_finish: Vec3 = [5, 5, 0];
const cylinder_radius = 1;
rasterizeCylinder(heightfield, cylinder_start, cylinder_finish, cylinder_radius, WALKABLE_AREA, 1, ctx);

const sphere_center: Vec3 = [10, 0, 0];
const sphere_radius = 1;
rasterizeSphere(heightfield, sphere_center, sphere_radius, WALKABLE_AREA, 1, ctx);

const heightfieldHelper = createHeightfieldHelper(heightfield);
scene.add(heightfieldHelper.object);

function update() {
	requestAnimationFrame(update)
	renderer.render(scene, camera);
}

update();
