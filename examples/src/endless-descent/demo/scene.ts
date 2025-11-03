import { GUI } from 'lil-gui';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import * as THREE from 'three/webgpu';
import { createExample } from '../../common/example-base';

export type SceneBundle = {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGPURenderer;
    controls: OrbitControls;
    gui: GUI;
};

export async function setupScene(container: HTMLElement): Promise<SceneBundle> {
    const { scene, camera, renderer } = await createExample(container);
    camera.position.set(-15, 20, 25);
    camera.lookAt(0, 10, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 10, 0);

    const gui = new GUI();
    gui.title('Endless Descent Controls');

    return { scene, camera, renderer, controls, gui };
}
