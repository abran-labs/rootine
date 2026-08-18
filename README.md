# Rootine

Linux-only privileged-command layer for AI agents. Two argv-only wrappers:

- `px` — always asks: polkit approval dialog per command (cached ~5 min)
- `sx` — never asks: silent root via a managed sudoers NOPASSWD entry

No plugin APIs, no password storage, no custom dialogs.

## Install

```sh
bun add -g rootine     # or: bunx rootine
rootine setup          # interactive: mode, wrappers, agent prompts
```

`bun add -g` auto-starts the interactive setup after install (postinstall). Skip it with
`ROOTINE_SKIP_ONBOARD=1` — useful for scripts and `bunx`.

Requires: Linux, polkit (`polkitd` + a session agent), sudo. Missing polkit → setup prints
the distro install command.

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
`/etc/sudoers.d/10-rootine` (staged, `visudo -cf` validated, installed through one dialog).
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

## Development

```sh
bun run check   # typecheck + build
bun test
```
