import GUI from 'lil-gui';
import { chunkyTriMesh } from 'navcat/blocks';
import { getPositionsAndIndices } from 'navcat/three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import { loadGLTF } from './common/load-gltf';

/* setup example scene */
const container = document.getElementById('root')!;

// scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

// camera
const camera = new THREE.OrthographicCamera(
    container.clientWidth / -200,
    container.clientWidth / 200,
    container.clientHeight / 200,
    container.clientHeight / -200,
    0.1,
    1000,
);

// renderer
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

container.appendChild(renderer.domElement);

// lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(5, 5, 5);
scene.add(directionalLight);

// resize handling
function onWindowResize() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.left = container.clientWidth / -200;
    camera.right = container.clientWidth / 200;
    camera.top = container.clientHeight / 200;
    camera.bottom = container.clientHeight / -200;
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', onWindowResize);

await renderer.init();

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

// birds eye
camera.position.set(0, 100, -50);
camera.zoom = 0.1;
orbitControls.target.set(0, 0, -50);

const levelModel = await loadGLTF('./models/dungeon.gltf');
scene.add(levelModel.scene);

levelModel.scene.visible = false;


/* get mesh geometry */
const walkableMeshes: THREE.Mesh[] = [];
scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
        walkableMeshes.push(object);
    }
});

const [positions, indices] = getPositionsAndIndices(walkableMeshes);

/* create chunky tri mesh */
console.time('create chunky tri mesh');
const levelChunkyTriMesh = chunkyTriMesh.create(positions, indices, 256);
console.timeEnd('create chunky tri mesh');

console.log('Chunky Tri Mesh Stats:');
console.log(`  Total triangles: ${indices.length / 3}`);
console.log(`  Total nodes: ${levelChunkyTriMesh.nodes.length}`);
console.log(`  Max tris per chunk: ${levelChunkyTriMesh.maxTrisPerChunk}`);

/* visualization state */
const config = {
    showTriangles: true,
    showChunkBounds: true,
    showQueryRegion: true,
    queryRegionX: 0,
    queryRegionZ: 0,
    queryRegionSize: 5,
    triangleInQueryColor: '#00ff00',
    triangleOutQueryColor: '#666666',
    chunkBoundsColor: '#0088ff',
    queryRegionColor: '#ffff00',
    wireframe: true,
};

/* helper to create edge lines for chunk bounds */
function createChunkEdges(minX: number, minZ: number, maxX: number, maxZ: number, color: string) {
    const points = [
        new THREE.Vector3(minX, 0.05, minZ),
        new THREE.Vector3(maxX, 0.05, minZ),
        new THREE.Vector3(maxX, 0.05, maxZ),
        new THREE.Vector3(minX, 0.05, maxZ),
        new THREE.Vector3(minX, 0.05, minZ),
    ];

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color, linewidth: 1 });
    const line = new THREE.Line(geometry, material);

    return line;
}

/* groups for visualization objects */
const trianglesGroup = new THREE.Group();
scene.add(trianglesGroup);

const chunkBoundsGroup = new THREE.Group();
scene.add(chunkBoundsGroup);

const queryRegionGroup = new THREE.Group();
scene.add(queryRegionGroup);

/* create geometry for all triangles */
function createTriangleGeometry(triangleIndices: number[], positionsArray: ArrayLike<number>) {
    const vertexCount = triangleIndices.length;
    const positionAttr = new Float32Array(vertexCount * 3);

    for (let i = 0; i < triangleIndices.length; i++) {
        const vertexIndex = triangleIndices[i];
        positionAttr[i * 3 + 0] = positionsArray[vertexIndex * 3 + 0];
        positionAttr[i * 3 + 1] = positionsArray[vertexIndex * 3 + 1];
        positionAttr[i * 3 + 2] = positionsArray[vertexIndex * 3 + 2];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positionAttr, 3));
    geometry.computeVertexNormals();

    return geometry;
}

