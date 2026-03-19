import GUI from "lil-gui";
import {
  generateSoloNavMesh,
  SoloNavMeshIntermediates,
  type SoloNavMeshInput,
  type SoloNavMeshOptions,
} from "navcat/blocks";
import {
  createCompactHeightfieldDistancesHelper,
  createCompactHeightfieldRegionsHelper,
  createCompactHeightfieldSolidHelper,
  createHeightfieldHelper,
  createNavMeshBvTreeHelper,
  createNavMeshHelper,
  createNavMeshLinksHelper,
  createPolyMeshDetailHelper,
  createPolyMeshHelper,
  createRawContoursHelper,
  createSimplifiedContoursHelper,
  createTriangleAreaIdsHelper,
  getPositionsAndIndices,
  type DebugObject,
} from "navcat/three";
import * as THREE from "three";

import { OrbitControls } from "three/examples/jsm/Addons.js";
import { createExample } from "./common/example-base";
import { loadGLTF } from "./common/load-gltf";

import { box3, vec2, Vec3 } from "mathcat";
import {
  addTile,
  buildCompactHeightfield,
  BuildContext,
  BuildContextState,
  buildContours,
  buildDistanceField,
  buildPolyMesh,
  buildPolyMeshDetail,
  buildRegions,
  buildTile,
  calculateGridSize,
  calculateMeshBounds,
  ContourBuildFlags,
  createHeightfield,
  createNavMesh,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  Heightfield,
  markWalkableTriangles,
  NavMeshTileParams,
  polyMeshDetailToTileDetailMesh,
  polyMeshToTilePolys,
  rasterizeTriangles,
  rasterizeBox,
  rasterizeConvex,
  rasterizeSphere,
  rasterizeCapsule,
  rasterizeCylinder,
  WALKABLE_AREA,
  NULL_AREA,
} from "navcat";
import { TransformControls } from "three/examples/jsm/Addons.js";

/* setup example scene */
const container = document.getElementById("root")!;
const { scene, camera, renderer } = await createExample(container);

camera.position.set(-2, 10, 10);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const navTestModel = await loadGLTF("./models/nav-test.glb");
scene.add(navTestModel.scene);

/* navmesh generation parameters */
const config = {
  cellSize: 0.15,
  cellHeight: 0.15,
  walkableRadiusWorld: 0.1,
  walkableClimbWorld: 0.5,
  walkableHeightWorld: 0.25,
  walkableSlopeAngleDegrees: 45,
  borderSize: 0,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxSimplificationError: 1.3,
  maxEdgeLength: 12,
  maxVerticesPerPoly: 5,
  detailSampleDistance: 6,
  detailSampleMaxError: 1,
};

/* debug helpers configuration */
const debugConfig = {
  showMesh: true,
  showTriangleAreaIds: false,
  showHeightfield: false,
  showCompactHeightfieldSolid: false,
  showCompactHeightfieldDistances: false,
  showCompactHeightfieldRegions: false,
  showRawContours: false,
  showSimplifiedContours: false,
  showPolyMesh: false,
  showPolyMeshDetail: false,
  showNavMeshBvTree: false,
  showNavMesh: true,
  showNavMeshLinks: false,
};

/* setup gui */
const gui = new GUI();
gui.title("NavMesh Generation");

const cellFolder = gui.addFolder("Heightfield");
cellFolder.add(config, "cellSize", 0.01, 1, 0.01);
cellFolder.add(config, "cellHeight", 0.01, 1, 0.01);

const walkableFolder = gui.addFolder("Agent");
walkableFolder.add(config, "walkableRadiusWorld", 0, 2, 0.01);
walkableFolder.add(config, "walkableClimbWorld", 0, 2, 0.01);
walkableFolder.add(config, "walkableHeightWorld", 0, 2, 0.01);
walkableFolder.add(config, "walkableSlopeAngleDegrees", 0, 90, 1);

const regionFolder = gui.addFolder("Region");
regionFolder.add(config, "borderSize", 0, 10, 1);
regionFolder.add(config, "minRegionArea", 0, 50, 1);
regionFolder.add(config, "mergeRegionArea", 0, 50, 1);

const contourFolder = gui.addFolder("Contour");
contourFolder.add(config, "maxSimplificationError", 0.1, 10, 0.1);
contourFolder.add(config, "maxEdgeLength", 0, 50, 1);

