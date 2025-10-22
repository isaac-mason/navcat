# CONTRIBUTING

- To make changes to `README.md`, edit `docs/README.template.md` and run `npm run docs` to rebuild `README.md`.
- If creating PRs adding new functionality, please keep the PR focused on a single feature or fix, and add examples where applicable.
- A split between "core" functionality and "abstractions built on core" has been established with `navcat` and the `navcat/blocks` entrypoint. When adding new functionality, consider whether it belongs in `navcat` (low level building blocks) or `navcat/blocks` (higher level apis and presets built on top of `navcat`).
