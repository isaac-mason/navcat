- api naming consistency
  - polyRef
  - polyNodeRef
  - nodeRef
  - ref
  - probably should all just become nodeRef?

- queryPolygons and queryPolygonsInTile should have the same interface?

- zero alloc for all apis? just some?

- zero alloc for pathfinding? what is perf implication?

- some vec3something2d functions just be 2d math utils?

- pass buildContext to _ALL_ build api fns, even if unused to start

- examples to add:
  - dynamic generation - maybe a physics fps showcase?

- crowd agent obstacle avoidance fixes
