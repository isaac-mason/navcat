import { DRACOLoader, GLTFLoader } from 'three/examples/jsm/Addons.js';

import dracoWasmUrl from 'three/examples/jsm/libs/draco/draco_decoder.wasm?url';

/**
 * Loads a GLTF model.
 * @param {string} url
 * @returns {Promise<import('three/examples/jsm/Addons.js').GLTF>}
 */
export const loadGLTF = (url) => {
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