const polyMeshFolder = gui.addFolder("PolyMesh");
polyMeshFolder.add(config, "maxVerticesPerPoly", 3, 12, 1);

const detailFolder = gui.addFolder("Detail");
detailFolder.add(config, "detailSampleDistance", 0, 16, 0.1);
detailFolder.add(config, "detailSampleMaxError", 0, 16, 0.1);

const debugFolder = gui.addFolder("Debug Helpers");
debugFolder
  .add(debugConfig, "showMesh")
  .name("Show Mesh")
  .onChange(() => {
    navTestModel.scene.visible = debugConfig.showMesh;
  });
debugFolder
  .add(debugConfig, "showTriangleAreaIds")
  .name("Triangle Area IDs")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showHeightfield")
  .name("Heightfield")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showCompactHeightfieldSolid")
  .name("Compact Heightfield Solid")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showCompactHeightfieldDistances")
  .name("Compact Heightfield Distances")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showCompactHeightfieldRegions")
  .name("Compact Heightfield Regions")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showRawContours")
  .name("Raw Contours")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showSimplifiedContours")
  .name("Simplified Contours")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showPolyMesh")
  .name("Poly Mesh")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showPolyMeshDetail")
  .name("Poly Mesh Detail")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showNavMeshBvTree")
  .name("NavMesh BV Tree")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showNavMesh")
  .name("NavMesh")
  .onChange(updateDebugHelpers);
debugFolder
  .add(debugConfig, "showNavMeshLinks")
  .name("NavMesh Links")
  .onChange(updateDebugHelpers);
let result: ReturnType<typeof generateSoloNavMesh> | null = null;

// Debug helper objects
const debugHelpers: {
  triangleAreaIds: DebugObject | null;
  heightfield: DebugObject | null;
  compactHeightfieldSolid: DebugObject | null;
  compactHeightfieldDistances: DebugObject | null;
  compactHeightfieldRegions: DebugObject | null;
  rawContours: DebugObject | null;
  simplifiedContours: DebugObject | null;
  polyMesh: DebugObject | null;
  polyMeshDetail: DebugObject | null;
  navMeshBvTree: DebugObject | null;
  navMesh: DebugObject | null;
  navMeshLinks: DebugObject | null;
} = {
  triangleAreaIds: null,
  heightfield: null,
  compactHeightfieldSolid: null,
  compactHeightfieldDistances: null,
  compactHeightfieldRegions: null,
  rawContours: null,
  simplifiedContours: null,
  polyMesh: null,
  polyMeshDetail: null,
  navMeshBvTree: null,
  navMesh: null,
  navMeshLinks: null,
};

function clearDebugHelpers() {
  Object.values(debugHelpers).forEach((helper) => {
    if (helper) {
      scene.remove(helper.object);
      helper.dispose();
    }
  });

  // Reset all references
  debugHelpers.triangleAreaIds = null;
  debugHelpers.heightfield = null;
  debugHelpers.compactHeightfieldSolid = null;
  debugHelpers.compactHeightfieldDistances = null;
  debugHelpers.compactHeightfieldRegions = null;
  debugHelpers.rawContours = null;
  debugHelpers.simplifiedContours = null;
  debugHelpers.polyMesh = null;
  debugHelpers.polyMeshDetail = null;
  debugHelpers.navMeshBvTree = null;
  debugHelpers.navMesh = null;
  debugHelpers.navMeshLinks = null;
}

