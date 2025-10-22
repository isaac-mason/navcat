import type {
    ArrayLike,
    CompactHeightfield,
    ContourSet,
    DebugBoxes,
    DebugLines,
    DebugPoints,
    DebugPrimitive,
    DebugTriangles,
    Heightfield,
    NavMesh,
    NavMeshTile,
    NodeRef,
    PolyMesh,
    PolyMeshDetail,
    SearchNodePool
} from 'navcat';
import * as NavCat from 'navcat';
import { DebugPrimitiveType } from 'navcat';
import * as THREE from 'three';

export type DebugObject = {
    object: THREE.Object3D;
    dispose: () => void;
};

const primitiveToThreeJS = (primitive: DebugPrimitive): { object: THREE.Object3D; dispose: () => void } => {
    const disposables: (() => void)[] = [];

    switch (primitive.type) {
        case DebugPrimitiveType.Triangles: {
            const triPrimitive = primitive as DebugTriangles;
            const geometry = new THREE.BufferGeometry();

            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(triPrimitive.positions), 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(triPrimitive.colors), 3));

            if (triPrimitive.indices && triPrimitive.indices.length > 0) {
                geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triPrimitive.indices), 1));
            }

            const material = new THREE.MeshBasicMaterial({
                vertexColors: true,
                transparent: triPrimitive.transparent || false,
                opacity: triPrimitive.opacity || 1.0,
                side: triPrimitive.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
            });

            const mesh = new THREE.Mesh(geometry, material);

            disposables.push(() => {
                geometry.dispose();
                material.dispose();
            });

            return {
                object: mesh,
                dispose: () => {
                    for (const dispose of disposables) {
                        dispose();
                    }
                },
            };
        }

        case DebugPrimitiveType.Lines: {
            const linePrimitive = primitive as DebugLines;
            const geometry = new THREE.BufferGeometry();

            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePrimitive.positions), 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(linePrimitive.colors), 3));

            const material = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: linePrimitive.transparent || false,
                opacity: linePrimitive.opacity || 1.0,
                linewidth: linePrimitive.lineWidth || 1.0,
            });

            const lines = new THREE.LineSegments(geometry, material);

            disposables.push(() => {
                geometry.dispose();
                material.dispose();
            });

            return {
                object: lines,
                dispose: () => {
                    for (const dispose of disposables) {
                        dispose();
                    }
                },
            };
        }

        case DebugPrimitiveType.Points: {
            const pointPrimitive = primitive as DebugPoints;
            const group = new THREE.Group();

            const numPoints = pointPrimitive.positions.length / 3;

            if (numPoints > 0) {
                // Create sphere geometry for instancing
                const sphereGeometry = new THREE.SphereGeometry(1, 8, 6); // Low-poly sphere for performance

                const material = new THREE.MeshBasicMaterial({
                    vertexColors: true,
                    transparent: pointPrimitive.transparent || false,
                    opacity: pointPrimitive.opacity || 1.0,
                });

                const instancedMesh = new THREE.InstancedMesh(sphereGeometry, material, numPoints);

                const matrix = new THREE.Matrix4();
                const baseSize = pointPrimitive.size || 1.0;

                for (let i = 0; i < numPoints; i++) {
                    const x = pointPrimitive.positions[i * 3];
                    const y = pointPrimitive.positions[i * 3 + 1];
                    const z = pointPrimitive.positions[i * 3 + 2];

                    const sphereSize = baseSize;

                    matrix.makeScale(sphereSize, sphereSize, sphereSize);
                    matrix.setPosition(x, y, z);
                    instancedMesh.setMatrixAt(i, matrix);

                    const color = new THREE.Color(
                        pointPrimitive.colors[i * 3],
                        pointPrimitive.colors[i * 3 + 1],
                        pointPrimitive.colors[i * 3 + 2],
                    );
                    instancedMesh.setColorAt(i, color);
                }

                instancedMesh.instanceMatrix.needsUpdate = true;
                if (instancedMesh.instanceColor) {
                    instancedMesh.instanceColor.needsUpdate = true;
                }

                group.add(instancedMesh);

                disposables.push(() => {
                    sphereGeometry.dispose();
                    material.dispose();
                    instancedMesh.dispose();
                });
            }

            return {
                object: group,
                dispose: () => {
                    for (const dispose of disposables) {
                        dispose();
                    }
                },
            };
        }

        case DebugPrimitiveType.Boxes: {
            const boxPrimitive = primitive as DebugBoxes;
            const group = new THREE.Group();

            // Create instanced mesh for all boxes
            const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
            const numBoxes = boxPrimitive.positions.length / 3;

            if (numBoxes > 0) {
                const material = new THREE.MeshBasicMaterial({
                    vertexColors: true,
                    transparent: boxPrimitive.transparent || false,
                    opacity: boxPrimitive.opacity || 1.0,
                });

                const instancedMesh = new THREE.InstancedMesh(boxGeometry, material, numBoxes);

                const matrix = new THREE.Matrix4();

                for (let i = 0; i < numBoxes; i++) {
                    const x = boxPrimitive.positions[i * 3];
                    const y = boxPrimitive.positions[i * 3 + 1];
                    const z = boxPrimitive.positions[i * 3 + 2];

                    const scaleX = boxPrimitive.scales ? boxPrimitive.scales[i * 3] : 1;
                    const scaleY = boxPrimitive.scales ? boxPrimitive.scales[i * 3 + 1] : 1;
                    const scaleZ = boxPrimitive.scales ? boxPrimitive.scales[i * 3 + 2] : 1;

                    matrix.makeScale(scaleX, scaleY, scaleZ);
                    matrix.setPosition(x, y, z);
                    instancedMesh.setMatrixAt(i, matrix);

                    const color = new THREE.Color(
                        boxPrimitive.colors[i * 3],
                        boxPrimitive.colors[i * 3 + 1],
                        boxPrimitive.colors[i * 3 + 2],
                    );
                    instancedMesh.setColorAt(i, color);
                }

                instancedMesh.instanceMatrix.needsUpdate = true;
                if (instancedMesh.instanceColor) {
                    instancedMesh.instanceColor.needsUpdate = true;
                }

                group.add(instancedMesh);

                disposables.push(() => {
                    boxGeometry.dispose();
                    material.dispose();
                    instancedMesh.dispose();
                });
            }

            return {
                object: group,
                dispose: () => {
                    for (const dispose of disposables) {
                        dispose();
                    }
                },
            };
        }

        default: {
            const exhaustiveCheck: never = primitive;
            console.warn('Unknown debug primitive type:', (exhaustiveCheck as any).type);
            return { object: new THREE.Group(), dispose: () => {} };
        }
    }
}

