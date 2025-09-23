# CHANGELOG

## 0.0.3 (Unreleased)

- Add `markCylinderArea` compact heightfield function for marking all spans within a cylinder area with a given area ID

## 0.0.2

- Moved `mergePositionsAndIndices` out of `import('navcat').three` to core / top level export
- Fix issues with `buildPolyMeshDetail` duplicating vertices when detailSampleDistance and detailSampleMaxError are set to add new samples to reduce error
- Use circumcircle implementation from maaths in poly mesh detail building logic

## 0.0.1

- Pre-alpha testing release. Use at your own risk!
