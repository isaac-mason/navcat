import { type GLTF, GLTFLoader } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const loadGLTF = (url: string): Promise<GLTF> => {
    const gltfLoader = new GLTFLoader();
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);

    return gltfLoader.loadAsync(url);
};
