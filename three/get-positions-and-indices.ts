import { mergePositionsAndIndices } from 'navcat/blocks';
import { type BufferAttribute, type Mesh, Vector3 } from 'three';

const _position = new Vector3();

export const getPositionsAndIndices = (meshes: Mesh[]): [positions: number[], indices: number[]] => {
    const toMerge: {
        positions: ArrayLike<number>;
        indices: ArrayLike<number>;
    }[] = [];

    for (const mesh of meshes) {
        const positionAttribute = mesh.geometry.attributes.position as BufferAttribute;

        if (!positionAttribute || positionAttribute.itemSize !== 3) {
            continue;
        }

        mesh.updateMatrixWorld();

        const positions = new Float32Array(positionAttribute.count * 3);

        for (let i = 0; i < positionAttribute.count; i++) {
            const pos = _position.fromBufferAttribute(positionAttribute, i);
            mesh.localToWorld(pos);
            const indx = i * 3;
            positions[indx] = pos.x;
            positions[indx + 1] = pos.y;
            positions[indx + 2] = pos.z;
        }

        let indices: ArrayLike<number> | undefined = mesh.geometry.getIndex()?.array;

        if (indices === undefined) {
            // this will become indexed when merging with other meshes
            const ascendingIndex: number[] = [];
            for (let i = 0; i < positionAttribute.count; i++) {
                ascendingIndex.push(i);
            }
            indices = ascendingIndex;
        }

        toMerge.push({
            positions,
            indices,
        });
    }

    return mergePositionsAndIndices(toMerge);
};
