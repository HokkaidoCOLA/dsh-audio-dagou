#!/bin/bash
# Build: compile src/ → lib/ with the repo's own devDependencies.
#   npm install        (once)
#   npm run build      (tsc → lib/index.js + lib/types)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ]; then
  echo "build: node_modules missing — run 'npm install' first" >&2
  exit 1
fi

echo "=== Compiling src → lib (tsc) ==="
./node_modules/.bin/tsc -p tsconfig.json

echo "=== Build complete ==="
