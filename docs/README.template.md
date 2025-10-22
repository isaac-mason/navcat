![./docs/cover.png](./docs/cover.png)

```bash
> npm install navcat
```

# navcat

navcat is a javascript navigation mesh construction and querying library for 3D floor-based navigation.

> 🚧 navcat is undergoing heavy development ahead of a v1 release. if you want to try it out early, go ahead! but prepare for breaking changes :)

**Features**

- Navigation mesh generation from 3D geometry
- Navigation mesh querying
- Single and multi-tile navigation mesh support
- Pure javascript - no wasm
- Fully JSON serializable data structures
- Tiny - ~40 kB minified + gzipped, and highly tree-shakeable
- Works with any javascript engine/library - Babylon.js, PlayCanvas, Three.js, or your own engine

**Used in**

- [manablade.com](https://manablade.com)
- ... add your project!

**Examples**

<Examples />

## Table of Contents

<TOC />

## Quick Start

Below is a minimal example of using the presets in `navcat/blocks` to generate a navigation mesh, and then using APIs in `navcat` to find a path on the generated navmesh.

For information on how to tune these options, and how the generation process works under the hood with images, see the [Generating navigation meshes](#generating-navigation-meshes) section below.

If you are using threejs, you can find [a threejs-specific version of this snippet in the navcat/three section](#navcatthree).

<Snippet source="./snippets/blocks.ts" select="quickstart" />

## Introduction

### What is a navigation mesh?

A navigation mesh (or navmesh) is a simplified representation of a 3D environment that is used for pathfinding and AI navigation in video games and simulations. It consists of interconnected polygons that define walkable areas within the environment. These polygons are connected by edges and off-mesh connections, allowing agents (characters) to move from one polygon to another.

![./docs/1-whats-a-navmesh](./docs/1-whats-a-navmesh.png)

### Can navcat be integrated with XYZ?

navcat is agnostic of rendering or game engine library, so it will work well with any javascript engine - Babylon.js, PlayCanvas, Three.js, or your own engine.

If you are using threejs, you may make use of the utilities in the `navcat/three` entrypoint, see the [navcat/three docs](#navcatthree). Integrations for other engines may be added in future.

navcat adheres to the OpenGL conventions:
- Uses the right-handed coordinate system
- Indices should be in counter-clockwise winding order

If you are importing a navmesh created externally, note that navmesh poly vertices must be indexed / must share vertices between adjacent polygons.

If your environment uses a different coordinate system, you will need to transform coordinates going into and out of navcat.

The examples use threejs for rendering, but the core navcat APIs are completely agnostic of any rendering or game engine libraries.

## Navigation Mesh Generation

If you want to get started quickly and don't require deep customization, you can use the presets in `navcat/blocks`. See the [quick start](#quick-start) section above for a minimal example.

If you'd like to understand how to tweak navmesh generation parameters, or you want to eject from the presets and have more control over the generation process, read on!

### The navcat navigation mesh structure

In navcat, a navigation mesh can contain multiple "tiles", where each tile contains a set of polygons and a detail mesh. A navigation mesh can either have one tile that covers the entire area, or multiple tiles can be added in a grid for more advanced use cases.

As tiles are added and removed from a navmesh, a global graph of `nodes` and `links` is maintained to represent the entire navigation mesh, which is used for pathfinding and navigation queries.

Each `node` represents either a polygon in the navigation mesh or an off-mesh connection. Many APIs will accept a `NodeRef` to identify a specific polygon or off-mesh connection in the navigation mesh.

The `NodeRef` is a packed number that encodes the node type (polygon or off-mesh connection), the node index (index in the `navMesh.nodes` array), and a sequence number which handles invalidation of node references when tiles or off mesh connections are removed and re-added.

Each `link` represents a connection between two nodes, either between two polygons if they share an edge, or between a polygon and an off-mesh connection.

Because the navigation mesh is a fully JSON-serializable data structure, you can easily save and load navigation meshes to/from disk, or send them over a network. It is as simple as `JSON.stringify(navMesh)` and `JSON.parse(navMeshJsonString)`, really.

The navigation mesh data is transparent enough that you can write your own logic to traverse the navigation mesh graph if you need to, like in the "Flow Field Pathfinding" example.

### Navigation mesh generation process

The core of the navigation mesh generation approach is based on the [recastnavigation library](https://github.com/recastnavigation/recastnavigation)'s voxelization-based approach.

At a high-level:
- Input triangles are rasterized into voxels / into a heightfield
- Voxels in areas where agents (defined by your parameters) would not be able to move are filtered and removed
- Walkable areas described by the voxel grid are divided into sets of polygonal regions
- Navigation mesh polygons are created by triangulating the generated polygonal regions

Like recast, navcat supports both single and tiled navigation meshes. Single-tile meshes are suitable for many simple, static cases and are easy to work with. Tiled navmeshes are more complex to work with but better support larger, more dynamic environments, and enable advanced use cases like re-baking, navmesh data-streaming.

If you want an interactive example / starter, see the examples:
- https://navcat.dev/examples#example-generate-navmesh
- [./examples/src/example-solo-navmesh.ts](./examples/src/example-solo-navmesh.ts)
- [./blocks/generate-solo-nav-mesh.ts](./blocks/generate-solo-nav-mesh.ts)

If you are looking for a minimal snippet to copy & paste into your project to quick-start, see below. The sections following the snippet provides a step-by-step breakdown of the process with images and explanations.

<Snippet source="./snippets/solo-navmesh.ts" select="generationFull" />

### 0. Input and setup

The input to the navigation mesh generation process is a set of 3D triangles that define the environment. These triangles should represent the collision surfaces in the environment, and shouldn't include any non-collidable decorative geometry that shouldn't affect navigation.

The input positions should adhere to the OpenGL conventions (right-handed coordinate system, counter-clockwise winding order).

The navigation mesh generation process emits diagnostic messages, warnings, and errors. These are captured with a build context object.

<Snippet source="./snippets/solo-navmesh.ts" select="input" />

![2-1-navmesh-gen-input](./docs/2-1-navmesh-gen-input.png)

<RenderType type="import('navcat').BuildContextState" />

### 1. Mark walkable triangles

The first step is to filter the input triangles to find the walkable triangles. This is done by checking the slope of each triangle against a maximum walkable slope angle. Triangles that are walkable are marked with the `WALKABLE_AREA` (`1`) area type.

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

### 3. Build compact heightfield, erode walkable area, mark areas

The heightfield is then compacted to only represent the top walkable surfaces.

The compact heightfield is generally eroded by the agent radius to ensure that the resulting navigation mesh is navigable by agents of the specified radius.

<Snippet source="./snippets/solo-navmesh.ts" select="compactHeightfield" />

![2-4-compact-heightfield](./docs/2-4-navmesh-gen-compact-heightfield.png)

<RenderSource type="import('navcat').CompactHeightfield" />

<RenderSource type="import('navcat').CompactHeightfieldCell" />

<RenderSource type="import('navcat').CompactHeightfieldSpan" />

<RenderType type="import('navcat').buildCompactHeightfield" />

<RenderType type="import('navcat').erodeWalkableArea" />

<RenderType type="import('navcat').erodeAndMarkWalkableAreas" />

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

### 7. Convert build-time poly mesh and poly mesh detail to runtime navmesh tile format

Next, we do a post-processing step on the poly mesh and the poly mesh detail to prepare them for use in the navigation mesh.

This step involes computing adjacency information for the polygons, and mapping the generation-time format to the runtime navigation mesh tile format.

<Snippet source="./snippets/solo-navmesh.ts" select="convert" />

<RenderType type="import('navcat').polyMeshToTilePolys" />

<RenderSource type="import('navcat').NavMeshPoly" />

<RenderType type="import('navcat').polyMeshDetailToTileDetailMesh" />

<RenderSource type="import('navcat').NavMeshPolyDetail" />

### 8. Assemble the navigation mesh

Finally, the polygon mesh and detail mesh are combined to create a navigation mesh tile. This tile can be used for pathfinding and navigation queries.

<Snippet source="./snippets/solo-navmesh.ts" select="navMesh" />

![./docs/1-whats-a-navmesh](./docs/1-whats-a-navmesh.png)

<RenderType type="import('navcat').createNavMesh" />

<RenderType type="import('navcat').buildTile" />

<RenderType type="import('navcat').addTile" />

<RenderType type="import('navcat').removeTile" />

## Navigation Mesh Querying

### findPath

The `findPath` function is a convenience wrapper around `findNearestPoly`, `findNodePath`, and `findStraightPath` to get a path between two points on the navigation mesh.

<Snippet source="./snippets/solo-navmesh.ts" select="findPath" />

<RenderType type="import('navcat').findPath" />

<Example id="example-find-path" />

### isValidNodeRef

<Snippet source="./snippets/solo-navmesh.ts" select="isValidNodeRef" />

<RenderType type="import('navcat').isValidNodeRef" />

### getNodeByRef

<Snippet source="./snippets/solo-navmesh.ts" select="getNodeByRef" />

<RenderType type="import('navcat').getNodeByRef" />

### getNodeByTileAndPoly

<Snippet source="./snippets/solo-navmesh.ts" select="getNodeByTileAndPoly" />

<RenderType type="import('navcat').getNodeByTileAndPoly" />

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

### raycastWithCosts

<Snippet source="./snippets/solo-navmesh.ts" select="raycastWithCosts" />

<RenderType type="import('navcat').raycastWithCosts" />

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

### getClosestPointOnDetailEdges

<Snippet source="./snippets/solo-navmesh.ts" select="getClosestPointOnDetailEdges" />

<RenderType type="import('navcat').getClosestPointOnDetailEdges" />

### getPortalPoints

<Snippet source="./snippets/solo-navmesh.ts" select="getPortalPoints" />

<RenderType type="import('navcat').getPortalPoints" />

### queryPolygons

<Snippet source="./snippets/solo-navmesh.ts" select="queryPolygons" />

<RenderType type="import('navcat').queryPolygons" />

### queryPolygonsInTile

<Snippet source="./snippets/solo-navmesh.ts" select="queryPolygonsInTile" />

<RenderType type="import('navcat').queryPolygonsInTile" />

## Custom Query Filters and Custom Area Types

Most navigation mesh querying APIs accept a `queryFilter` parameter that allows you to customize how the query is performed.

You can provide a cost calculation function to modify the cost of traversing polygons, and you can provide a filter function to include/exclude polygons based on their area and flags.

<RenderSource type="import('navcat').QueryFilter" />

<RenderSource type="import('navcat').DEFAULT_QUERY_FILTER" />

Many simple use cases can get far with using the default query `Nav.DEFAULT_QUERY_FILTER`. If you want to customise cost calculations, or include/exclude areas based on areas and flags, you can provide your own query filter that implements the `QueryFilter` type interface.

You can reference the "Custom Areas" example to see how to mark areas with different types and use a custom query filter:

<Example id="example-custom-areas" />

<Example id="example-off-mesh-connections" />

<Example id="example-multiple-agent-sizes" />

## Agent / Crowd Simulation

This library provides tools for you to simulate agents / crowds navigating the navmesh, but it deliberately does not do everything for you.

Agent simulation varies greatly between use cases, with lots of different approaches to steering, collision avoidance, velocity control, off mesh connection animation, etc.

Instead of providing an abstraction for agent simulation, navcat provides a set of tools, and a "starting point" in the "Crowd Simulation Example". You can copy/paste this into your project and maintain full control over customizing the simulation to your needs.

<Example id="example-crowd-simulation" />

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

If you remove and re-add tiles at given coordinates, note that the node references for polygons will become invalidated. Any custom pathfinding logic you write that references polygons will need to call `isValidNodeRef` to check if a node reference is still valid before using it.

## BYO Navigation Meshes

Although this library provides a robust method of generating navigation meshes from 3D geometry, you can also bring your own navigation meshes if you author them manually, or generate them with another tool.

You can pass any external polygon data to the `polygonsToNavMeshTilePolys` utility to convert it into the navcat runtime navigation mesh tile format.

You can also use `polysToTileDetailMesh` to generate a detail mesh for your polygons, or you can provide your own detail mesh if you have height data for your polygons.

See the "Custom GLTF NavMesh" Example to see how to use an "externally generated" navigation mesh with navcat:

<Example id="example-custom-gltf-navmesh" />

## Debug Utilities

navcat provides graphics-library agnostic debug drawing functions to help visualize the navmesh and related data structures.

If you are using threejs, or want a reference of how to implement debug rendering, see the debug rendering code from the examples: [./examples/src/common/debug.ts](./examples/src/common/debug.ts)

<Snippet source="./snippets/solo-navmesh.ts" select="debug" />

<RenderSource type="import('navcat').DebugPrimitive" />

<RenderSource type="import('navcat').DebugTriangles" />

<RenderSource type="import('navcat').DebugLines" />

<RenderSource type="import('navcat').DebugPoints" />

<RenderSource type="import('navcat').DebugBoxes" />

## `navcat/blocks`

The `navcat/blocks` entrypoint provides presets and building blocks to help you get started quickly.

### Geometry Utilities

<RenderType type="import('navcat/blocks').mergePositionsAndIndices" />

### Generation Presets

<RenderType type="import('navcat/blocks').generateSoloNavMesh" />
<RenderType type="import('navcat/blocks').SoloNavMeshInput" />
<RenderType type="import('navcat/blocks').SoloNavMeshOptions" />
<RenderType type="import('navcat/blocks').SoloNavMeshResult" />

<RenderType type="import('navcat/blocks').generateTiledNavMesh" />
<RenderType type="import('navcat/blocks').TiledNavMeshInput" />
<RenderType type="import('navcat/blocks').TiledNavMeshOptions" />
<RenderType type="import('navcat/blocks').TiledNavMeshResult" />

## `navcat/three`

The `navcat/three` entrypoint provides some utilities to help integrate navcat with threejs.

Below is a snippet demonstrating how to use `getPositionsAndIndices` to extract geometry from a threejs mesh for navmesh generation, and how to use `createNavMeshHelper` to visualize the generated navmesh in threejs.

<Snippet source="./snippets/threejs.ts" select="quickstart" />

### Geometry Extraction

<RenderType type="import('navcat/three').getPositionsAndIndices" />

### Debug Helpers

<RenderType type="import('navcat/three').createTriangleAreaIdsHelper" />
<RenderType type="import('navcat/three').createHeightfieldHelper" />
<RenderType type="import('navcat/three').createCompactHeightfieldSolidHelper" />
<RenderType type="import('navcat/three').createCompactHeightfieldDistancesHelper" />
<RenderType type="import('navcat/three').createCompactHeightfieldRegionsHelper" />
<RenderType type="import('navcat/three').createRawContoursHelper" />
<RenderType type="import('navcat/three').createSimplifiedContoursHelper" />
<RenderType type="import('navcat/three').createPolyMeshHelper" />
<RenderType type="import('navcat/three').createPolyMeshDetailHelper" />
<RenderType type="import('navcat/three').createNavMeshHelper" />
<RenderType type="import('navcat/three').createNavMeshTileHelper" />
<RenderType type="import('navcat/three').createNavMeshPolyHelper" />
<RenderType type="import('navcat/three').createNavMeshTileBvTreeHelper" />
<RenderType type="import('navcat/three').createNavMeshLinksHelper" />
<RenderType type="import('navcat/three').createNavMeshBvTreeHelper" />
<RenderType type="import('navcat/three').createNavMeshTilePortalsHelper" />
<RenderType type="import('navcat/three').createNavMeshPortalsHelper" />
<RenderType type="import('navcat/three').createSearchNodesHelper" />
<RenderType type="import('navcat/three').createNavMeshOffMeshConnectionsHelper" />

## Acknowledgements

- This library is heavily inspired by the recastnavigation library: https://github.com/recastnavigation/recastnavigation
  - Although navcat is not a direct port of recastnavigation, the core navigation mesh generation approach is based on the recastnavigation library's voxelization-based approach.
- Shoutout to @verekia for the cute name idea :)
