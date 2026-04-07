#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
OUTDIR="dist"

rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

# Stub out react-devtools-core — ink imports it but it's dev-only and not published
mkdir -p node_modules/react-devtools-core
echo "module.exports = { connectToDevTools: () => {} };" > node_modules/react-devtools-core/index.js

# Use baseline targets for linux/windows to avoid AVX2 requirement
# (many VPS/cloud servers have older CPUs that don't support AVX2)
TARGETS=(
  "bun-linux-x64-baseline"
  "bun-linux-arm64"
  "bun-windows-x64-baseline"
  "bun-darwin-x64"
  "bun-darwin-arm64"
)

for target in "${TARGETS[@]}"; do
  # Strip "bun-" prefix and "-baseline" suffix for the output name
  os_arch="${target#bun-}"
  os_arch="${os_arch%-baseline}"
  outname="liftoff-${os_arch}"

  if [[ "$target" == *"windows"* ]]; then
    outname="${outname}.exe"
  fi

  echo "Building $outname ($target)..."
  bun build --compile --target="$target" src/index.ts --outfile "$OUTDIR/$outname"
done

# Create checksums
cd "$OUTDIR"
shasum -a 256 liftoff-* > checksums.txt
cd ..

echo ""
echo "Built v${VERSION}:"
ls -lh "$OUTDIR"/liftoff-*
echo ""
cat "$OUTDIR/checksums.txt"