function updateDebugHelpers() {
  if (!result) return;

  const { navMesh, intermediates } = result;

  // Clear existing helpers
  clearDebugHelpers();

  // Create debug helpers based on current config
  if (debugConfig.showTriangleAreaIds) {
    debugHelpers.triangleAreaIds = createTriangleAreaIdsHelper(
      intermediates.input,
      intermediates.triAreaIds,
    );
    scene.add(debugHelpers.triangleAreaIds.object);
  }

  if (debugConfig.showHeightfield) {
    debugHelpers.heightfield = createHeightfieldHelper(
      intermediates.heightfield,
    );
    scene.add(debugHelpers.heightfield.object);
  }

  if (debugConfig.showCompactHeightfieldSolid) {
    debugHelpers.compactHeightfieldSolid = createCompactHeightfieldSolidHelper(
      intermediates.compactHeightfield,
    );
    scene.add(debugHelpers.compactHeightfieldSolid.object);
  }

  if (debugConfig.showCompactHeightfieldDistances) {
    debugHelpers.compactHeightfieldDistances =
      createCompactHeightfieldDistancesHelper(intermediates.compactHeightfield);
    scene.add(debugHelpers.compactHeightfieldDistances.object);
  }

  if (debugConfig.showCompactHeightfieldRegions) {
    debugHelpers.compactHeightfieldRegions =
      createCompactHeightfieldRegionsHelper(intermediates.compactHeightfield);
    scene.add(debugHelpers.compactHeightfieldRegions.object);
  }

  if (debugConfig.showRawContours) {
    debugHelpers.rawContours = createRawContoursHelper(
      intermediates.contourSet,
    );
    scene.add(debugHelpers.rawContours.object);
  }

  if (debugConfig.showSimplifiedContours) {
    debugHelpers.simplifiedContours = createSimplifiedContoursHelper(
      intermediates.contourSet,
    );
    scene.add(debugHelpers.simplifiedContours.object);
  }

  if (debugConfig.showPolyMesh) {
    debugHelpers.polyMesh = createPolyMeshHelper(intermediates.polyMesh);
    scene.add(debugHelpers.polyMesh.object);
  }

  if (debugConfig.showPolyMeshDetail) {
    debugHelpers.polyMeshDetail = createPolyMeshDetailHelper(
      intermediates.polyMeshDetail,
    );
    scene.add(debugHelpers.polyMeshDetail.object);
  }

  if (debugConfig.showNavMeshBvTree) {
    debugHelpers.navMeshBvTree = createNavMeshBvTreeHelper(navMesh);
    scene.add(debugHelpers.navMeshBvTree.object);
  }

  if (debugConfig.showNavMesh) {
    debugHelpers.navMesh = createNavMeshHelper(navMesh);
    debugHelpers.navMesh.object.position.y += 0.1;
    scene.add(debugHelpers.navMesh.object);
  }

  if (debugConfig.showNavMeshLinks) {
    debugHelpers.navMeshLinks = createNavMeshLinksHelper(navMesh);
    scene.add(debugHelpers.navMeshLinks.object);
  }
}

//walkable volumes
const walkableVolume1 = new THREE.Mesh(
  new THREE.DodecahedronGeometry(),
  new THREE.MeshStandardMaterial({
    color: 0x00ff00,
    transparent: true,
    opacity: 0.75,
  }),
);
walkableVolume1.position.set(-2, 0, -7);
walkableVolume1.rotation.y = Math.PI / 4;

const walkableVolumes = [walkableVolume1];

//null volumes
const nullVolume1 = new THREE.Mesh(
  new THREE.CapsuleGeometry(),
  new THREE.MeshStandardMaterial({
    color: 0xff0000, //red
    transparent: true,
    opacity: 0.75,
  }),
);
nullVolume1.position.set(2, 0, -7);
nullVolume1.rotation.z = Math.PI / 4;
nullVolume1.userData.exclude = true; // exclude mesh from navmesh input

const nullVolumes = [nullVolume1];

scene.add(...walkableVolumes, ...nullVolumes);

function isExcluded(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.exclude === true) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function addDraggers(object: THREE.Object3D) {
  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode("translate");
  transformControls.attach(object);

  transformControls.addEventListener("mouseDown", () => {
    orbitControls.enabled = false;
  });

  transformControls.addEventListener("mouseUp", () => {
    orbitControls.enabled = true;
  });

  const dragHelper = transformControls.getHelper();
  dragHelper.userData.exclude = true;
  scene.add(dragHelper);
}

for (const nullVolume of nullVolumes) addDraggers(nullVolume);
for (const walkableVolume of walkableVolumes) addDraggers(walkableVolume);

function Vector3ToVec3(vector: THREE.Vector3): Vec3 {
  return [vector.x, vector.y, vector.z];
}

function rasterizeThreeSphereGeometry(
  hf: Heightfield,
  geometry: THREE.Mesh<THREE.SphereGeometry>,
  area: number,
  flagMergeThr: number,
  ctx: BuildContextState,
) {
  rasterizeSphere(
    hf,
    Vector3ToVec3(geometry.position),
    geometry.scale.length() / 2,
    area,
    flagMergeThr,
    ctx,
  );
}

