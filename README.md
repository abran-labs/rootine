![Rootine banner showing a root shell hash beside the product name](https://raw.githubusercontent.com/abran-labs/rootine/main/.github/assets/rootine-banner.svg)

# Rootine

[![release](https://img.shields.io/github/v/release/abran-labs/rootine)](https://github.com/abran-labs/rootine/releases/latest)
![platform](https://img.shields.io/badge/platform-Linux-91b86f)
[![license](https://img.shields.io/github/license/abran-labs/rootine)](LICENSE)

**Predictable root access for AI coding agents.**

## Install

```sh
curl -fsSL https://github.com/abran-labs/rootine/raw/main/install.sh | bash
```

The installer verifies and installs the Linux x64 or arm64 binary, then starts
setup. Setup handles missing polkit components and configures OpenCode and
Claude Code.

## Approval modes

| Mode | Behavior |
| --- | --- |
| `review` | Recommended. Silent access for routine work; approval for sensitive work. |
| `always-ask` | Every privileged command requires approval. |
| `always-allow` | Every privileged command runs immediately. |

## Commands

```sh
rootine setup       # configure approval mode
rootine doctor      # inspect installation
rootine uninstall   # remove configuration
```

Rootine installs two argv-only wrappers: `px` for polkit approval and `sx` for
managed passwordless sudo. It stores no passwords.
