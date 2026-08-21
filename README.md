![Rootine banner showing a root shell hash beside the product name](.github/assets/rootine-banner.svg)

# Rootine

**Privileged commands for coding agents.**

## Install

```sh
curl -fsSL https://github.com/abran-labs/rootine/raw/master/install.sh | bash
```

## Approval modes

| Mode | Behavior |
| --- | --- |
| `review` | Agent decides whether a privileged command runs immediately or requires approval. |
| `always-ask` | Every privileged command requires approval. |
| `always-allow` | Every privileged command runs immediately. |

## Commands

```sh
rootine setup       # configure approval mode
rootine doctor      # inspect installation
rootine uninstall   # remove Rootine
```
