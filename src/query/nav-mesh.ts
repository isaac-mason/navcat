import type { Box3, Vec3 } from 'maaths';
import type { NodeRef } from './node';

/** A navigation mesh based on tiles of convex polygons */
export type NavMesh = {
    /** the world space origin of the navigation mesh's tiles */
    origin: Vec3;

    /** the width of each tile along the x axis */
    tileWidth: number;

    /** the height of each tile along the z axis */
    tileHeight: number;

    /** node ref to link indices */
    nodes: Record<NodeRef, number[]>;

    /** global navmesh links pool */
    links: NavMeshLink[];

    /** free link indices */
    freeLinkIndices: number[];

    /** the tile id counter */
    tileIdCounter: number;

    /** map of tile ids to tiles */
    tiles: Record<string, NavMeshTile>;

    /** map of tile position hashes to tile ids */
    tilePositionHashToTileId: Record<string, number>;

    /** the off mesh connection id counter */
    offMeshConnectionIdCounter: number;

    /** off mesh connection definitions */
    offMeshConnections: Record<string, NavMeshOffMeshConnection>;

    /** states of the off mesh connections */
    offMeshConnectionStates: Record<string, NavMeshOffMeshConnectionState>;
};

export type NavMeshPoly = {
    /** The indices of the polygon's vertices. vertices are stored in NavMeshTile.vertices */
    vertices: number[];

    /**
     * Packed data representing neighbor polygons references and flags for each edge.
     * This is usually computed by the nav3d's `buildPolyNeighbours` function .
     */
    neis: number[];

    /** The user defined flags for this polygon */
    flags: number;

    /** The user defined area id for this polygon */
    area: number;
};

export type NavMeshPolyDetail = {
    /**
     * The offset of the vertices in the NavMeshTile detailVertices array.
     * If the base index is between 0 and `NavMeshTile.vertices.length`, this is used to index into the NavMeshTile vertices array.
     * If the base index is greater than `NavMeshTile.vertices.length`, it is used to index into the NavMeshTile detailVertices array.
     * This allows for detail meshes to either re-use the polygon vertices or to define their own vertices without duplicating data.
     */
    verticesBase: number;

    /** the offset of the triangles in the NavMeshTile detailTriangles array */
    trianglesBase: number;

    /** the number of vertices in thde sub-mesh */
    verticesCount: number;

    /** the number of trianges in the sub-mesh */
    trianglesCount: number;
};

export type NavMeshLink = {
    /** whether the link is currently allocated (ie in use), or false if it's pooled */
    allocated: boolean;

    /** node reference that owns this link */
    ref: NodeRef;

    /** the neighbour node reference that ref links to */
    neighbourRef: NodeRef;

    /** index of the polygon edge that owns this link */
    edge: number;

    /** if a boundary link, defines on which side the link is */
    side: number;

    /** if a boundary link, defines the min sub-edge area */
    bmin: number;

    /** if a boundary link, defines the max sub-edge area */
    bmax: number;
};

export enum OffMeshConnectionDirection {
    START_TO_END = 0,
    BIDIRECTIONAL = 1,
}

export enum OffMeshConnectionSide {
    START = 0,
    END = 1,
}

export type NavMeshOffMeshConnection = {
    /** the start position of the off mesh connection */
    start: Vec3;
    /** the end position of the off mesh connection */
    end: Vec3;
    /** the radius of the endpoints */
    radius: number;
    /** the direction of the off mesh connection */
    direction: OffMeshConnectionDirection;
    /** the flags for the off mesh connection */
    flags: number;
    /** the area id for the off mesh connection */
    area: number;
    /**
     * optional override cost for this connection.
     * if this is provided, the default query filter getCost() will return this value instead of using the distance of the start to end.
     */
    cost?: number;
};

export type NavMeshOffMeshConnectionState = {
    /** the start polygon that the off mesh connection has linked to */
    startPolyRef: NodeRef;
    /** the end polygon that the off mesh connection has linked to */
    endPolyRef: NodeRef;
};

export type NavMeshBvNode = {
    /** bounds of the bv node */
    bounds: Box3;
    /** the node's index */
    i: number;
};

export type NavMeshTileBvTree = {
    /** the tile bounding volume nodes */
    nodes: NavMeshBvNode[];

    /** the quantisation factor for the bounding volume tree */
    quantFactor: number;
};

export type NavMeshTile = {
    /** the unique id of the tile */
    id: number;

    /* the tile x position in the nav mesh */
    tileX: number;

    /* the tile y position in the nav mesh */
    tileY: number;

    /** the tile layer in the nav mesh */
    tileLayer: number;

    /** the bounds of the tile's AABB */
    bounds: Box3;

    /** nav mesh tile vertices in world space */
    vertices: number[];

    /** the detail meshes */
    detailMeshes: NavMeshPolyDetail[];

    /** the detail mesh's unique vertices, in local tile space */
    detailVertices: number[];

    /** the detail mesh's triangles */
    detailTriangles: number[];

    /** the tile polys */
    polys: NavMeshPoly[];

    /** the tile's bounding volume tree */
    bvTree: NavMeshTileBvTree | null;

    /**
     * The xz-plane cell size of the polygon mesh.
     * If this tile was generated with voxelization, it should be the voxel cell size.
     * If the tile was created with a different method, use a value that approximates the level of precision required for the tile.
     * This is used to:
     * - quantize the tile's bounding volume tree, for all dimensions (x, y, z)
     * - ...
     */
    cellSize: number;

    /**
     * The y-axis cell height of the polygon mesh.
     * If this tile was generated with voxelization, it should be the voxel cell height.
     * If the tile was created with a different method, use a value that approximates the level of precision required for the tile.
     * This is used to:
     * - ...
     */
    cellHeight: number;

    /** the agent height in world units */
    walkableHeight: number;

    /** the agent radius in world units */
    walkableRadius: number;

    /** the agent maximum traversable ledge (up/down) in world units */
    walkableClimb: number;
};
