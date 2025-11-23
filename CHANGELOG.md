# CHANGELOG

## 0.1.1 (Unreleased)

- feat: `navcat/blocks` `chunkyTriMesh` module, for building a 2D spatial partitioning structure over triangle meshes for fast bounds queries
- feat: update `navcat/blocks` `generateTiledNavMesh` to use `chunkyTriMesh` for faster tile building with reduction of redundant triangle rasterization
- fix: crowd requestMoveTarget calls should never be treated as a replan

## 0.1.0

- initial alpha release!
  - no changes from v0.0.11, just a version bump to mark the first release
  - from here forward, in the leadup to a v1 release, breaking API changes will be released as minor version bumps

## 0.0.11

- feat: documentation improvements
- feat: isOffMeshConnectionConnected jsdoc improvements
- feat: add `createDefaultQueryFilter`, for creating a default query filter object that can have `includeFlags` and `excludeFlags` modified

## 0.0.10

- feat: make some `crowd.addAgent` parameters optional with defaults
- feat: flatten `CrowdAgent` `params` properties onto `CrowdAgent` type
- feat: add option for whether to collect obstacle avoidance debug info, saving on computation and memory allocation
- feat: obstacle avoidance code optimisations, avoid allocating objects in hot paths 
- feat: add topology optimization and visibility optimization update flags to crowd, following DetourCrowd algorithm
- feat: use `finalizeSlicedFindNodePathPartial` after crowd quick search so agents start moving faster, following DetourCrowd implementation
  - agents move faster at the expense of a small chance they start moving in a suboptimal direction initially
- feat: introduce `INVALID_NODE_REF` (-1) constant
- fix: use `INVALID_NODE_REF` (-1) instead of `0` for invalid node refs in crowd, path corridor, local boundary logic
- feat: add `navMesh` argument to crowd.addAgent, initialize the agent's corridor on adding to the crowd

## 0.0.9

- feat: add `floodFillNavMesh` to `navcat/blocks` for finding reachable and unreachable polygon nodes from seed polygons
- feat: standardize "position", "point", "center", "nodeRef", "ref" naming in APIs and types
  - standardize on "position" for 3D points in space
  - standardize on "nodeRef" for navmesh polygon references e.g. "nodeRef", "startNodeRef", "endNodeRef"
  - breaking:
    - `FindPathResult`: `startPoint` and `endPoint` renamed to `startPosition` and `endPosition`
    - `FindSmoothPathResult`: `startPoint` and `endPoint` renamed to `startPosition` and `endPosition`
    - `FindNearestPolyResult`: `point` renamed to `position`
    - `GetClosestPointOnPolyResult`: `closestPoint` renamed to `position`
    - `crowd` `Agent` type: `offMeshAnimation.startPos` and `offMeshAnimation.endPos` renamed to `offMeshAnimation.startPosition` and `offMeshAnimation.endPosition`
    - `SlicedNodePathQuery`: `startPos` and `endPos` renamed to `startPosition` and `endPosition`
    - `SlicedNodePathQuery`: `startRef` and `endRef` renamed to `startNodeRef` and `endNodeRef`
    - `FindNearestPolyResult`: `ref` renamed to `nodeRef`
    - `FindRandomPointResult`: `ref` renamed to `nodeRef`
    - `FindRandomPointAroundCircleResult`: `randomRef` renamed to `nodeRef`
    - `MoveAlongSurfaceResult`: `resultPosition` renamed to `position`, `resultRef` renamed to `nodeRef`

## 0.0.8

- feat: add `crowd` and `pathCorridor` APIs to `navcat/blocks`, updated examples to use them for crowd simulation
- fix: findStraightPath handling of offmesh connections
  - credit to @FlorentMasson for investigating and sharing a patch for one of the string pulling with offmesh links algorithm fixes
- feat: change `maaths` dependency to `mathcat` as it was renamed in v0.0.6

## 0.0.7

- feat: add `navcat/blocks` entrypoint, which will home higher level apis and presets for navmesh generation and querying
  - moved `generateSoloNavMesh` and `generateTiledNavMesh` from the examples into `navcat/blocks` to begin
  - moved `mergePositionsAndIndices` utility from `navcat` to `navcat/blocks`
