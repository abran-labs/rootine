#!/bin/sh
# Builds the linux release binaries and checksum manifest.
set -eu
out=${1:-dist-bin}
mkdir -p "$out"
bun build --compile src/index.ts --target=bun-linux-x64 --outfile "$out/rootine-linux-x64"
bun build --compile src/index.ts --target=bun-linux-arm64 --outfile "$out/rootine-linux-arm64"
(cd "$out" && sha256sum rootine-linux-x64 rootine-linux-arm64 > SHA256SUMS)
echo "release artifacts in $out:"
ls -la "$out"
