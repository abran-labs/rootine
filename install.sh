#!/bin/sh
# Rootine installer: downloads the compiled binary for this platform, verifies
# its checksum, installs it to ~/.local/bin/rootine, and starts the setup.
set -eu

ROOTINE_VERSION=${ROOTINE_VERSION:-v0.1.3}
BASE_URL=${ROOTINE_BASE_URL:-https://github.com/abran-labs/rootine/releases/download}
if [ "$(uname -s)" != Linux ]; then
  echo "rootine: Linux is required" >&2
  exit 1
fi
ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
case "$ARCH" in
  x64|arm64) ;;
  *) echo "rootine: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
BIN=rootine-linux-$ARCH
TARGET="$HOME/.local/bin/rootine"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/rootine-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

curl -fsSL "$BASE_URL/$ROOTINE_VERSION/$BIN" -o "$tmp/$BIN"
curl -fsSL "$BASE_URL/$ROOTINE_VERSION/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && grep " $BIN\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1) || {
  echo "rootine: checksum verification failed for $ROOTINE_VERSION/$BIN" >&2
  exit 1
}

mkdir -p "$HOME/.local/bin"
install -m 0755 "$tmp/$BIN" "$TARGET"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "rootine: add $HOME/.local/bin to your PATH" >&2 ;;
esac

echo "rootine $ROOTINE_VERSION installed"
if [ "${ROOTINE_NO_ONBOARD:-0}" = 1 ]; then
  echo "rootine: run \`rootine setup\` to finish onboarding"
  exit 0
fi
if [ -r /dev/tty ]; then
  exec "$TARGET" setup </dev/tty
fi
exec "$TARGET" setup
