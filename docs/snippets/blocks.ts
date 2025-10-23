/* SNIPPET_START: quickstart */
import { DEFAULT_QUERY_FILTER, findPath, type Vec3 } from 'navcat';
import { generateSoloNavMesh, type SoloNavMeshInput, type SoloNavMeshOptions } from 'navcat/blocks';

/* generation input */
// populate positions and indices with your level geometry
// don't include geometry that shouldn't contribute to walkable-surface
// generation, like foliage or small decorative props
const positions = new Float32Array([
    /* ... */
]);
const indices = new Uint32Array([
    /* ... */
]);

const input: SoloNavMeshInput = {
    positions,
    indices,
};

/* generation options */
// the following are defaults you might start from for a human-sized agent in a 1 m scale world.
// it's generally recommended that you use the library debug helpers to visualize the navmesh
// generation and fine tune these parameters.

// agent parameters: the navmesh will be built to accommodate an agent with these dimensions
const walkableRadiusWorld = 0.3; // how wide the agent is
const walkableHeightWorld = 2.0; // how tall the agent is
const walkableClimbWorld = 0.5; // how high the agent can step
const walkableSlopeAngleDegrees = 45; // how steep a slope the agent can walk up

// voxelization: triangles are rasterized into a voxel grid.
// smaller cells = more detail (slower); larger = simpler, faster.
// heuristic: cellSize ≈ radius/3, cellHeight ≈ climb/2
// typically adjusted based on level scale and desired detail.
const cellSize = 0.15; // horizontal (xz) voxel size
const cellHeight = 0.15; // vertical (y) voxel size

// using these, we’ll calculate voxel-based equivalents of the agent dimensions
const walkableRadiusVoxels = Math.ceil(walkableRadiusWorld / cellSize);
const walkableClimbVoxels = Math.ceil(walkableClimbWorld / cellHeight);
const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);

// region merging (simplifies contiguous walkable areas)
const minRegionArea = 8; // minimum isolated region size
const mergeRegionArea = 20; // regions smaller than this will be merged with neighbors

// polygon generation: tradeoff between detail and mesh complexity
const maxSimplificationError = 1.3; // how far simplified edges can deviate from the original raw contour
const maxEdgeLength = 12; // max polygon edge length
const maxVerticesPerPoly = 5; // max vertices per polygon

// detail mesh sampling: vertical pathfinding precision
// higher values increase generation time and memory usage, but can be useful for very uneven surfaces
const detailSampleDistanceVoxels = 6; // distance between sample points, smaller values increase precision
const detailSampleMaxErrorVoxels = 1; // height error tolerance per sample

// convert detail sampling from voxel units to world units
const detailSampleDistance = detailSampleDistanceVoxels < 0.9 ? 0 : cellSize * detailSampleDistanceVoxels;
const detailSampleMaxError = cellHeight * detailSampleMaxErrorVoxels;

// optional border padding (used for seamless tile edges, 0 for single meshes)
const borderSize = 0;

const options: SoloNavMeshOptions = {
    cellSize,
    cellHeight,
    walkableRadiusWorld,
    walkableRadiusVoxels,
    walkableClimbWorld,
    walkableClimbVoxels,
    walkableHeightWorld,
    walkableHeightVoxels,
    walkableSlopeAngleDegrees,
    borderSize,
    minRegionArea,
    mergeRegionArea,
    maxSimplificationError,
    maxEdgeLength,
    maxVerticesPerPoly,
    detailSampleDistance,
    detailSampleMaxError,
};

/* generate the navmesh */
const result = generateSoloNavMesh(input, options);

const navMesh = result.navMesh; // the nav mesh
const intermediates = result.intermediates; // intermediate data for debugging

console.log('generated navmesh:', navMesh, intermediates);

/* find a path */
const start: Vec3 = [-4, 0, -4];
const end: Vec3 = [4, 0, 4];
const halfExtents: Vec3 = [0.5, 0.5, 0.5];

const path = findPath(navMesh, start, end, halfExtents, DEFAULT_QUERY_FILTER);

console.log(
    'path:',
    path.path.map((p) => p.position),
);
/* SNIPPET_END: quickstart */
