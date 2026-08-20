![Rootine banner showing a root shell hash beside the product name](.github/assets/rootine-banner.svg)

# Rootine

## Install

```sh
curl -fsSL https://github.com/abran-labs/rootine/raw/main/install.sh | bash
```

## Approval modes

| Mode | Behavior |
| --- | --- |
| `review` | Agent decides to run privileged command immediately or to requires approval. |
| `always-ask` | Every privileged command requires approval. |
| `always-allow` | Every privileged command runs immediately. |

## Commands

```sh
rootine setup       # configure approval mode
rootine doctor      # inspect installation
rootine uninstall   # remove configuration
```
