import * as THREE from 'three';
import { createExample } from './common/example-boilerplate';

const container = document.getElementById('root')!;
const { scene, camera, renderer } = await createExample(container);

const geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
const material = new THREE.MeshPhongMaterial({ color: 0xff6600 });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

function animate() {
    requestAnimationFrame(animate);
    
    cube.rotation.x += 0.02;
    cube.rotation.z += 0.01;
    
    renderer.render(scene, camera);
}
animate();