- feat: add 'erodeAndMarkWalkableAreas', which provides a way to support multiple agent radiuses in a single navmesh by marking spans that are too narrow for larger agents with different area IDs
- feat: re-export `Vec3` and `Box3` types from `maaths`
- fix: pointInPoly not returning true for points on edges of polygons

## 0.0.6

- feat: add 'createNavMeshTileHelper' helper, similar to 'createNavMeshHelper' for visualizing individual tiles
- fix: contour set removeDegenerateSegments skipping segments
- feat: split 'raycast' into 'raycast' and 'raycastWithCosts'
- feat: 'prevRef' parameter on 'raycastWithCosts' and prev ref tracking for accurate raycast cost calculations
- feat: updated 'finalizeSlicedFindNodePath' signature to finalizeSlicedFindNodePath(navMesh, slicedQuery)
- fix: add missing 'finalizeSlicedFindNodePathPartial' shortcut logic
- feat: update maaths from v0.0.4 to v0.0.5
- feat: add markRotatedBoxArea compact heightfield utility

## 0.0.5

- feat: avoid using structuredClone in compact heightfield mergeRegions logic for better perf 
- feat: remove array allocations in heightfield.ts hot paths
- fix: getTileAt
- fix: findNodePath, updateSlicedFindNodePath getCost calls
- fix: allocateNode should set node.allocated = true
- fix: offmesh connection node allocation and deallocation
- feat: add 'calculateCosts' argument to raycast
- fix: use raycast with calculateCosts in updateSlicedFindNodePath for correct cost calculation when shortcuts span multiple polygons
- fix: 'getPortalPoints' for off mesh connections, store 'edge' in offmesh connection links
- feat: only allocate one node for bidirectional offmesh connections instead of two

## 0.0.4

- feat: add NavMeshTileParams, don't require providing dummy NavMeshTile 'id' and 'salt'
- feat: return NavMeshTile from addTile
- feat: use packed numbers as node refs instead of strings for faster node ref ser/des and comparison
- fix: poly mesh detail dirs swapping logic
- feat: refactor contour set generation logic
- feat: use an index pool for tile ids and offmesh connection ids to avoid increasingly larger numbers being used as ids
- feat: change navMesh.nodes to be an array with pooled node indices instead of a map keyed by refs
- feat: change NodeRef to store a node type, a node index, and a node sequence number for invalidation
- fix: remove existing tiles in positio
n in addTile before adding new tile
- fix: contour set simplifyContour shif
ting bug
- feat: remove OffMeshConnections 'cost' override property, it is easily and more flexibly implementable with a custom query filter
- feat: remove 'getNodeAreaAndFlags', replace by adding 'areas' and 'flags' to navmesh.nodes
- fix: bv tree bounds logic should consider both poly mesh vertices and poly mesh detail vertices
- feat: require building bv trees for tiles, remove non bv tree codepaths
- feat: introduce 'buildTile' api for building a tile's bv tree and initializing runtime properties
- feat: change 'addTile' to take a built tile instead of building internally

## 0.0.3

- feat: remove `three` dependency from navcat, move threejs utilities to examples in lieu of a potential @navcat/three package in the future
- feat: add `markCylinderArea` compact heightfield function for marking all spans within a cylinder area with a given area ID
- feat: change `queryPolygons` to accept a `bounds` Box3 instead of center and halfExtents, same as `queryPolygonsInTile`
- Change `FindNearestPolyResult` property names from `nearestPolyRef` and `nearestPoint` to `ref` and `point`
- feat: refactor poly mesh vertex duplication logic in `buildPolyMesh`
- feat: remove all all error throwing in `buildPolyMesh`, replace with build context errors and best-effort continued processing
- fix: poly mesh detail `getHeightData` BFS logic

## 0.0.2

- feat: move `mergePositionsAndIndices` out of `import('navcat').three` to core / top level export
- fix: issues with `buildPolyMeshDetail` duplicating vertices when detailSampleDistance and detailSampleMaxError are set to add new samples to reduce error
- feat: Use circumcircle implementation from maaths in poly mesh detail building logic

## 0.0.1

- feat: pre-alpha testing release. Use at your own risk!
