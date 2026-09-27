#!/bin/sh
# Rootine installer: downloads the compiled binary for this platform, verifies
# its checksum, installs it to ~/.local/bin/rootine, and starts the setup.
set -eu

ROOTINE_VERSION=${ROOTINE_VERSION:-v0.1.5}
BASE_URL=${ROOTINE_BASE_URL:-https://github.com/abran-labs/rootine/releases/download}
printf 'rootine: preparing %s...\n' "$ROOTINE_VERSION" >&2
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

curl -fsSL "$BASE_URL/$ROOTINE_VERSION/SHA256SUMS" -o "$tmp/SHA256SUMS"
awk -v binary="$BIN" '
  NF == 0 { next }
  NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-fA-F]/ || $2 !~ /^[A-Za-z0-9_.-]+$/ { invalid = 1; next }
  seen[$2]++ { invalid = 1 }
  { print }
  END { if (invalid || seen[binary] != 1) exit 1 }
' "$tmp/SHA256SUMS" > "$tmp/verified" || {
  echo "rootine: invalid checksum manifest for $ROOTINE_VERSION" >&2
  exit 1
}
raw_hash=$(awk -v name="$BIN" '$2 == name { print $1 }' "$tmp/verified")
gzip_hash=$(awk -v name="$BIN.gz" '$2 == name { print $1 }' "$tmp/verified")

matches() {
  printf '%s  %s\n' "$1" "$2" | sha256sum -c - >/dev/null 2>&1
}

download() {
  if [ -t 2 ]; then
    curl -fSL --progress-bar "$BASE_URL/$ROOTINE_VERSION/$1" -o "$tmp/$1"
  else
    curl -fsSL "$BASE_URL/$ROOTINE_VERSION/$1" -o "$tmp/$1"
  fi
}

if [ -f "$TARGET" ] && [ -x "$TARGET" ] && matches "$raw_hash" "$TARGET"; then
  echo "rootine: using verified $ROOTINE_VERSION" >&2
else
  if [ -n "$gzip_hash" ]; then
    download "$BIN.gz"
    matches "$gzip_hash" "$tmp/$BIN.gz" || {
      echo "rootine: compressed checksum verification failed" >&2
      exit 1
    }
    gzip -dc "$tmp/$BIN.gz" > "$tmp/$BIN"
  else
    download "$BIN"
  fi
  matches "$raw_hash" "$tmp/$BIN" || {
    echo "rootine: checksum verification failed for $ROOTINE_VERSION/$BIN" >&2
    exit 1
  }
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$tmp/$BIN" "$TARGET"
fi

rm -rf "$tmp"
trap - EXIT HUP INT TERM

add_path() {
  if [ -f "$1" ] && grep -Fqx '# Rootine PATH' "$1"; then
    return
  fi
  cat >> "$1" <<'EOF'

# Rootine PATH
case ":${PATH:-}:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;
esac
EOF
  printf 'rootine: configured PATH in %s\n' "$1" >&2
}

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    shell_name=${SHELL:-}
    shell_name=${shell_name##*/}
    case "$shell_name" in
      bash)
        add_path "$HOME/.bashrc"
        profile="$HOME/.profile"
        for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
          if [ -f "$candidate" ] && [ -r "$candidate" ]; then
            profile=$candidate
            break
          fi
        done
        add_path "$profile"
        ;;
      zsh)
        mkdir -p "${ZDOTDIR:-$HOME}"
        add_path "${ZDOTDIR:-$HOME}/.zshrc"
        add_path "${ZDOTDIR:-$HOME}/.zprofile"
        ;;
      ''|sh|dash|ksh) add_path "$HOME/.profile" ;;
      *)
        printf 'rootine: automatic PATH configuration for %s is not supported; add ~/.local/bin using your shell configuration.\n' "$shell_name" >&2
        ;;
    esac
    export PATH="$HOME/.local/bin${PATH:+:$PATH}"
    echo 'rootine: current terminal PATH is unchanged; open a new shell or reconnect after configuring PATH.' >&2
    ;;
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