function rasterizeThreeCapsuleGeometry(
  hf: Heightfield,
  geometry: THREE.Mesh<THREE.CapsuleGeometry>,
  area: number,
  flagMergeThr: number,
  ctx: BuildContextState,
) {
  const { radius, height } = geometry.geometry.parameters;
  const halfHeight = height / 2;
  const start = new THREE.Vector3(0, halfHeight, 0).applyMatrix4(
    geometry.matrixWorld,
  );
  const finish = new THREE.Vector3(0, -halfHeight, 0).applyMatrix4(
    geometry.matrixWorld,
  );
  rasterizeCapsule(
    hf,
    Vector3ToVec3(start),
    Vector3ToVec3(finish),
    radius,
    area,
    flagMergeThr,
    ctx,
  );
}

function rasterizeThreeCylinderGeometry(
  hf: Heightfield,
  geometry: THREE.Mesh<THREE.CylinderGeometry>,
  area: number,
  flagMergeThr: number,
  ctx: BuildContextState,
) {
  const { radiusTop, radiusBottom, height } = geometry.geometry.parameters;
  const halfHeight = height / 2;
  const start = new THREE.Vector3(0, halfHeight, 0).applyMatrix4(
    geometry.matrixWorld,
  );
  const finish = new THREE.Vector3(0, -halfHeight, 0).applyMatrix4(
    geometry.matrixWorld,
  );
  //TODO: support for different top and bottom radii
  rasterizeCylinder(
    hf,
    Vector3ToVec3(start),
    Vector3ToVec3(finish),
    radiusTop,
    area,
    flagMergeThr,
    ctx,
  );
}

function rasterizeThreeBoxGeometry(
  hf: Heightfield,
  geometry: THREE.Mesh<THREE.BoxGeometry>,
  area: number,
  flagMergeThr: number,
  ctx: BuildContextState,
) {
  const halfEdges: Vec3[] = [0, 1, 2].map((i) => {
    const v = new THREE.Vector3()
      .setComponent(i, geometry.scale.getComponent(i) / 2)
      .applyQuaternion(geometry.quaternion);
    return Vector3ToVec3(v);
  });

  rasterizeBox(
    hf,
    Vector3ToVec3(geometry.position),
    halfEdges,
    area,
    flagMergeThr,
    ctx,
  );
}

function rasterizeThreeConvexGeometry(
  hf: Heightfield,
  geometry: THREE.Mesh,
  area: number,
  flagMergeThr: number,
  ctx: BuildContextState,
) {
  const walkableMeshes: THREE.Mesh[] = [];
  geometry.traverse((object) => {
    if (object instanceof THREE.Mesh) walkableMeshes.push(object);
  });
  const [vertices, triangles] = getPositionsAndIndices(walkableMeshes);

  rasterizeConvex(hf, vertices, triangles, area, flagMergeThr, ctx);
}

function rasterizeThreeGeometry(
  hf: Heightfield,
  geometry: THREE.Mesh,
  area: number,
  flagMergeThr: number,
  ctx: BuildContextState
) {
  if (geometry.geometry instanceof THREE.SphereGeometry) {
    rasterizeThreeSphereGeometry(hf, geometry as THREE.Mesh<THREE.SphereGeometry>, area, flagMergeThr, ctx);
  } else if (geometry.geometry instanceof THREE.CapsuleGeometry) {
    rasterizeThreeCapsuleGeometry(hf, geometry as THREE.Mesh<THREE.CapsuleGeometry>, area, flagMergeThr, ctx);
  } else if (geometry.geometry instanceof THREE.CylinderGeometry) {
    rasterizeThreeCylinderGeometry(hf, geometry as THREE.Mesh<THREE.CylinderGeometry>, area, flagMergeThr, ctx);
  } else if (geometry.geometry instanceof THREE.BoxGeometry) {
    rasterizeThreeBoxGeometry(hf, geometry as THREE.Mesh<THREE.BoxGeometry>, area, flagMergeThr, ctx);
  } else {
    //TODO: support for concave geometry
    rasterizeThreeConvexGeometry(hf, geometry, area, flagMergeThr, ctx);
  }
}

