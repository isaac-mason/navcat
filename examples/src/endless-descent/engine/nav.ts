import { generateSoloNavMesh, generateTiledNavMesh, type SoloNavMeshInput, type SoloNavMeshOptions, type TiledNavMeshInput, type TiledNavMeshOptions } from 'navcat/blocks';
import {
    addOffMeshConnection,
    DEFAULT_QUERY_FILTER,
    createFindNearestPolyResult,
    findNearestPoly,
    type NavMesh,
    type NodeRef,
    OffMeshConnectionDirection,
} from 'navcat';
import * as THREE from 'three/webgpu';
import { getPositionsAndIndices } from 'navcat/three';

export type EndlessNavEnvironment = {
    navMesh: NavMesh;
    roofRef: NodeRef;
    roofCenter: THREE.Vector3;
    goalRegion: THREE.Box3;
    queryFilter: typeof DEFAULT_QUERY_FILTER;
};

//

export function buildEndlessNavEnvironment(scene: THREE.Scene): EndlessNavEnvironment {
    const roofHeight = 18;
    const roofHalf = new THREE.Vector2(8, 8);
    const groundHalf = new THREE.Vector2(60, 60);

    // Visual meshes (also used for navmesh generation via getPositionsAndIndices)
    const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x2f3f5c });
    const roofGeometry = new THREE.BoxGeometry(roofHalf.x * 2, 0.6, roofHalf.y * 2);
    const roofMesh = new THREE.Mesh(roofGeometry, roofMaterial);
    roofMesh.position.set(0, roofHeight - 0.3, 0);
    scene.add(roofMesh);

    const groundGeometry = new THREE.BoxGeometry(groundHalf.x * 2, 0.4, groundHalf.y * 2);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x232323 });
    const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
    groundMesh.position.set(0, -0.2, 0);
    scene.add(groundMesh);

    const [positionsArr, indicesArr] = getPositionsAndIndices([roofMesh, groundMesh]);

    const input: SoloNavMeshInput = {
        positions: new Float32Array(positionsArr),
        indices: new Uint32Array(indicesArr),
    };

    const cellSize = 0.5;
    const cellHeight = 0.3;
    const walkableRadiusWorld = 0.3;
    const walkableRadiusVoxels = Math.max(1, Math.ceil(walkableRadiusWorld / cellSize));
    const walkableClimbWorld = 0.5;
    const walkableClimbVoxels = Math.max(1, Math.ceil(walkableClimbWorld / cellHeight));
    const walkableHeightWorld = 1.8;
    const walkableHeightVoxels = Math.max(1, Math.ceil(walkableHeightWorld / cellHeight));

    const detailSampleDistanceVoxels = 6;
    const detailSampleDistance = detailSampleDistanceVoxels < 0.9 ? 0 : cellSize * detailSampleDistanceVoxels;
    const detailSampleMaxErrorVoxels = 1;
    const detailSampleMaxError = cellHeight * detailSampleMaxErrorVoxels;

    const options: SoloNavMeshOptions = {
        cellSize,
        cellHeight,
        walkableRadiusWorld,
        walkableRadiusVoxels,
        walkableClimbWorld,
        walkableClimbVoxels,
        walkableHeightWorld,
        walkableHeightVoxels,
        walkableSlopeAngleDegrees: 45,
        borderSize: walkableRadiusVoxels + 2,
        minRegionArea: 8,
        mergeRegionArea: 12,
        maxSimplificationError: 1.3,
        maxEdgeLength: 32,
        maxVerticesPerPoly: 5,
        detailSampleDistance,
        detailSampleMaxError,
    };

    // Debug: input sanity
    console.log('[EndlessNav] Input', {
        positions: positionsArr.length,
        indices: indicesArr.length,
    });

    const result = generateSoloNavMesh(input, options);
    let { navMesh, intermediates } = result as any;

    // Debug: intermediates
    try {
        const hf = intermediates?.heightfield;
        const chf = intermediates?.compactHeightfield;
        const cs = intermediates?.contourSet;
        const pm = intermediates?.polyMesh;
        const pmd = intermediates?.polyMeshDetail;
        console.log('[EndlessNav] HF', hf ? `w=${hf.width} h=${hf.height}` : 'null');
        console.log('[EndlessNav] CHF', chf ? `w=${chf.width} h=${chf.height} spans=${chf.spans.length}` : 'null');
        console.log('[EndlessNav] Contours', cs ? `contours=${cs.contours.length}` : 'null');
        console.log('[EndlessNav] PolyMesh', pm ? `nPolys=${pm.nPolys} nVertices=${pm.nVertices}` : 'null');
        console.log('[EndlessNav] PolyMeshDetail', pmd ? `nMeshes=${pmd.nMeshes}` : 'null');
    } catch (e) {
        console.warn('[EndlessNav] Failed to log intermediates', e);
    }

    // If solo generation produced no polys, fallback to tiled generation for robustness
    try {
        const hasPolys = (() => {
            let count = 0;
            for (const id in navMesh.tiles) {
                const t = navMesh.tiles[id];
                if (!t) continue;
                count += t.polys.length;
            }
            return count > 0;
        })();

        if (!hasPolys) {
            console.warn('[EndlessNav] Solo navmesh empty, falling back to tiled generation');
            const tiledInput: TiledNavMeshInput = input;
            const tileSizeVoxels = 64;
            const tileSizeWorld = tileSizeVoxels * options.cellSize;
            const tiledOptions: TiledNavMeshOptions = {
                cellSize: options.cellSize,
                cellHeight: options.cellHeight,
                tileSizeVoxels,
                tileSizeWorld,
                walkableRadiusWorld: options.walkableRadiusWorld,
                walkableRadiusVoxels: options.walkableRadiusVoxels,
                walkableClimbWorld: options.walkableClimbWorld,
                walkableClimbVoxels: options.walkableClimbVoxels,
                walkableHeightWorld: options.walkableHeightWorld,
                walkableHeightVoxels: options.walkableHeightVoxels,
                walkableSlopeAngleDegrees: options.walkableSlopeAngleDegrees,
                borderSize: options.borderSize,
                minRegionArea: options.minRegionArea,
                mergeRegionArea: options.mergeRegionArea,
                maxSimplificationError: options.maxSimplificationError,
                maxEdgeLength: options.maxEdgeLength,
                maxVerticesPerPoly: options.maxVerticesPerPoly,
                detailSampleDistance: options.detailSampleDistance,
                detailSampleMaxError: options.detailSampleMaxError,
            };
            const tiledResult = generateTiledNavMesh(tiledInput, tiledOptions);
            navMesh = tiledResult.navMesh;
            console.log('[EndlessNav] Tiled fallback result', {
                tiles: Object.keys(navMesh.tiles).length,
            });
        }
    } catch (e) {
        console.warn('[EndlessNav] Tiled fallback failed', e);
    }

    // Debug: summarize navmesh contents
    try {
        const tileIds = Object.keys(navMesh.tiles);
        let totalVertices = 0;
        let totalPolys = 0;
        for (const id of tileIds) {
            const t = navMesh.tiles[id];
            if (!t) continue;
            totalVertices += t.vertices.length / 3;
            totalPolys += t.polys.length;
        }
        const offMeshCount = Object.keys(navMesh.offMeshConnections).length;
        const linkCount = navMesh.links.length;
        // eslint-disable-next-line no-console
        console.log('[EndlessNav] NavMesh summary', {
            tiles: tileIds.length,
            totalVertices,
            totalPolys,
            links: linkCount,
            offMeshConnections: offMeshCount,
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[EndlessNav] Failed to log NavMesh summary', e);
    }

    const roofCenter = new THREE.Vector3(0, roofHeight, 0);
    const searchExtents: [number, number, number] = [roofHalf.x, 2, roofHalf.y];
    const roofRefResult = findNearestPoly(
        createFindNearestPolyResult(),
        navMesh,
        [roofCenter.x, roofCenter.y, roofCenter.z],
        searchExtents,
        DEFAULT_QUERY_FILTER,
    );

    const roofRef = roofRefResult.success ? roofRefResult.nodeRef : 0;

    const goalRegion = new THREE.Box3(
        new THREE.Vector3(-groundHalf.x, -0.5, -groundHalf.y),
        new THREE.Vector3(groundHalf.x, 1.0, groundHalf.y),
    );

    const offMeshStart: [number, number, number] = [
        roofHalf.x - 1,
        roofHeight,
        roofHalf.y - 1,
    ];

    addOffMeshConnection(navMesh, {
        start: offMeshStart,
        end: [offMeshStart[0], 0.5, offMeshStart[2]],
        radius: 0.5,
        direction: OffMeshConnectionDirection.BIDIRECTIONAL,
        area: 1,
        flags: 0xffffff,
    });

    // Debug: confirm off-mesh connection was added
    try {
        const offMeshCount = Object.keys(navMesh.offMeshConnections).length;
        // eslint-disable-next-line no-console
        console.log('[EndlessNav] OffMesh connections after add:', offMeshCount);
    } catch {}

    // roofCenter is (0, roofHeight, 0)

    return {
        navMesh,
        roofRef,
        roofCenter,
        goalRegion,
        queryFilter: DEFAULT_QUERY_FILTER,
    };
}