/**
 * Converts an array of debug primitives to a Three.js group
 */
function primitivesToThreeJS(primitives: DebugPrimitive[]): DebugObject {
    const group = new THREE.Group();
    const disposables: (() => void)[] = [];

    for (const primitive of primitives) {
        const { object, dispose } = primitiveToThreeJS(primitive);
        group.add(object);
        disposables.push(dispose);
    }

    return {
        object: group,
        dispose: () => {
            for (const dispose of disposables) {
                dispose();
            }
        },
    };
}

export const createTriangleAreaIdsHelper = (
    input: { positions: ArrayLike<number>; indices: ArrayLike<number> },
    triAreaIds: ArrayLike<number>,
): DebugObject => {
    const primitives = NavCat.createTriangleAreaIdsHelper(input, triAreaIds);
    return primitivesToThreeJS(primitives);
}

export const createHeightfieldHelper = (heightfield: Heightfield): DebugObject => {
    const primitives = NavCat.createHeightfieldHelper(heightfield);
    return primitivesToThreeJS(primitives);
}

export const createCompactHeightfieldSolidHelper = (compactHeightfield: CompactHeightfield): DebugObject => {
    const primitives = NavCat.createCompactHeightfieldSolidHelper(compactHeightfield);
    return primitivesToThreeJS(primitives);
}

export const createCompactHeightfieldDistancesHelper = (compactHeightfield: CompactHeightfield): DebugObject => {
    const primitives = NavCat.createCompactHeightfieldDistancesHelper(compactHeightfield);
    return primitivesToThreeJS(primitives);
}

export const createCompactHeightfieldRegionsHelper = (compactHeightfield: CompactHeightfield): DebugObject => {
    const primitives = NavCat.createCompactHeightfieldRegionsHelper(compactHeightfield);
    return primitivesToThreeJS(primitives);
}

export const createRawContoursHelper = (contourSet: ContourSet): DebugObject => {
    const primitives = NavCat.createRawContoursHelper(contourSet);
    return primitivesToThreeJS(primitives);
}

export const createSimplifiedContoursHelper = (contourSet: ContourSet): DebugObject => {
    const primitives = NavCat.createSimplifiedContoursHelper(contourSet);
    return primitivesToThreeJS(primitives);
}

export const createPolyMeshHelper = (polyMesh: PolyMesh): DebugObject => {
    const primitives = NavCat.createPolyMeshHelper(polyMesh);
    return primitivesToThreeJS(primitives);
}

export const createPolyMeshDetailHelper = (polyMeshDetail: PolyMeshDetail): DebugObject => {
    const primitives = NavCat.createPolyMeshDetailHelper(polyMeshDetail);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshHelper = (navMesh: NavMesh): DebugObject => {
    const primitives = NavCat.createNavMeshHelper(navMesh);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshTileHelper = (tile: NavMeshTile): DebugObject => {
    const primitives = NavCat.createNavMeshTileHelper(tile);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshPolyHelper = (
    navMesh: NavMesh,
    polyRef: NodeRef,
    color: [number, number, number] = [0, 0.75, 1],
): DebugObject => {
    const primitives = NavCat.createNavMeshPolyHelper(navMesh, polyRef, color);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshTileBvTreeHelper = (navMeshTile: NavMeshTile): DebugObject => {
    const primitives = NavCat.createNavMeshTileBvTreeHelper(navMeshTile);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshLinksHelper = (navMesh: NavMesh): DebugObject => {
    const primitives = NavCat.createNavMeshLinksHelper(navMesh);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshBvTreeHelper = (navMesh: NavMesh): DebugObject => {
    const primitives = NavCat.createNavMeshBvTreeHelper(navMesh);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshTilePortalsHelper = (navMeshTile: NavMeshTile): DebugObject => {
    const primitives = NavCat.createNavMeshTilePortalsHelper(navMeshTile);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshPortalsHelper = (navMesh: NavMesh): DebugObject => {
    const primitives = NavCat.createNavMeshPortalsHelper(navMesh);
    return primitivesToThreeJS(primitives);
}

export const createSearchNodesHelper = (nodePool: SearchNodePool): DebugObject => {
    const primitives = NavCat.createSearchNodesHelper(nodePool);
    return primitivesToThreeJS(primitives);
}

export const createNavMeshOffMeshConnectionsHelper = (navMesh: NavMesh): DebugObject => {
    const primitives = NavCat.createNavMeshOffMeshConnectionsHelper(navMesh);
    return primitivesToThreeJS(primitives);
}
