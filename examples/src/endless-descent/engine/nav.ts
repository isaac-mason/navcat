import {
    addOffMeshConnection,
    generateSoloNavMesh,
    type SoloNavMeshInput,
    type SoloNavMeshOptions,
} from 'navcat/blocks';
import {
    DEFAULT_QUERY_FILTER,
    createFindNearestPolyResult,
    findNearestPoly,
    type NavMesh,
    type NodeRef,
    OffMeshConnectionDirection,
} from 'navcat';
import * as THREE from 'three';

export type EndlessNavEnvironment = {
    navMesh: NavMesh;
    roofRef: NodeRef;
    roofCenter: THREE.Vector3;
    goalRegion: THREE.Box3;
    queryFilter: typeof DEFAULT_QUERY_FILTER;
};

function createQuad(center: THREE.Vector3, halfSize: THREE.Vector2, y: number): { positions: number[]; indices: number[] } {
    const positions = [
        center.x - halfSize.x,
        y,
        center.z - halfSize.y,
        center.x + halfSize.x,
        y,
        center.z - halfSize.y,
        center.x + halfSize.x,
        y,
        center.z + halfSize.y,
        center.x - halfSize.x,
        y,
        center.z + halfSize.y,
    ];
    const indices = [0, 1, 2, 0, 2, 3];
    return { positions, indices };
}

export function buildEndlessNavEnvironment(scene: THREE.Scene): EndlessNavEnvironment {
    const roofHeight = 18;
    const roofHalf = new THREE.Vector2(8, 8);
    const groundHalf = new THREE.Vector2(60, 60);

    const roofQuad = createQuad(new THREE.Vector3(0, roofHeight, 0), roofHalf, roofHeight);
    const groundQuad = createQuad(new THREE.Vector3(0, 0, 0), groundHalf, 0);

    const positions = new Float32Array([...roofQuad.positions, ...groundQuad.positions]);
    const indices = new Uint32Array([...roofQuad.indices, ...groundQuad.indices.map((i) => i + 4)]);

    const input: SoloNavMeshInput = {
        positions,
        indices,
    };

    const options: SoloNavMeshOptions = {
        cellSize: 0.5,
        cellHeight: 0.3,
        walkableRadiusWorld: 0.3,
        walkableRadiusVoxels: 1,
        walkableClimbWorld: 0.5,
        walkableClimbVoxels: 2,
        walkableHeightWorld: 1.8,
        walkableHeightVoxels: 6,
        walkableSlopeAngleDegrees: 45,
        minRegionArea: 8,
        mergeRegionArea: 12,
        detailSampleDistance: 1,
        detailSampleMaxError: 0.5,
    } as SoloNavMeshOptions;

    const { navMesh } = generateSoloNavMesh(input, options);

    const roofCenter = new THREE.Vector3(0, roofHeight, 0);
    const roofRefResult = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        [roofCenter.x, roofCenter.y, roofCenter.z],
        [1, 1, 1],
        DEFAULT_QUERY_FILTER,
    );

    const roofRef = roofRefResult.success ? roofRefResult.nodeRef : 0;

    const goalRegion = new THREE.Box3(
        new THREE.Vector3(-groundHalf.x, -0.5, -groundHalf.y),
        new THREE.Vector3(groundHalf.x, 1.0, groundHalf.y),
    );

    addOffMeshConnection(navMesh, {
        start: [roofCenter.x + roofHalf.x - 1, roofHeight, roofCenter.z + roofHalf.y - 1],
        end: [roofCenter.x + roofHalf.x - 1, 0.5, roofCenter.z + roofHalf.y - 1],
        radius: 0.5,
        direction: OffMeshConnectionDirection.BIDIRECTIONAL,
        area: 1,
        flags: 0xffffff,
    });

    const roofGeometry = new THREE.BoxGeometry(roofHalf.x * 2, 0.6, roofHalf.y * 2);
    const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x303c4f });
    const roofMesh = new THREE.Mesh(roofGeometry, roofMaterial);
    roofMesh.position.set(roofCenter.x, roofHeight - 0.3, roofCenter.z);
    scene.add(roofMesh);

    const groundGeometry = new THREE.BoxGeometry(groundHalf.x * 2, 0.4, groundHalf.y * 2);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x1d1d1d });
    const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
    groundMesh.position.set(0, -0.2, 0);
    scene.add(groundMesh);

    return {
        navMesh,
        roofRef,
        roofCenter,
        goalRegion,
        queryFilter: DEFAULT_QUERY_FILTER,
    };
}