/* visualize triangles colored by query overlap */
function visualizeTriangles() {
    trianglesGroup.clear();

    if (!config.showTriangles) return;

    const halfSize = config.queryRegionSize / 2;
    const queryMin: [number, number] = [config.queryRegionX - halfSize, config.queryRegionZ - halfSize];
    const queryMax: [number, number] = [config.queryRegionX + halfSize, config.queryRegionZ + halfSize];

    // Get triangles in query region
    const trianglesInQuery = chunkyTriMesh.getTrianglesInRect(levelChunkyTriMesh, queryMin, queryMax);

    // Group triangles by whether they're in the query
    const inQueryIndices: number[] = [];
    const outQueryIndices: number[] = [];

    for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i];
        const i1 = indices[i + 1];
        const i2 = indices[i + 2];

        // Check if this triangle is in the query result
        // We need to check if all three vertices match
        let isInQuery = false;
        for (let j = 0; j < trianglesInQuery.length; j += 3) {
            if (
                trianglesInQuery[j] === i0 &&
                trianglesInQuery[j + 1] === i1 &&
                trianglesInQuery[j + 2] === i2
            ) {
                isInQuery = true;
                break;
            }
        }

        if (isInQuery) {
            inQueryIndices.push(i0, i1, i2);
        } else {
            outQueryIndices.push(i0, i1, i2);
        }
    }

    console.log(`Triangles in query: ${inQueryIndices.length / 3}/${indices.length / 3}`);

    // Create mesh for triangles in query (green)
    if (inQueryIndices.length > 0) {
        const geometry = createTriangleGeometry(inQueryIndices, positions);
        const material = new THREE.MeshBasicMaterial({
            color: config.triangleInQueryColor,
            wireframe: config.wireframe,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        trianglesGroup.add(mesh);
    }

    // Create mesh for triangles outside query (gray)
    if (outQueryIndices.length > 0) {
        const geometry = createTriangleGeometry(outQueryIndices, positions);
        const material = new THREE.MeshBasicMaterial({
            color: config.triangleOutQueryColor,
            wireframe: config.wireframe,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        trianglesGroup.add(mesh);
    }
}

/* visualize chunk bounds */
function visualizeChunkBounds() {
    chunkBoundsGroup.clear();

    if (!config.showChunkBounds) return;

    const halfSize = config.queryRegionSize / 2;
    const queryMin: [number, number] = [config.queryRegionX - halfSize, config.queryRegionZ - halfSize];
    const queryMax: [number, number] = [config.queryRegionX + halfSize, config.queryRegionZ + halfSize];

    // Get overlapping chunks
    const chunkIndices = chunkyTriMesh.getChunksOverlappingRect(levelChunkyTriMesh, queryMin, queryMax);
    const overlappingChunks = new Set(chunkIndices);

    // Only show leaf nodes (actual chunks with triangles)
    const leafNodes = levelChunkyTriMesh.nodes.filter((node) => node.index >= 0);

    for (let i = 0; i < leafNodes.length; i++) {
        const node = leafNodes[i];
        const isHighlighted = overlappingChunks.has(i);

        const color = isHighlighted ? config.triangleInQueryColor : config.chunkBoundsColor;

        const edges = createChunkEdges(node.bounds[0][0], node.bounds[0][1], node.bounds[1][0], node.bounds[1][1], color);
        chunkBoundsGroup.add(edges);
    }
}

/* visualize query region */
function visualizeQueryRegion() {
    queryRegionGroup.clear();

    if (!config.showQueryRegion) return;

    const halfSize = config.queryRegionSize / 2;
    const queryMin: [number, number] = [config.queryRegionX - halfSize, config.queryRegionZ - halfSize];
    const queryMax: [number, number] = [config.queryRegionX + halfSize, config.queryRegionZ + halfSize];

    // Draw query region edges
    const edges = createChunkEdges(queryMin[0], queryMin[1], queryMax[0], queryMax[1], config.queryRegionColor);
    queryRegionGroup.add(edges);

    // Also draw filled transparent box for query region
    const width = queryMax[0] - queryMin[0];
    const depth = queryMax[1] - queryMin[1];
    const geometry = new THREE.PlaneGeometry(width, depth);
    const material = new THREE.MeshBasicMaterial({
        color: config.queryRegionColor,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(geometry, material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(config.queryRegionX, 0.05, config.queryRegionZ);
    queryRegionGroup.add(plane);
}

/* update visualization */
function updateVisualization() {
    visualizeTriangles();
    visualizeChunkBounds();
    visualizeQueryRegion();
}

/* GUI */
const gui = new GUI();

const trianglesFolder = gui.addFolder('Triangles');
trianglesFolder.add(config, 'showTriangles').name('Show Triangles').onChange(updateVisualization);
trianglesFolder.add(config, 'wireframe').name('Wireframe').onChange(updateVisualization);
trianglesFolder.addColor(config, 'triangleInQueryColor').name('In Query Color').onChange(updateVisualization);
trianglesFolder.addColor(config, 'triangleOutQueryColor').name('Outside Query Color').onChange(updateVisualization);
trianglesFolder.open();

const chunksFolder = gui.addFolder('Chunk Bounds');
chunksFolder.add(config, 'showChunkBounds').name('Show Bounds').onChange(updateVisualization);
chunksFolder.addColor(config, 'chunkBoundsColor').name('Bounds Color').onChange(updateVisualization);
chunksFolder.open();

const queryFolder = gui.addFolder('Query Region');
queryFolder.add(config, 'showQueryRegion').name('Show Query').onChange(updateVisualization);
queryFolder.add(config, 'queryRegionX', -10, 10, 0.1).name('Query X').onChange(updateVisualization);
queryFolder.add(config, 'queryRegionZ', -10, 10, 0.1).name('Query Z').onChange(updateVisualization);
queryFolder.add(config, 'queryRegionSize', 0.5, 15, 0.1).name('Query Size').onChange(updateVisualization);
queryFolder.addColor(config, 'queryRegionColor').name('Region Color').onChange(updateVisualization);
queryFolder.open();

/* interaction - click to move query region */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let isDragging = false;

function getPointOnGround(event: PointerEvent): THREE.Vector3 | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    // Intersect with a ground plane at y=0
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const intersectPoint = new THREE.Vector3();

    if (raycaster.ray.intersectPlane(groundPlane, intersectPoint)) {
        return intersectPoint;
    }

    return null;
}

renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return; // Only left click
    isDragging = true;
    orbitControls.enabled = false;

    const point = getPointOnGround(event);
    if (point) {
        config.queryRegionX = point.x;
        config.queryRegionZ = point.z;
        updateVisualization();

        // Update GUI
        gui.controllersRecursive().forEach((controller) => {
            controller.updateDisplay();
        });
    }
});

renderer.domElement.addEventListener('pointermove', (event: PointerEvent) => {
    if (!isDragging) return;

    const point = getPointOnGround(event);
    if (point) {
        config.queryRegionX = point.x;
        config.queryRegionZ = point.z;
        updateVisualization();

        // Update GUI
        gui.controllersRecursive().forEach((controller) => {
            controller.updateDisplay();
        });
    }
});

renderer.domElement.addEventListener('pointerup', () => {
    isDragging = false;
    orbitControls.enabled = true;
});

/* initial visualization */
updateVisualization();

/* render loop */
function update() {
    requestAnimationFrame(update);
    orbitControls.update();
    renderer.render(scene, camera);
}

update();
