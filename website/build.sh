#!/bin/bash

# cd to script directory
cd "$(dirname "$0")"

# cleanup
rm -rf ./dist

# build typedoc
echo "Building API docs..."
(cd ../ && npm run typedoc)

# build examples
echo "Building Examples..."
(cd ../examples && npm run build)

# build website
echo "Building Website..."
npm run build

# copy typedoc to ./dist/docs
echo "Copying API docs..."
cp -r ../dist-typedoc ./dist/docs

# copy examples to ./dist/examples
echo "Copying Examples..."
cp -r ../examples/dist ./dist/examples

echo "Build complete! Output in ./dist"