function generateSoloNavMeshWithVolumes(
  input: SoloNavMeshInput,
  options: SoloNavMeshOptions,
) {
  /* 1. create build context, gather inputs and options */

  const ctx = BuildContext.create();

  BuildContext.start(ctx, "navmesh generation");

  const { positions, indices } = input;

  const {
    cellSize,
    cellHeight,
    walkableRadiusVoxels,
    walkableRadiusWorld,
    walkableClimbVoxels,
    walkableClimbWorld,
    walkableHeightVoxels,
    walkableHeightWorld,
    walkableSlopeAngleDegrees,
    borderSize,
    minRegionArea,
    mergeRegionArea,
    maxSimplificationError,
    maxEdgeLength,
    maxVerticesPerPoly,
    detailSampleDistance,
    detailSampleMaxError,
  } = options;

  /* 2. mark walkable triangles */

  BuildContext.start(ctx, "mark walkable triangles");

  const triAreaIds = new Uint8Array(indices.length / 3).fill(0);
  markWalkableTriangles(
    positions,
    indices,
    triAreaIds,
    walkableSlopeAngleDegrees,
  );

  BuildContext.end(ctx, "mark walkable triangles");

  /* 3. rasterize the triangles to a voxel heightfield */

  BuildContext.start(ctx, "rasterize triangles");

  const bounds = calculateMeshBounds(box3.create(), positions, indices);
  const [heightfieldWidth, heightfieldHeight] = calculateGridSize(
    vec2.create(),
    bounds,
    cellSize,
  );

  const heightfield = createHeightfield(
    heightfieldWidth,
    heightfieldHeight,
    bounds,
    cellSize,
    cellHeight,
  );

  rasterizeTriangles(
    ctx,
    heightfield,
    positions,
    indices,
    triAreaIds,
    walkableClimbVoxels,
  );

  BuildContext.end(ctx, "rasterize triangles");

  // rasterizing volumes to the heightfield

  BuildContext.start(ctx, "rasterize volumes");

  for (const nullVolume of nullVolumes)
    rasterizeThreeGeometry(heightfield, nullVolume, NULL_AREA, 1, ctx);

  for (const walkableVolume of walkableVolumes)
    rasterizeThreeGeometry(
      heightfield,
      walkableVolume,
      WALKABLE_AREA,
      1,
      ctx,
    );

  BuildContext.end(ctx, "rasterize volumes");

  /* 4. filter walkable surfaces */

  BuildContext.start(ctx, "filter walkable surfaces");

  filterLowHangingWalkableObstacles(heightfield, walkableClimbVoxels);
  filterLedgeSpans(heightfield, walkableHeightVoxels, walkableClimbVoxels);
  filterWalkableLowHeightSpans(heightfield, walkableHeightVoxels);

  BuildContext.end(ctx, "filter walkable surfaces");

  /* 5. compact the heightfield */

  BuildContext.start(ctx, "build compact heightfield");

  const compactHeightfield = buildCompactHeightfield(
    ctx,
    walkableHeightVoxels,
    walkableClimbVoxels,
    heightfield,
  );

  BuildContext.end(ctx, "build compact heightfield");

  /* 6. erode the walkable area by the agent radius / walkable radius */

  BuildContext.start(ctx, "erode walkable area");

  erodeWalkableArea(walkableRadiusVoxels, compactHeightfield);

  BuildContext.end(ctx, "erode walkable area");

  /* 7. prepare for region partitioning by calculating a distance field along the walkable surface */

  BuildContext.start(ctx, "build compact heightfield distance field");

  buildDistanceField(compactHeightfield);

  BuildContext.end(ctx, "build compact heightfield distance field");

  /* 8. partition the walkable surface into simple regions without holes */

  BuildContext.start(ctx, "build compact heightfield regions");

  buildRegions(
    ctx,
    compactHeightfield,
    borderSize,
    minRegionArea,
    mergeRegionArea,
  );

  BuildContext.end(ctx, "build compact heightfield regions");

  /* 9. trace and simplify region contours */

  BuildContext.start(ctx, "trace and simplify region contours");

  const contourSet = buildContours(
    ctx,
    compactHeightfield,
    maxSimplificationError,
    maxEdgeLength,
    ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
  );

  BuildContext.end(ctx, "trace and simplify region contours");

  /* 10. build polygons mesh from contours */

  BuildContext.start(ctx, "build polygons mesh from contours");

  const polyMesh = buildPolyMesh(ctx, contourSet, maxVerticesPerPoly);

  for (let polyIndex = 0; polyIndex < polyMesh.nPolys; polyIndex++) {
    if (polyMesh.areas[polyIndex] === WALKABLE_AREA) {
      polyMesh.areas[polyIndex] = 0;
    }

    if (polyMesh.areas[polyIndex] === 0) {
      polyMesh.flags[polyIndex] = 1;
    }
  }

  BuildContext.end(ctx, "build polygons mesh from contours");

  /* 11. create detail mesh which allows to access approximate height on each polygon */

  BuildContext.start(ctx, "build detail mesh from contours");

  const polyMeshDetail = buildPolyMeshDetail(
    ctx,
    polyMesh,
    compactHeightfield,
    detailSampleDistance,
    detailSampleMaxError,
  );

  BuildContext.end(ctx, "build detail mesh from contours");

  BuildContext.end(ctx, "navmesh generation");

  /* store intermediates for debugging */

  const intermediates: SoloNavMeshIntermediates = {
    buildContext: ctx,
    input: {
      positions,
      indices,
    },
    triAreaIds,
    heightfield,
    compactHeightfield,
    contourSet,
    polyMesh,
    polyMeshDetail,
  };

  /* create a single tile nav mesh */

  const nav = createNavMesh();
  nav.tileWidth = polyMesh.bounds[3] - polyMesh.bounds[0];
  nav.tileHeight = polyMesh.bounds[5] - polyMesh.bounds[2];
  box3.min(nav.origin, polyMesh.bounds);

  const tilePolys = polyMeshToTilePolys(polyMesh);

  const tileDetailMesh = polyMeshDetailToTileDetailMesh(
    tilePolys.polys,
    polyMeshDetail,
  );

  const tileParams: NavMeshTileParams = {
    bounds: polyMesh.bounds,
    vertices: tilePolys.vertices,
    polys: tilePolys.polys,
    detailMeshes: tileDetailMesh.detailMeshes,
    detailVertices: tileDetailMesh.detailVertices,
    detailTriangles: tileDetailMesh.detailTriangles,
    tileX: 0,
    tileY: 0,
    tileLayer: 0,
    cellSize,
    cellHeight,
    walkableHeight: walkableHeightWorld,
    walkableRadius: walkableRadiusWorld,
    walkableClimb: walkableClimbWorld,
  };

  const tile = buildTile(tileParams);

  addTile(nav, tile);

  return {
    navMesh: nav,
    intermediates,
  };
}

