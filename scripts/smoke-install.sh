#!/bin/sh
# Dev-only installer smoke test: builds a local release fixture, installs into
# a fake HOME via file://, verifies the binary runs, then verifies that a
# tampered binary is refused. Never touches the real home or network.
set -eu

root=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/rootine-install-smoke.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM

version=v0.1.0
fixture=$work/release/$version
mkdir -p "$fixture" "$work/home"
sh "$root/scripts/build-release.sh" "$work/release-artifacts" >/dev/null
cp "$work/release-artifacts/rootine-linux-x64" "$fixture/"
(cd "$fixture" && sha256sum rootine-linux-x64 > SHA256SUMS)

HOME="$work/home" ROOTINE_BASE_URL="file://$work/release" ROOTINE_NO_ONBOARD=1 sh "$root/install.sh"
HOME="$work/home" "$work/home/.local/bin/rootine" doctor >/dev/null

echo corrupted >> "$fixture/rootine-linux-x64"
if HOME="$work/home" ROOTINE_BASE_URL="file://$work/release" ROOTINE_NO_ONBOARD=1 sh "$root/install.sh"; then
  echo "smoke: tampered binary was accepted" >&2
  exit 1
fi

printf '%s\n' 'ROOTINE_INSTALL_SMOKE_OK'
