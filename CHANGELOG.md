# CHANGELOG

## 0.0.5 (Unreleased)

- feat: avoid using structuredClone in compact heightfield mergeRegions logic for better perf 
- feat: remove array allocations in heightfield.ts hot paths

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
