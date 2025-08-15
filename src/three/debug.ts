import * as THREE from 'three';
import type {
  DebugPrimitive,
  DebugTriangles,
  DebugLines,
  DebugPoints,
  DebugBoxes,
} from '../debug';
import { DebugPrimitiveType } from '../debug';
import * as Debug from '../debug';
import type {
  ArrayLike,
  CompactHeightfield,
  ContourSet,
  Heightfield,
  PolyMesh,
  PolyMeshDetail,
} from '../generate';
import type { NavMesh, NavMeshTile, NodeRef } from '../query/nav-mesh';
import type { SearchNodePool } from '../query/search';

export type DebugObject = {
  object: THREE.Object3D;
  dispose: () => void;
};

/**
 * Converts graphics-agnostic debug primitives to Three.js objects
 */
function primitiveToThreeJS(primitive: DebugPrimitive): { object: THREE.Object3D; dispose: () => void } {
  const disposables: (() => void)[] = [];

  switch (primitive.type) {
    case DebugPrimitiveType.Triangles: {
      const triPrimitive = primitive as DebugTriangles;
      const geometry = new THREE.BufferGeometry();
      
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(triPrimitive.positions), 3)
      );
      geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(triPrimitive.colors), 3)
      );
      
      if (triPrimitive.indices && triPrimitive.indices.length > 0) {
        geometry.setIndex(
          new THREE.BufferAttribute(new Uint32Array(triPrimitive.indices), 1)
        );
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
        }
      };
    }

    case DebugPrimitiveType.Lines: {
      const linePrimitive = primitive as DebugLines;
      const geometry = new THREE.BufferGeometry();
      
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(linePrimitive.positions), 3)
      );
      geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(linePrimitive.colors), 3)
      );

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
        }
      };
    }

    case DebugPrimitiveType.Points: {
      const pointPrimitive = primitive as DebugPoints;
      const geometry = new THREE.BufferGeometry();
      
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(pointPrimitive.positions), 3)
      );
      geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(pointPrimitive.colors), 3)
      );

      const material = new THREE.PointsMaterial({
        vertexColors: true,
        transparent: pointPrimitive.transparent || false,
        opacity: pointPrimitive.opacity || 1.0,
        size: pointPrimitive.size || 1.0,
        sizeAttenuation: pointPrimitive.sizeAttenuation !== false,
      });

      const points = new THREE.Points(geometry, material);
      
      disposables.push(() => {
        geometry.dispose();
        material.dispose();
      });
      
      return { 
        object: points, 
        dispose: () => {
          for (const dispose of disposables) {
            dispose();
          }
        }
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
            boxPrimitive.colors[i * 3 + 2]
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
        }
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

// Debug helper functions - these wrap the agnostic helpers and convert to Three.js

export function createTriangleAreaIdsHelper(
  input: { positions: Float32Array; indices: Uint32Array },
  triAreaIds: ArrayLike<number>,
): DebugObject {
  const primitives = Debug.createTriangleAreaIdsHelper(input, triAreaIds);
  return primitivesToThreeJS(primitives);
}

export function createHeightfieldHelper(heightfield: Heightfield): DebugObject {
  const primitives = Debug.createHeightfieldHelper(heightfield);
  return primitivesToThreeJS(primitives);
}

export function createCompactHeightfieldSolidHelper(
  compactHeightfield: CompactHeightfield,
): DebugObject {
  const primitives = Debug.createCompactHeightfieldSolidHelper(compactHeightfield);
  return primitivesToThreeJS(primitives);
}

export function createCompactHeightfieldDistancesHelper(
  compactHeightfield: CompactHeightfield,
): DebugObject {
  const primitives = Debug.createCompactHeightfieldDistancesHelper(compactHeightfield);
  return primitivesToThreeJS(primitives);
}

export function createCompactHeightfieldRegionsHelper(
  compactHeightfield: CompactHeightfield,
): DebugObject {
  const primitives = Debug.createCompactHeightfieldRegionsHelper(compactHeightfield);
  return primitivesToThreeJS(primitives);
}

export function createRawContoursHelper(contourSet: ContourSet): DebugObject {
  const primitives = Debug.createRawContoursHelper(contourSet);
  return primitivesToThreeJS(primitives);
}

export function createSimplifiedContoursHelper(contourSet: ContourSet): DebugObject {
  const primitives = Debug.createSimplifiedContoursHelper(contourSet);
  return primitivesToThreeJS(primitives);
}

export function createPolyMeshHelper(polyMesh: PolyMesh): DebugObject {
  const primitives = Debug.createPolyMeshHelper(polyMesh);
  return primitivesToThreeJS(primitives);
}

export function createPolyMeshDetailHelper(polyMeshDetail: PolyMeshDetail): DebugObject {
  const primitives = Debug.createPolyMeshDetailHelper(polyMeshDetail);
  return primitivesToThreeJS(primitives);
}

export function createNavMeshHelper(navMesh: NavMesh): DebugObject {
  const primitives = Debug.createNavMeshHelper(navMesh);
  return primitivesToThreeJS(primitives);
}

export function createNavMeshPolyHelper(
  navMesh: NavMesh,
  polyRef: NodeRef,
  color: [number, number, number] = [0, 0.75, 1],
): DebugObject {
  const primitives = Debug.createNavMeshPolyHelper(navMesh, polyRef, color);
  return primitivesToThreeJS(primitives);
}

export function createNavMeshTileBvTreeHelper(navMeshTile: NavMeshTile): DebugObject {
  const primitives = Debug.createNavMeshTileBvTreeHelper(navMeshTile);
  return primitivesToThreeJS(primitives);
}

export function createNavMeshBvTreeHelper(navMesh: NavMesh): DebugObject {
  const primitives = Debug.createNavMeshBvTreeHelper(navMesh);
  return primitivesToThreeJS(primitives);
}

export function createNavMeshTilePortalsHelper(navMeshTile: NavMeshTile): DebugObject {
  const primitives = Debug.createNavMeshTilePortalsHelper(navMeshTile);
  return primitivesToThreeJS(primitives);
}

export function createNavMeshPortalsHelper(navMesh: NavMesh): DebugObject {
  const primitives = Debug.createNavMeshPortalsHelper(navMesh);
  return primitivesToThreeJS(primitives);
}

export function createSearchNodesHelper(nodePool: SearchNodePool): DebugObject {
  const primitives = Debug.createSearchNodesHelper(nodePool);
  return primitivesToThreeJS(primitives);
}

export function createNavMeshOffMeshConnectionsHelper(navMesh: NavMesh): DebugObject {
  const primitives = Debug.createNavMeshOffMeshConnectionsHelper(navMesh);
  return primitivesToThreeJS(primitives);
}
