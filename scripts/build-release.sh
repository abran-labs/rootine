#!/bin/sh
# Builds the linux release binaries and checksum manifest.
set -eu
root=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd)
out=${1:-dist-bin}
case "$out" in /*) ;; *) out="$root/$out" ;; esac
version=$(sed -n 's/.*"packageManager": "bun@\([^"]*\)".*/\1/p' "$root/package.json")
cache=${XDG_CACHE_HOME:-$HOME/.cache}/rootine/bun-$version-linux-x64-baseline
compiler=$cache/bun

if [ ! -x "$compiler" ]; then
  archive=$(mktemp "${TMPDIR:-/tmp}/rootine-bun.XXXXXX.zip")
  unpack=$(mktemp -d "${TMPDIR:-/tmp}/rootine-bun.XXXXXX")
  trap 'rm -rf "$archive" "$unpack"' EXIT HUP INT TERM
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$version/bun-linux-x64-baseline.zip" -o "$archive"
  unzip -q "$archive" -d "$unpack"
  mkdir -p "$cache"
  install -m 0755 "$unpack/bun-linux-x64-baseline/bun" "$compiler"
fi

rm -rf "$out"
mkdir -p "$out"
(cd "$root" && "$compiler" build --compile src/index.ts --target=bun-linux-x64-baseline --outfile "$out/rootine-linux-x64")
(cd "$root" && "$compiler" build --compile src/index.ts --target=bun-linux-arm64 --outfile "$out/rootine-linux-arm64")
for binary in "$out/rootine-linux-x64" "$out/rootine-linux-arm64"; do
  required=$(readelf --version-info "$binary" | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1)
  if [ "$required" != GLIBC_2.17 ]; then
    echo "release: $binary unexpectedly requires $required" >&2
    exit 1
  fi
done
(cd "$out" && sha256sum rootine-linux-x64 rootine-linux-arm64 > SHA256SUMS)
echo "release artifacts in $out:"
ls -la "$out"
