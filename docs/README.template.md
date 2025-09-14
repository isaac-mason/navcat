<!-- Hi README.md editors, make changes in docs/README.template.md and run `node docs/build.js` :) -->

![./docs/cover.png](./docs/cover.png)

```bash
> npm install navcat
```

# navcat

navcat is a javascript navigation mesh construction and querying library for 3D floor-based navigation.

**Features**

- Navigation mesh generation from 3D geometry
- Navigation mesh querying
- Single and multi-tile navigation mesh support
- Pure javascript - no wasm
- Fully JSON serializable data structures
- Tiny - 40.32 kB minified + gzipped

**Examples**

<Examples />

## Introduction

### What is a navigation mesh?

A navigation mesh (or navmesh) is a simplified representation of a 3D environment that is used for pathfinding and AI navigation in video games and simulations. It consists of interconnected polygons that define walkable areas within the environment. These polygons are connected by edges and off-mesh connections, allowing agents (characters) to move from one polygon to another.

![./docs/1-whats-a-navmesh](./docs/1-whats-a-navmesh.png)

### The navcat navigation mesh structure

In navcat, a navigation mesh is represented as a graph of `nodes` and `links`.

Each `node` represents either a polygon in the navigation mesh or an off-mesh connection.

Each `link` represents a connection between two nodes, either between two polygons if they share an edge, or between a polygon and an off-mesh connection.

The "navigation mesh" object itself can contain many tiles in a grid, where navcat will stitch together the tiles into the global `nodes` and `links` used for pathfinding.

Because the navigation mesh is a fully JSON-serializable data structure, you can easily save and load navigation meshes to/from disk, or send them over a network. It is as simple as `JSON.stringify(navMesh)` and `JSON.parse(navMeshJsonString)`, really.

The navigation mesh data is transparent enough that you can write your own logic to traverse the navigation mesh graph if you need to, like in the "Flow Field Pathfinding" example.

### Can navcat be integrated with XYZ?

navcat is agnostic of other javascript libraries, but should work well with any of them.

There are some built-in utilities for creating debug visualisations with threejs. But navcat will work well with any javascript engine - Babylon.js, PlayCanvas, Three.js, or your own engine.

navcat works with vector3's that adhere to the OpenGL conventions:
- Uses the right-handed coordinate system
- Indices should be in counter-clockwise winding order

If your environment uses a different coordinate system, you will need to transform coordinates going into and out of navcat.

The examples use threejs for rendering, but the core navcat APIs are completely agnostic of any rendering or game engine libraries.

## How are navigation meshes generated with navcat?

