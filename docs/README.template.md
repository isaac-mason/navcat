![./docs/cover.png](./docs/cover.png)


[![Version](https://img.shields.io/npm/v/navcat?style=for-the-badge)](https://www.npmjs.com/package/navcat)
![GitHub Workflow Status (with event)](https://img.shields.io/github/actions/workflow/status/isaac-mason/navcat/main.yml?style=for-the-badge)
[![Downloads](https://img.shields.io/npm/dt/navcat.svg?style=for-the-badge)](https://www.npmjs.com/package/navcat)


```bash
> npm install navcat
```

# navcat

navcat is a javascript navigation mesh construction and querying library for 3D floor-based navigation.

navcat is ideal for use in games, simulations, and creative websites that require pathfinding and AI navigation in complex 3D environments.

**Features**

- Navigation mesh generation from 3D geometry
- Navigation mesh querying
- Single and multi-tile navigation mesh support
- Pure javascript - no wasm
- Fully JSON serializable data structures
- Tiny - ~40 kB minified + gzipped, and highly tree-shakeable
- Works with any javascript engine/library - Babylon.js, PlayCanvas, Three.js, or your own engine

**Documentation**

This README provides curated explanations, guides, and examples to help you get started with navcat.

API documentation can be found at [navcat.dev/docs](https://navcat.dev/docs).

**Installation**

navcat is available on npm:

```bash
npm install navcat
```

**Changelog**

See the [CHANGELOG.md](./CHANGELOG.md) for a detailed list of changes in each version.

> **_NOTE:_** This library is under active development. In the leadup to a v1 release, you can expect APIs to improve and change in minor versions.

**Examples**

<Examples />

## Table of Contents

<TOC />

## What is a Navigation Mesh?

A navigation mesh (or navmesh) is a simplified representation of a 3D environment that is used for pathfinding and AI navigation in video games and simulations. It consists of interconnected polygons that define walkable areas within the environment. These polygons are connected by edges and off-mesh connections, allowing agents (characters) to move from one polygon to another.

![./docs/1-whats-a-navmesh](./docs/1-whats-a-navmesh.png)

## Can navcat be integrated with my engine/library?

navcat is agnostic of rendering or game engine library, so it will work well with any javascript engine - Babylon.js, PlayCanvas, Three.js, or your own engine.

If you are using threejs, you may make use of the utilities in the `navcat/three` entrypoint, see the [navcat/three docs](#navcatthree). Integrations for other engines may be added in future.

navcat adheres to the OpenGL conventions:

- Uses the right-handed coordinate system
- Indices should be in counter-clockwise winding order

If you are importing a navmesh created externally, note that navmesh poly vertices must be indexed / must share vertices between adjacent polygons.

If your environment uses a different coordinate system, you will need to transform coordinates going into and out of navcat.

The examples use threejs for rendering, but the core navcat APIs are completely agnostic of any rendering or game engine libraries.

## Quick Start / Minimal Example

Below is a minimal example of using the presets in `navcat/blocks` to generate a navigation mesh, and then using APIs in `navcat` to find a path on the generated navmesh.

For information on how to tune these options, and how the generation process works under the hood with images, see the [Navigation mesh generation](#navigation-mesh-generation) section below.

If you are using threejs, you can find [a threejs-specific version of this snippet in the navcat/three section](#navcatthree).

<Snippet source="./snippets/blocks.ts" select="quickstart" />

Below is a quick summary of the navmesh generation parameters used above, and how to start tuning them:

| Parameter                   | Description                                                                                                       | Range / Heuristic for 1 = 1m humanoid agents |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `cellSize`                  | Horizontal voxel size (XZ). Smaller = finer detail, slower generation.                                            | ≈ `walkableRadiusWorld / 3`                  |
| `cellHeight`                | Vertical voxel size (Y). Controls height resolution.                                                              | ≈ `walkableClimbWorld / 2`                   |
| `walkableRadiusWorld`       | Agent radius (half-width). Determines clearance around walls.                                                     | 0.2–0.5 m                                    |
| `walkableHeightWorld`       | Agent height. Areas with ceilings lower than this are excluded.                                                   | 1.6–2.0 m                                    |
| `walkableSlopeAngleDegrees` | Max slope angle the agent can walk. This filters out input triangles at the very beginning of navmesh generation. | 35–50°                                       |
| `walkableClimbWorld`        | Max step height. Allows stepping up/down small edges. This filters at the heightfield navmesh generation stage.   | 0.3–0.5 m                                    |
| `minRegionArea`             | Smallest isolated region kept.                                                                                    | 4–16 voxels                                  |
| `mergeRegionArea`           | Regions smaller than this merge into neighbors.                                                                   | 8–32 voxels                                  |
| `maxSimplificationError`    | Edge simplification tolerance (higher = simpler mesh).                                                            | 1–2                                          |
| `maxEdgeLength`             | Max polygon edge length before splitting.                                                                         | 8–24                                         |
| `maxVerticesPerPoly`        | Max vertices per polygon.                                                                                         | 3–6                                          |
| `detailSampleDistance`      | Distance between height samples (affects vertical detail).                                                        | `cellSize * 4–8`, e.g. `0.9`                 |
| `detailSampleMaxError`      | Allowed height deviation when simplifying detail mesh.                                                            | `cellHeight * 1–2`, e.g. `0.25`              |


## Navigation Mesh Querying

This section covers the main features you'll use for navigation mesh querying, including pathfinding, agent simulation, and spatial queries on your navigation mesh. For lower-level querying APIs and navmesh internals, see the [Advanced Navigation Mesh APIs](#advanced-navigation-mesh-apis) section.

### `findPath`

The `findPath` function is a convenience wrapper around `findNearestPoly`, `findNodePath`, and `findStraightPath` to get a path between two points on the navigation mesh.

**When to use:** This is the simplest way to find a complete path. Use this for one-off pathfinding queries, or when you aren't steering agents along a path and re-querying frequently.

<Snippet source="./snippets/solo-navmesh.ts" select="findPath" />

<RenderType type="import('navcat').findPath" />

<ApiDocsLink name="findPath" />

<ExamplesTable ids="example-find-path" />

### `findSmoothPath`

Combines `findNodePath`, `findStraightPath`, and `moveAlongSurface` to produce a smooth path that respects the navmesh surface.

**When to use:** Use this when you want a smooth path that follows the navmesh surface without sharp corners, and you need it infrequently (e.g. for visual previews, not for many agents per frame).

<RenderType type="import('navcat').findSmoothPath" />

<ApiDocsLink name="findSmoothPath" />

<ExamplesTable ids="example-find-smooth-path" />

### `findNodePath`

Finds a path through the navigation mesh as a sequence of polygon and offmesh connection node references.

**When to use:** Use this when you want to cache a node path and recalculate the straight path multiple times (e.g., for dynamic agent movement where the start position changes but the destination stays the same). This is more efficient than calling `findPath` repeatedly.

<Snippet source="./snippets/solo-navmesh.ts" select="findNodePath" />

<RenderType type="import('navcat').findNodePath" />

<ApiDocsLink name="findNodePath" />

### `findStraightPath`

Performs "string pulling" to convert a sequence of nodes into a series of waypoints that form the actual path an agent should follow.

**When to use:** Call this after `findNodePath` to get the actual waypoint positions. You might recalculate this frequently while keeping the same node path, or when implementing custom path following behavior.

<Snippet source="./snippets/solo-navmesh.ts" select="findStraightPath" />

<RenderType type="import('navcat').findStraightPath" />

<ApiDocsLink name="findStraightPath" />

### `moveAlongSurface`

Moves along a navmesh from a start position toward an end position along the navmesh surface, constrained to walkable areas.

This should be called with small movement deltas (e.g., per frame) to move an agent while respecting the navmesh boundaries.

**When to use:** Perfect for simple character controllers where you want to constrain movement to the navmesh without full pathfinding. Ideal for local movement, sliding along walls, or implementing custom movement logic that respects the navmesh.

<Snippet source="./snippets/solo-navmesh.ts" select="moveAlongSurface" />

<RenderType type="import('navcat').moveAlongSurface" />

<ApiDocsLink name="moveAlongSurface" />

<ExamplesTable ids="example-navmesh-constrained-character-controller,example-move-along-surface" />

### `raycast` & `raycastWithCosts`

Casts a ray along the navmesh surface to check for walkability and detect obstacles.

**When to use:** Check line-of-sight between positions, validate if a straight path exists, or detect walls/obstacles. Avoid using this for long rays; it's best suited for short-range checks given its two dimensional nature.

<Snippet source="./snippets/solo-navmesh.ts" select="raycast" />

<RenderType type="import('navcat').raycast" />

<Snippet source="./snippets/solo-navmesh.ts" select="raycastWithCosts" />

<RenderType type="import('navcat').raycastWithCosts" />

<ApiDocsLink name="raycast" />

<ApiDocsLink name="raycastWithCosts" />

<ExamplesTable ids="example-raycast" />

### `findNearestPoly`

Finds the nearest polygon on the navmesh to a given world position.

**When to use:** This is often your first step - use it to "snap" world positions onto the navmesh before pathfinding or querying. Essential when placing agents, checking if a position is on the navmesh, or converting world coordinates to navmesh coordinates.

<Snippet source="./snippets/solo-navmesh.ts" select="findNearestPoly" />

<RenderType type="import('navcat').findNearestPoly" />

<ApiDocsLink name="findNearestPoly" />

<ExamplesTable ids="example-find-nearest-poly" />

### `findRandomPoint`

Finds a random walkable point anywhere on the navmesh.

**When to use:** Spawn points, random patrol destinations, procedural NPC placement, or testing. Great for open-world scenarios where agents need random destinations across the entire navigable area.

<Snippet source="./snippets/solo-navmesh.ts" select="findRandomPoint" />

<RenderType type="import('navcat').findRandomPoint" />

<ApiDocsLink name="findRandomPoint" />

<ExamplesTable ids="example-find-random-point" />

### `findRandomPointAroundCircle`

Finds a random walkable point within a circular radius around a center position.

**When to use:** Local randomization like scatter formations, patrol areas around a point, or finding nearby positions. Perfect for "move near target" AI behaviors or creating natural-looking patrol patterns.

<Snippet source="./snippets/solo-navmesh.ts" select="findRandomPointAroundCircle" />

<RenderType type="import('navcat').findRandomPointAroundCircle" />

<ApiDocsLink name="findRandomPointAroundCircle" />

<ExamplesTable ids="example-find-random-point-around-circle" />

## Crowd Simulation

The `crowd` API in `navcat/blocks` provides a high-level agent simulation system built on top of navcat's pathfinding and local steering capabilities.

For simple use cases you can use it directly, and for more advanced use cases you might copy it into your project and modify it as needed.

- Agent management: add/remove agents, set target positions or velocities
- Frame-distributed pathfinding to maintain performance with many agents
- Agent-to-agent and wall avoidance
- Off-mesh connection support with animation hooks

It internally makes use of other `navcat/blocks` APIs like `pathCorridor`, `localBoundary`, and `obstacleAvoidance` to manage agent node corridors and handle obstacle avoidance.

See the docs for API specifics:
- `crowd`: https://navcat.dev/docs/modules/navcat_blocks.crowd.html
- `pathCorridor`: https://navcat.dev/docs/modules/navcat_blocks.pathCorridor.html
- `localBoundary`: https://navcat.dev/docs/modules/navcat_blocks.localBoundary.html
- `obstacleAvoidance`: https://navcat.dev/docs/modules/navcat_blocks.obstacleAvoidance.html

And see the below for interactive examples:

<ExamplesTable ids="example-crowd-simulation,example-crowd-simulation-stress-test" />

## Navigation Mesh Generation

### Overview

Navigation mesh generation is the process of transforming 3D geometry into a graph of walkable polygons. This graph is then used for pathfinding and navigation queries.

#### The Structure of a Navigation Mesh

A navigation mesh is organized into one or more **tiles**. Each tile contains walkable polygons and height detail information. For most projects, a single tile covering your entire level is perfect. For larger or dynamic worlds, you can split the navmesh into a grid of tiles.

Behind the scenes, navcat maintains a graph of **nodes** (representing polygons) and **links** (representing connections between polygons). This graph is what powers pathfinding - when you query for a path, navcat searches this graph to find the route.

If you want to dig deeper into the internal structure (useful for advanced cases like building custom pathfinding algorithms), the navigation mesh data is fully accessible. Check out the "Flow Field Pathfinding" example to see custom graph traversal in action.

#### Single-Tile vs Tiled Navigation Meshes

Most projects should start with a **single-tile navmesh** - it's simpler and covers the majority of use cases.

Consider using **tiled navmeshes** when you need:
- Dynamic updates (rebuild only affected tiles when geometry changes)
- Memory management (stream tiles in/out based on player location)
- Parallel generation (generate tiles independently)
- Large worlds (tiled navmesh generation can give better results over large areas)

For smaller, static scenes, a single-tile navmesh is simpler and sufficient.

How you want to manage tiles is up to you. You can create and add all navmesh tiles for a level at once, or you can create and add/remove tiles dynamically at runtime.

If you remove and re-add tiles at given coordinates, note that the node references for polygons will become invalidated. Any custom pathfinding logic you write that references polygons will need to call `isValidNodeRef` to check if a node reference is still valid before using it.

### Generation Presets

The `navcat/blocks` entrypoint provides `generateSoloNavMesh` and `generateTiledNavMesh` presets that bundle together the common steps of the navigation mesh generation process into easy-to-use functions.

If your use case is simple, you can use these presets to get started quickly. As your use case becomes more complex, you can eject from these presets by copying the functions (that are separate from navcat core) into your project and modifying them as needed.

You can find API docs for these blocks in the API docs:

- https://navcat.dev/docs/functions/navcat_blocks.generateSoloNavMesh.html
- https://navcat.dev/docs/functions/navcat_blocks.generateTiledNavMesh.html

See the Solo NavMesh and Tiled NavMesh examples for interactive examples of using these presets:

<ExamplesTable ids="example-solo-navmesh,example-tiled-navmesh" />

### Generation Process: Deep Dive

This section provides a deep-dive into how navigation mesh generation works. Understanding this process is useful for tuning parameters to get the best results for your specific environment and agent requirements.

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

#### 0. Input and setup

The input to the navigation mesh generation process is a set of 3D triangles that define the environment. These triangles should represent the collision surfaces in the environment, and shouldn't include any non-collidable decorative geometry that shouldn't affect navigation.

The input positions should adhere to the OpenGL conventions (right-handed coordinate system, counter-clockwise winding order).

The navigation mesh generation process emits diagnostic messages, warnings, and errors. These are captured with a build context object.

<Snippet source="./snippets/solo-navmesh.ts" select="input" />

![2-1-navmesh-gen-input](./docs/2-1-navmesh-gen-input.png)

<RenderType type="import('navcat').BuildContextState" />

#### 1. Mark walkable triangles

The first step is to filter the input triangles to find the walkable triangles. This is done by checking the slope of each triangle against a maximum walkable slope angle. Triangles that are walkable are marked with the `WALKABLE_AREA` (`1`) area type.

<Snippet source="./snippets/solo-navmesh.ts" select="walkableTriangles" />

![2-2-walkable-triangles](./docs/2-2-navmesh-gen-walkable-triangles.png)

<RenderType type="import('navcat').markWalkableTriangles" />

<RenderType type="import('navcat').createTriangleAreaIdsHelper" />

#### 2. Rasterize triangles into a heightfield, do filtering with the heightfield

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

<RenderType type="import('navcat').createHeightfieldHelper" />

#### 3. Build compact heightfield, erode walkable area, mark areas

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

<RenderType type="import('navcat').createCompactHeightfieldSolidHelper" />

#### 4. Build compact heightfield regions

The compact heightfield is then analyzed to identify distinct walkable regions. These regions are used to create the final navigation mesh.

Some of the region generation algorithms compute a distance field to identify regions.

<Snippet source="./snippets/solo-navmesh.ts" select="compactHeightfieldRegions" />

![2-5-distance-field](./docs/2-5-navmesh-gen-compact-heightfield-distances.png)

![2-6-regions](./docs/2-6-navmesh-gen-compact-heightfield-regions.png)

<RenderType type="import('navcat').buildDistanceField" />

<RenderType type="import('navcat').buildRegions" />

<RenderType type="import('navcat').buildRegionsMonotone" />

<RenderType type="import('navcat').buildLayerRegions" />

<RenderType type="import('navcat').createCompactHeightfieldDistancesHelper" />

<RenderType type="import('navcat').createCompactHeightfieldRegionsHelper" />

#### 5. Build contours from compact heightfield regions

Contours are generated around the edges of the regions. These contours are simplified to reduce the number of vertices while maintaining the overall shape.

<Snippet source="./snippets/solo-navmesh.ts" select="contours" />

![2-7-raw-contours](./docs/2-7-navmesh-gen-raw-contours.png)

![2-8-simplified-contours](./docs/2-8-navmesh-gen-simplified-contours.png)

<RenderSource type="import('navcat').ContourSet" />

<RenderSource type="import('navcat').Contour" />

<RenderType type="import('navcat').buildContours" />

<RenderType type="import('navcat').createRawContoursHelper" />

<RenderType type="import('navcat').createSimplifiedContoursHelper" />

#### 6. Build polygon mesh from contours, build detail mesh

From the simplified contours, a polygon mesh is created. This mesh consists of convex polygons that represent the walkable areas.

A "detail triangle mesh" is also generated to capture more accurate height information for each polygon.

<Snippet source="./snippets/solo-navmesh.ts" select="polyMesh" />

![2-9-poly-mesh](./docs/2-9-navmesh-gen-poly-mesh.png)

![2-10-detail-mesh](./docs/2-10-navmesh-gen-detail-mesh.png)

<RenderSource type="import('navcat').PolyMesh" />

<RenderSource type="import('navcat').PolyMeshDetail" />

<RenderType type="import('navcat').buildPolyMesh" />

<RenderType type="import('navcat').buildPolyMeshDetail" />

<RenderType type="import('navcat').createPolyMeshHelper" />

#### 7. Convert build-time poly mesh and poly mesh detail to runtime navmesh tile format

Next, we do a post-processing step on the poly mesh and the poly mesh detail to prepare them for use in the navigation mesh.

This step involes computing adjacency information for the polygons, and mapping the generation-time format to the runtime navigation mesh tile format.

<Snippet source="./snippets/solo-navmesh.ts" select="convert" />

<RenderType type="import('navcat').polyMeshToTilePolys" />

<RenderSource type="import('navcat').NavMeshPoly" />

<RenderType type="import('navcat').polyMeshDetailToTileDetailMesh" />

<RenderSource type="import('navcat').NavMeshPolyDetail" />

<RenderType type="import('navcat').createPolyMeshDetailHelper" />

#### 8. Assemble the navigation mesh

Finally, the polygon mesh and detail mesh are combined to create a navigation mesh tile. This tile can be used for pathfinding and navigation queries.

<Snippet source="./snippets/solo-navmesh.ts" select="navMesh" />

![./docs/1-whats-a-navmesh](./docs/1-whats-a-navmesh.png)

<RenderType type="import('navcat').createNavMesh" />

<RenderType type="import('navcat').buildTile" />

<RenderType type="import('navcat').addTile" />

<RenderType type="import('navcat').removeTile" />

<RenderType type="import('navcat').createNavMeshHelper" />

### Post-Processing

A common post-processing step after generating a navigation mesh is to flood-fill the navmesh from given "seed points" that represent valid starting locations, to exclude any isolated or unreachable areas. This is useful when generating navmeshes for complex environments where some inside of walls or on top of ceilings may be marked as walkable by the generation process, but are not actually reachable by agents for your use case.

The `navcat/blocks` entrypoint provides a `floodFillNavMesh` utility that helps with this process.

You can see the "Flood Fill Pruning" example to see how to use this utility:

<RenderType type="import('navcat/blocks').floodFillNavMesh" />

<ExamplesTable ids="example-flood-fill-pruning" />

### Custom Query Filters and Custom Area Types

Most navigation mesh querying APIs accept a `queryFilter` parameter that allows you to customize how the query is performed.

You can provide a cost calculation function to modify the cost of traversing polygons, and you can provide a filter function to include/exclude polygons based on their area and flags.

<RenderSource type="import('navcat').QueryFilter" />

<RenderSource type="import('navcat').DEFAULT_QUERY_FILTER" />

Many simple use cases can get far with using the default query `Nav.DEFAULT_QUERY_FILTER`. If you want to customise cost calculations, or include/exclude areas based on areas and flags, you can provide your own query filter that implements the `QueryFilter` type interface.

You can reference the "Custom Areas" example to see how to mark areas with different types and use a custom query filter:

<ExamplesTable ids="example-custom-areas,example-multiple-agent-sizes" />

### Off-Mesh Connections

Off-mesh connections enable navigation between non-adjacent areas by representing special traversal actions like jumping gaps, climbing ladders, teleporting, or opening doors.

**When to use:** Add off-mesh connections when your environment has gaps, vertical transitions, or special traversal mechanics that can't be represented by the standard navmesh polygons. The pathfinding system will automatically consider these connections when finding paths.

<Snippet source="./snippets/solo-navmesh.ts" select="offMeshConnections" />

To see a live example, see the "Off-Mesh Connections Example":

<ExamplesTable ids="example-off-mesh-connections" />

<RenderType type="import('navcat').addOffMeshConnection" />

<RenderType type="import('navcat').removeOffMeshConnection" />

<RenderType type="import('navcat').isOffMeshConnectionConnected" />

## Advanced Navigation Mesh APIs

This section covers lower-level APIs for working with the navigation mesh structure. Most users won't need these for everyday pathfinding, but they're useful for advanced use cases like understanding the navmesh internals, building custom pathfinding algorithms, or debugging.

### isValidNodeRef

<Snippet source="./snippets/solo-navmesh.ts" select="isValidNodeRef" />

<RenderType type="import('navcat').isValidNodeRef" />

### getNodeByRef

<Snippet source="./snippets/solo-navmesh.ts" select="getNodeByRef" />

<RenderType type="import('navcat').getNodeByRef" />

### getNodeByTileAndPoly

<Snippet source="./snippets/solo-navmesh.ts" select="getNodeByTileAndPoly" />

<RenderType type="import('navcat').getNodeByTileAndPoly" />

### getPolyHeight

<Snippet source="./snippets/solo-navmesh.ts" select="getPolyHeight" />

<RenderType type="import('navcat').getPolyHeight" />

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

## Using Externally Created Navigation Meshes

Although this library provides a robust method of generating navigation meshes from 3D geometry, you can also bring your own navigation meshes if you author them manually, or generate them with another tool.

You can pass any external polygon data to the `polygonsToNavMeshTilePolys` utility to convert it into the navcat runtime navigation mesh tile format.

You can also use `polysToTileDetailMesh` to generate a detail mesh for your polygons, or you can provide your own detail triangle mesh if you have height data for your polygons.

See the "Custom GLTF NavMesh" Example to see how to use an "externally generated" navigation mesh with navcat:

<ExamplesTable ids="example-custom-gltf-navmesh" />

## Saving and Loading NavMeshes

Because the navigation mesh is a normal JSON-serializable object, you can easily save and load navigation meshes to/from disk, or send them over a network. It is as simple as `JSON.stringify(navMesh)` and `JSON.parse(navMeshJsonString)`, really.

## Debug Utilities

navcat provides graphics-library agnostic debug drawing functions to help visualize the navmesh and related data structures.

If you are using threejs, you can use the `navcat/three` entrypoint's debug helpers to create threejs objects for visualization, see the [navcat/three section](#navcatthree) below.

If you are using a different library, you write your own functions to visualize the debug primitives below.

<Snippet source="./snippets/solo-navmesh.ts" select="debug" />

<RenderSource type="import('navcat').DebugPrimitive" />

<RenderSource type="import('navcat').DebugTriangles" />

<RenderSource type="import('navcat').DebugLines" />

<RenderSource type="import('navcat').DebugPoints" />

<RenderSource type="import('navcat').DebugBoxes" />

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

## Community

**Used in**

- [manablade.com](https://manablade.com)
- ... add your project!

**WebGameDev Discord**

Join the WebGameDev Discord to discuss navcat with other users and contributors, ask questions, and share your projects!

https://www.webgamedev.com/discord

## Acknowledgements

- This library is heavily inspired by the recastnavigation library: https://github.com/recastnavigation/recastnavigation
  - Although navcat is not a direct port of recastnavigation, the core navigation mesh generation approach is based on the recastnavigation library's voxelization-based approach.
- Shoutout to @verekia for the cute name idea :)
