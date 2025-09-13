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

**Showcase Examples**

<table>
  <tr>
    <td align="center">
      <a href="https://navcat.dev/examples#example-find-path">
        <img src="./examples/public/screenshots/example-find-path.png" width="180" height="120" style="object-fit:cover;"/><br/>
        A* Pathfinding
      </a>
    </td>
    <td align="center">
      <a href="https://navcat.dev/examples#example-navmesh-constrained-controller">
        <img src="./examples/public/screenshots/example-navmesh-constrained-character-controller.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Character Controllers
      </a>
    </td>
    <td align="center">
      <a href="https://navcat.dev/examples#example-crowd-simulation">
        <img src="./examples/public/screenshots/example-crowd-simulation.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Crowd Simulation
      </a>
    </td>
    <td align="center">
      <a href="https://navcat.dev/examples#example-flow-field">
        <img src="./examples/public/screenshots/example-flow-field-pathfinding.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Flow Field Pathfinding
      </a>
    </td>
  </tr>
</table>

## Can navcat be used with XYZ?

navcat is agnostic of other javascript libraries, but should work well with any of them.

There are some built-in utilities for creating debug visualisations with threejs. But navcat will work well with any javascript engine - Babylon.js, PlayCanvas, Three.js, or your own engine.

navcat works with vector3's that adhere to the OpenGL conventions:
- Uses the right-handed coordinate system
- Indices should be in counter-clockwise winding order

If your environment uses a different coordinate system, you will need to transform coordinates going into and out of navcat.

## What's a navigation mesh?

A navigation mesh (or navmesh) is a simplified representation of a 3D environment that is used for pathfinding and AI navigation in video games and simulations. It consists of interconnected polygons (usually triangles or convex shapes) that define walkable areas within the environment. These polygons are connected by edges, allowing characters or agents to move from one polygon to another.

![./docs/1-whats-a-navmesh](./docs/1-whats-a-navmesh.png)

In navcat, a navigation mesh is a fully JSON-serializable object that contains navigation mesh tile data, off-mesh connections, and `nodes` and `links` for the stitched together navigation mesh tiles and off-mesh connections.

<RenderType="import('navcat').NavMesh" />

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

### 1. Mark walkable triangles

The first step is to filter the input triangles to find the walkable triangles. This is done by checking the slope of each triangle against a maximum walkable slope angle. Triangles that are too steep are discarded.

<Snippet source="./snippets/solo-navmesh.ts" select="walkableTriangles" />

![2-2-walkable-triangles](./docs/2-2-navmesh-gen-walkable-triangles.png)

### 2. Rasterize triangles into a heightfield, do filtering with the heightfield

The walkable triangles are then voxelized into a heightfield, taking the triangle's "walkability" into each span.

Some filtering is done to the heightfield to remove spans where a character cannot stand, and unwanted overhangs are removed. 

The heightfield resolution is configurable, and greatly affects the fidelity of the resulting navigation mesh, and the performance of the navigation mesh generation process.

<Snippet source="./snippets/solo-navmesh.ts" select="rasterize" />

![2-3-heightfield](./docs/2-3-navmesh-gen-heightfield.png)

### 3. Build compact heightfield, erode walkable area

The heightfield is then compacted to only represent the top walkable surfaces.

The compact heightfield is generally eroded by the agent radius to ensure that the resulting navigation mesh is navigable by agents of the specified radius.

<Snippet source="./snippets/solo-navmesh.ts" select="compactHeightfield" />

![2-4-compact-heightfield](./docs/2-4-navmesh-gen-compact-heightfield.png)

### 4. Build compact heightfield regions

The compact heightfield is then analyzed to identify distinct walkable regions. These regions are used to create the final navigation mesh.

Some of the region generation algorithms compute a distance field to identify regions.

<Snippet source="./snippets/solo-navmesh.ts" select="compactHeightfieldRegions" />

![2-5-distance-field](./docs/2-5-navmesh-gen-compact-heightfield-distances.png)

![2-6-regions](./docs/2-6-navmesh-gen-compact-heightfield-regions.png)

### 5. Build contours from compact heightfield regions

Contours are generated around the edges of the regions. These contours are simplified to reduce the number of vertices while maintaining the overall shape.

<Snippet source="./snippets/solo-navmesh.ts" select="contours" />

![2-7-raw-contours](./docs/2-7-navmesh-gen-raw-contours.png)

![2-8-simplified-contours](./docs/2-8-navmesh-gen-simplified-contours.png)

### 6. Build polygon mesh from contours, build detail mesh

From the simplified contours, a polygon mesh is created. This mesh consists of convex polygons that represent the walkable areas.

A "detail triangle mesh" is also generated to capture more accurate height information for each polygon.

<Snippet source="./snippets/solo-navmesh.ts" select="polyMesh" />

![2-9-poly-mesh](./docs/2-9-navmesh-gen-poly-mesh.png)

![2-10-detail-mesh](./docs/2-10-navmesh-gen-detail-mesh.png)

### 7. Assemble the navigation mesh

Finally, the polygon mesh and detail mesh are combined to create a navigation mesh tile. This tile can be used for pathfinding and navigation queries.

<Snippet source="./snippets/solo-navmesh.ts" select="navMesh" />

## Navigation Mesh Debugging

...

### Navigation Mesh Serialization & Deserialization

All navigation mesh data structures in navcat are fully JSON serializable. This means you can easily save and load navigation meshes to/from disk, or send them over a network.

It is as simple as `JSON.stringify(navMesh)` and `JSON.parse(navMeshJsonString)`, really.

## Navigation Mesh Querying

...

## Off-mesh Connections

...

## Tiled Navigation Meshes

...

## BYO Navigation Meshes

...

## Acknowledgements

...

