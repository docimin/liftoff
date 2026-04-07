#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
OUTDIR="dist"

rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

TARGETS=(
  "bun-linux-x64"
  "bun-linux-arm64"
  "bun-windows-x64"
  "bun-darwin-x64"
  "bun-darwin-arm64"
)

for target in "${TARGETS[@]}"; do
  os_arch="${target#bun-}"  # e.g. linux-x64
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
