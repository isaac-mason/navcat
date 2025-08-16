import { DRACOLoader, type GLTF, GLTFLoader } from 'three/examples/jsm/Addons.js';
import dracoWasmUrl from 'three/examples/jsm/libs/draco/draco_decoder.wasm?url';

export const loadGLTF = (url: string): Promise<GLTF> => {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(dracoWasmUrl);

    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);

    return new Promise((resolve, reject) => {
        gltfLoader.load(
            url,
            (gltf) => {
                resolve(gltf);
            },
            undefined,
            (error) => {
                reject(error);
            }
        );
    });
};
