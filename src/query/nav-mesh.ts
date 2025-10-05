import type { Box3, Vec3 } from 'maaths';
import type { IndexPool } from '../index-pool';
import type { NodeRef, NodeType } from './node';

/** A navigation mesh based on tiles of convex polygons */
export type NavMesh = {
    /** The world space origin of the navigation mesh's tiles */
    origin: Vec3;

    /** The width of each tile along the x axis */
    tileWidth: number;

    /** The height of each tile along the z axis */
    tileHeight: number;

    /** Global nodes */
    nodes: Array<NavMeshNode>;

    /** Global links. Check 'allocated' for whether the link is in use. */
    links: Array<NavMeshLink>;

    /** Off mesh connection definitions */
    offMeshConnections: Record<string, OffMeshConnection>;

    /** Off mesh connection attachments */
    offMeshConnectionAttachments: Record<string, OffMeshConnectionAttachment>;

    /** Map of tile ids to tiles */
    tiles: Record<string, NavMeshTile>;

    /** Map of tile position hashes to tile ids */
    tilePositionToTileId: Record<string, number>;

    /** Map of tile column hashes to array of tile ids in that column */
    tileColumnToTileIds: Record<string, number[]>;

    /** Map of tile position hashes to sequence counter */
    tilePositionToSequenceCounter: Record<string, number>;

    /** The off mesh connection sequence counter */
    offMeshConnectionSequenceCounter: number;

    /** Pool for node indices */
    nodeIndexPool: IndexPool;

    /** Pool for tile indices */
    tileIndexPool: IndexPool;

    /** Pool for off mesh connection indices */
    offMeshConnectionIndexPool: IndexPool;

    /** Pool for link indices */
    linkIndexPool: IndexPool;
};

export type NavMeshPoly = {
    /** The indices of the polygon's vertices. vertices are stored in NavMeshTile.vertices */
    vertices: number[];

    /**
     * Packed data representing neighbor polygons references and flags for each edge.
     * This is usually computed by the navcat's `buildPolyNeighbours` function .
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

    /** The offset of the triangles in the NavMeshTile detailTriangles array */
    trianglesBase: number;

    /** The number of vertices in thde sub-mesh */
    verticesCount: number;

    /** The number of triangles in the sub-mesh */
    trianglesCount: number;
};


export type NavMeshNode = {
    /** whether the node is currently allocated */
    allocated: boolean;

    /** the index of the node */
    index: number;

    /** the node ref, packed type, index, sequence */
    ref: NodeRef;

    /** links for this nav mesh node */
    links: number[];

    /** the type of the nav mesh node */
    type: NodeType;

    /** the tile id, for poly nodes */
    tileId: number;

    /** the poly index, for poly nodes */
    polyIndex: number;

    /** the offmesh connection id, for offmesh connection nodes */
    offMeshConnectionId: number;

    /** the offmesh connection side, for offmesh connection nodes */
    offMeshConnectionSide: number;
};

export type NavMeshLink = {
    /** whether the nav mesh link is allocated */
    allocated: boolean;

    /** the id of the link */
    id: number;

    /** the node index that owns this link */
    fromNodeIndex: number;

    /** node reference that owns this link */
    fromNodeRef: NodeRef;

    /** index of the neighbour node that ref links to */
    toNodeIndex: number;

    /** the neighbour node reference that ref links to */
    toNodeRef: NodeRef;

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

export type OffMeshConnection = {
    /** the id of the off mesh connection */
    id: number;
    /** the sequence of the off mesh connection */
    sequence: number;
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

export type OffMeshConnectionParams = Omit<OffMeshConnection, 'id' | 'sequence'>;

export type OffMeshConnectionAttachment = {
    /** the start offmesh node */
    startOffMeshNode: NodeRef;

    /** the end offmesh node */
    endOffMeshNode: NodeRef;

    /** the start polygon that the off mesh connection has linked to */
    startPolyNode: NodeRef;

    /** the end polygon that the off mesh connection has linked to */
    endPolyNode: NodeRef;
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
    /** the id of the tile */
    id: number;

    /** the salt of the tile */
    sequence: number;

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

    /** poly index to global node index */
    polyNodes: number[]

    /** the tile's bounding volume tree */
    bvTree: NavMeshTileBvTree | null;

    /**
     * The xz-plane cell size of the polygon mesh.
     * If this tile was generated with voxelization, it should be the voxel cell size.
     * If the tile was created with a different method, use a value that approximates the level of precision required for the tile.
     */
    cellSize: number;

    /**
     * The y-axis cell height of the polygon mesh.
     * If this tile was generated with voxelization, it should be the voxel cell height.
     * If the tile was created with a different method, use a value that approximates the level of precision required for the tile.
     */
    cellHeight: number;

    /** the agent height in world units */
    walkableHeight: number;

    /** the agent radius in world units */
    walkableRadius: number;

    /** the agent maximum traversable ledge (up/down) in world units */
    walkableClimb: number;
};

export type NavMeshTileParams = Omit<NavMeshTile, 'id' | 'sequence' | 'polyNodes'>;