The core of the navigation mesh generation approach is based on the [recastnavigation library](https://github.com/recastnavigation/recastnavigation)'s voxelization-based approach to navigation mesh generation.

At a high-level:
- Input triangles are rasterized into voxels / into a heightfield
- Voxels in areas where agents (defined by your parameters) would not be able to move are filtered and removed
- Walkable areas described by the voxel grid are divided into sets of polygonal regions
- Navigation mesh polygons are created by triangulating the generated polygonal regions

Like recast, navcat supports both single and tiled navigation meshes. Single-tile meshes are suitable for many simple, static cases and are easy to work with. Tiled navmeshes are more complex to work with but better support larger, more dynamic environments, and enable advanced use cases like re-baking, navmesh data-streaming.

Below is an overview of the steps involved in generating a "solo" / single-tile navigation mesh from a set of input triangles. If you want a copy-and-pasteable starter, see the examples:
- https://navcat.dev/examples#example-generate-navmesh
- [./examples/src/example-solo-navmesh.ts](./examples/src/example-solo-navmesh.ts)
- [./examples/src/common/generate-solo-nav-mesh.ts](./examples/src/common/generate-solo-nav-mesh.ts)

### 0. Input and setup

The input to the navigation mesh generation process is a set of 3D triangles that define the environment. These triangles should represent the collision surfaces in the environment, and shouldn't include any non-collidable decorative geometry that shouldn't affect navigation.

The input positions should adhere to the OpenGL conventions (right-handed coordinate system, counter-clockwise winding order).

The navigation mesh generation process emits diagnostic messages, warnings, and errors. These are captured with a build context object.

<Snippet source="./snippets/solo-navmesh.ts" select="input" />

![2-1-navmesh-gen-input](./docs/2-1-navmesh-gen-input.png)

<RenderType type="import('navcat').BuildContextState" />

### 1. Mark walkable triangles

The first step is to filter the input triangles to find the walkable triangles. This is done by checking the slope of each triangle against a maximum walkable slope angle. Triangles that are too steep are discarded.

<Snippet source="./snippets/solo-navmesh.ts" select="walkableTriangles" />

![2-2-walkable-triangles](./docs/2-2-navmesh-gen-walkable-triangles.png)

<RenderType type="import('navcat').markWalkableTriangles" />

### 2. Rasterize triangles into a heightfield, do filtering with the heightfield

The walkable triangles are then voxelized into a heightfield, taking the triangle's "walkability" into each span.

Some filtering is done to the heightfield to remove spans where a character cannot stand, and unwanted overhangs are removed. 

The heightfield resolution is configurable, and greatly affects the fidelity of the resulting navigation mesh, and the performance of the navigation mesh generation process.

<Snippet source="./snippets/solo-navmesh.ts" select="rasterize" />

![2-3-heightfield](./docs/2-3-navmesh-gen-heightfield.png)

<RenderSource type="import('navcat').Heightfield" />

<RenderSource type="import('navcat').HeightfieldSpan" />

<RenderType type="import('navcat').calculateMeshBounds" />

<RenderType type="import('navcat').calculateGridSize" />

<RenderType type="import('navcat').createHeightfield" />

<RenderType type="import('navcat').rasterizeTriangles" />

<RenderType type="import('navcat').filterLowHangingWalkableObstacles" />

<RenderType type="import('navcat').filterLedgeSpans" />

<RenderType type="import('navcat').filterWalkableLowHeightSpans" />

### 3. Build compact heightfield, erode walkable area

The heightfield is then compacted to only represent the top walkable surfaces.

The compact heightfield is generally eroded by the agent radius to ensure that the resulting navigation mesh is navigable by agents of the specified radius.

<Snippet source="./snippets/solo-navmesh.ts" select="compactHeightfield" />

![2-4-compact-heightfield](./docs/2-4-navmesh-gen-compact-heightfield.png)

<RenderSource type="import('navcat').CompactHeightfield" />

<RenderSource type="import('navcat').CompactHeightfieldCell" />

<RenderSource type="import('navcat').CompactHeightfieldSpan" />

<RenderType type="import('navcat').buildCompactHeightfield" />

<RenderType type="import('navcat').erodeWalkableArea" />

### 4. Build compact heightfield regions

The compact heightfield is then analyzed to identify distinct walkable regions. These regions are used to create the final navigation mesh.

Some of the region generation algorithms compute a distance field to identify regions.

<Snippet source="./snippets/solo-navmesh.ts" select="compactHeightfieldRegions" />

![2-5-distance-field](./docs/2-5-navmesh-gen-compact-heightfield-distances.png)

![2-6-regions](./docs/2-6-navmesh-gen-compact-heightfield-regions.png)

<RenderType type="import('navcat').buildDistanceField" />

<RenderType type="import('navcat').buildRegions" />

<RenderType type="import('navcat').buildRegionsMonotone" />

<RenderType type="import('navcat').buildLayerRegions" />

### 5. Build contours from compact heightfield regions

Contours are generated around the edges of the regions. These contours are simplified to reduce the number of vertices while maintaining the overall shape.

<Snippet source="./snippets/solo-navmesh.ts" select="contours" />

![2-7-raw-contours](./docs/2-7-navmesh-gen-raw-contours.png)

![2-8-simplified-contours](./docs/2-8-navmesh-gen-simplified-contours.png)

<RenderSource type="import('navcat').ContourSet" />

<RenderSource type="import('navcat').Contour" />

<RenderType type="import('navcat').buildContours" />

### 6. Build polygon mesh from contours, build detail mesh

From the simplified contours, a polygon mesh is created. This mesh consists of convex polygons that represent the walkable areas.

A "detail triangle mesh" is also generated to capture more accurate height information for each polygon.

<Snippet source="./snippets/solo-navmesh.ts" select="polyMesh" />

![2-9-poly-mesh](./docs/2-9-navmesh-gen-poly-mesh.png)

![2-10-detail-mesh](./docs/2-10-navmesh-gen-detail-mesh.png)

<RenderSource type="import('navcat').PolyMesh" />

<RenderSource type="import('navcat').PolyMeshDetail" />

<RenderType type="import('navcat').buildPolyMesh" />

<RenderType type="import('navcat').buildPolyMeshDetail" />

### 7. Assemble the navigation mesh

Finally, the polygon mesh and detail mesh are combined to create a navigation mesh tile. This tile can be used for pathfinding and navigation queries.

<Snippet source="./snippets/solo-navmesh.ts" select="navMesh" />

![./docs/1-whats-a-navmesh](./docs/1-whats-a-navmesh.png)

<RenderType type="import('navcat').createNavMesh" />

<RenderType type="import('navcat').polyMeshToTilePolys" />

<RenderSource type="import('navcat').NavMeshPoly" />

<RenderType type="import('navcat').polyMeshDetailToTileDetailMesh" />

<RenderSource type="import('navcat').NavMeshPolyDetail" />

<RenderType type="import('navcat').buildNavMeshBvTree" />

<RenderType type="import('navcat').addTile" />

<RenderType type="import('navcat').removeTile" />

## Navigation Mesh Querying

### findPath

The `findPath` function is a convenience wrapper around `findNearestPoly`, `findNodePath`, and `findStraightPath` to get a path between two points on the navigation mesh.

<Snippet source="./snippets/solo-navmesh.ts" select="findPath" />

<RenderType type="import('navcat').findPath" />

<Example id="example-find-path" />

### findNearestPoly

<Snippet source="./snippets/solo-navmesh.ts" select="findNearestPoly" />

<RenderType type="import('navcat').findNearestPoly" />

<Example id="example-find-nearest-poly" />

### findNodePath

<Snippet source="./snippets/solo-navmesh.ts" select="findNodePath" />

<RenderType type="import('navcat').findNodePath" />

### findStraightPath

<Snippet source="./snippets/solo-navmesh.ts" select="findStraightPath" />

<RenderType type="import('navcat').findStraightPath" />

### moveAlongSurface

<Snippet source="./snippets/solo-navmesh.ts" select="moveAlongSurface" />

<RenderType type="import('navcat').moveAlongSurface" />

<Example id="example-move-along-surface" />

<Example id="example-navmesh-constrained-character-controller" />

### raycast

<Snippet source="./snippets/solo-navmesh.ts" select="raycast" />

<RenderType type="import('navcat').raycast" />

<Example id="example-raycast" />

### getPolyHeight

<Snippet source="./snippets/solo-navmesh.ts" select="getPolyHeight" />

<RenderType type="import('navcat').getPolyHeight" />

### findRandomPoint

<Snippet source="./snippets/solo-navmesh.ts" select="findRandomPoint" />

<RenderType type="import('navcat').findRandomPoint" />

<Example id="example-find-random-point" />

### findRandomPointAroundCircle

<Snippet source="./snippets/solo-navmesh.ts" select="findRandomPointAroundCircle" />

<RenderType type="import('navcat').findRandomPointAroundCircle" />

<Example id="example-find-random-point-around-circle" />

### getClosestPointOnPoly

<Snippet source="./snippets/solo-navmesh.ts" select="getClosestPointOnPoly" />

<RenderType type="import('navcat').getClosestPointOnPoly" />

### closestPointOnDetailEdges

<Snippet source="./snippets/solo-navmesh.ts" select="closestPointOnDetailEdges" />

<RenderType type="import('navcat').closestPointOnDetailEdges" />

### getPortalPoints

<Snippet source="./snippets/solo-navmesh.ts" select="getPortalPoints" />

<RenderType type="import('navcat').getPortalPoints" />

### isValidNodeRef

<Snippet source="./snippets/solo-navmesh.ts" select="isValidNodeRef" />

<RenderType type="import('navcat').isValidNodeRef" />

### getNodeAreaAndFlags

<Snippet source="./snippets/solo-navmesh.ts" select="getNodeAreaAndFlags" />

<RenderType type="import('navcat').getNodeAreaAndFlags" />

### queryPolygons

<Snippet source="./snippets/solo-navmesh.ts" select="queryPolygons" />

<RenderType type="import('navcat').queryPolygons" />

### queryPolygonsInTile

<Snippet source="./snippets/solo-navmesh.ts" select="queryPolygonsInTile" />

<RenderType type="import('navcat').queryPolygonsInTile" />

## Custom Query Filter

... TODO ...

## Agent / Crowd Simulation

... TODO ...

## Off-Mesh Connections

Off-mesh connections are used for navigation that isn't just traversal between adjacent polygons. They can represent actions like jumping, climbing, or using a door, the details of how they are created and represented in animation are up to you.

<Snippet source="./snippets/solo-navmesh.ts" select="offMeshConnections" />

To see a live example, see the "Off-Mesh Connections Example":

<Example id="example-off-mesh-connections" />

<RenderType type="import('navcat').addOffMeshConnection" />

<RenderType type="import('navcat').removeOffMeshConnection" />

<RenderType type="import('navcat').isOffMeshConnectionConnected" />

## Tiled Navigation Meshes

navcat's navigation mesh structure is tile-based, so it is possible to either create a navigation mesh with one tile that covers the entire area, or to create a tiled navigation mesh with multiple tiles that each cover a portion of the area.

Tiled navigation meshes are more complex to work with, but they support larger environments, and enable advanced use cases like re-baking, navmesh data-streaming.

To see an example of creating a tiled navigation mesh, see the "Tiled NavMesh Example":

<Example id="example-tiled-navmesh" />

How you want to manage tiles is up to you. You can create all the tiles at once, or create and add/remove tiles dynamically at runtime.

If you remove and re-add tiles at given coordinates, note that the node references for polygons will become invalidated.

The structure of a navigation mesh node in navcat is `0,tileId,polyIndex`, where `0` is the node type, `tileId` is the incrementing index id of the tile, and `polyIndex` is the index of the polygon within that tile.

When you add a tile to a navigation mesh, a new unique `tileId` is assigned to the tile to force any existing node references to become invalid, so you don't accidentally start referencing polygons incorrectly.

## BYO Navigation Meshes

... TODO ...

## Debug Utilities

navcat provides graphics-library agnostic debug drawing functions to help visualize the navmesh and related data structures.

<Snippet source="./snippets/solo-navmesh.ts" select="debug" />

<RenderSource type="import('navcat').DebugPrimitive" />

<RenderSource type="import('navcat').DebugTriangles" />

<RenderSource type="import('navcat').DebugLines" />

<RenderSource type="import('navcat').DebugPoints" />

<RenderSource type="import('navcat').DebugBoxes" />

If you are using threejs, navcat provides utilities to convert the debug primitives into threejs objects, and convenience wrappers for the helper functions.

<Snippet source="./snippets/solo-navmesh.ts" select="debugThree" />

## Acknowledgements

... TODO ...
