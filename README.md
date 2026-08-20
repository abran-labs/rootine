# Rootine

Linux-only privileged-command layer for AI agents. Two argv-only wrappers:

- `px` — always asks: polkit approval dialog per command (cached ~5 min)
- `sx` — never asks: silent root via a managed sudoers NOPASSWD entry

No plugin APIs, no password storage, no custom dialogs.

## Install

```sh
curl -fsSL https://github.com/abran-labs/rootine/raw/main/install.sh | bash
```

One command: downloads the compiled binary for your architecture (x64/arm64), verifies
its checksum, installs to `~/.local/bin/rootine`, and starts the interactive setup.
`ROOTINE_VERSION=v0.1.0` pins a release; `ROOTINE_NO_ONBOARD=1` skips the auto-started setup.

Requires: Linux, polkit (`polkitd` + a session agent), sudo. Anything missing is
installed for you: setup runs the package-manager command through sudo in the same terminal
(inline password prompt), enables polkitd, installs a polkit agent matching your desktop, and
enables it — hyprpolkitagent via its systemd user unit (`systemctl --user enable --now
hyprpolkitagent.service`, persists across sessions and survives crashes), other agents started
detached. From install to fully configured, you never leave the terminal.

## Modes

| Mode | Behavior |
| --- | --- |
| `always-allow` | `sx` for everything — no dialog ever |
| `review` | agent decides: `sx` for routine safe commands, `px` (dialog) for sensitive ones |
| `always-ask` | `px` only — every privileged command asks |

The wrappers:

```sh
# px — always asks
exec pkexec --disable-internal-agent "$@"

# sx — never asks (needs the rootine sudoers entry)
exec sudo -- "$@"
```

`px` is gated by polkit itself. `sx` works because setup installs
`/etc/sudoers.d/10-rootine` (staged, `visudo -cf` validated, installed through terminal sudo).
In `review`, the sx/px choice is prompt compliance — the `px` dialog is the enforcement.

Setup also writes a prompt section (between `<!-- PX_START -->` / `<!-- PX_END -->`) into
`~/.config/opencode/AGENTS.md` and `~/.claude/CLAUDE.md`: wrappers only, never raw
`sudo`/`pkexec`, no shell strings, pipes, redirection, or secrets in args.

## Commands

```sh
rootine setup [--always-allow|--review|--always-ask] [--yes]
rootine doctor
rootine uninstall [--yes]
```

`rootine uninstall` removes the wrappers, the sudoers entry, the prompt sections, and the config.
The compiled binary itself is `~/.local/bin/rootine` — delete it after uninstalling.

## Development

```sh
bun run check   # typecheck + build
bun test
bun run release # compiles linux x64/arm64 binaries + SHA256SUMS into dist-bin/
```

Releasing: `bun run release`, then `gh release create v0.1.0 dist-bin/rootine-linux-x64
dist-bin/rootine-linux-arm64 dist-bin/SHA256SUMS`. install.sh fetches from that layout.