function generate() {
  /* clear helpers */
  clearDebugHelpers();

  /* generate navmesh */
  const walkableMeshes: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && !isExcluded(object)) {
      walkableMeshes.push(object);
    }
  });

  const [positions, indices] = getPositionsAndIndices(walkableMeshes);

  const navMeshInput: SoloNavMeshInput = {
    positions,
    indices,
  };

  const walkableRadiusVoxels = Math.ceil(
    config.walkableRadiusWorld / config.cellSize,
  );
  const walkableClimbVoxels = Math.ceil(
    config.walkableClimbWorld / config.cellHeight,
  );
  const walkableHeightVoxels = Math.ceil(
    config.walkableHeightWorld / config.cellHeight,
  );

  const detailSampleDistance =
    config.detailSampleDistance < 0.9
      ? 0
      : config.cellSize * config.detailSampleDistance;
  const detailSampleMaxError = config.cellHeight * config.detailSampleMaxError;

  const navMeshConfig: SoloNavMeshOptions = {
    cellSize: config.cellSize,
    cellHeight: config.cellHeight,
    walkableRadiusWorld: config.walkableRadiusWorld,
    walkableRadiusVoxels,
    walkableClimbWorld: config.walkableClimbWorld,
    walkableClimbVoxels,
    walkableHeightWorld: config.walkableHeightWorld,
    walkableHeightVoxels,
    walkableSlopeAngleDegrees: config.walkableSlopeAngleDegrees,
    borderSize: config.borderSize,
    minRegionArea: config.minRegionArea,
    mergeRegionArea: config.mergeRegionArea,
    maxSimplificationError: config.maxSimplificationError,
    maxEdgeLength: config.maxEdgeLength,
    maxVerticesPerPoly: config.maxVerticesPerPoly,
    detailSampleDistance,
    detailSampleMaxError,
  };

  console.time("generateSoloNavMesh");

  result = generateSoloNavMeshWithVolumes(navMeshInput, navMeshConfig);

  console.timeEnd("generateSoloNavMesh");

  console.log(result);

  /* update helpers */
  updateDebugHelpers();
}

gui.add({ generate }, "generate").name("Generate NavMesh");

// generate initial navmesh
generate();

/* start loop */
function update() {
  requestAnimationFrame(update);

  orbitControls.update();
  renderer.render(scene, camera);
}

update();
