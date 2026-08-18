# Rootine

Linux-only thin privileged-command layer for AI agents. Install it, pick a mode, and every
agent on the machine gets two tiny argv-only wrappers:

- `px` — always asks: polkit approval dialog per command (cached ~5 minutes)
- `sx` — never asks: silent root via a managed sudoers NOPASSWD entry

No plugin APIs, no password storage, no custom dialogs. The polkit dialog (or its absence)
is the approval boundary.

## Install

```sh
bun add -g rootine     # or: bunx rootine
rootine setup          # interactive: picks the mode, installs wrappers, writes agent prompts
```

`rootine setup` requires:

- Linux
- polkit installed and `polkitd` running
- a polkit authentication agent in the desktop session (the dialog)
- sudo (for modes that install the silent wrapper)

If polkit is missing, setup prints the package-manager command for your distro. Install it,
start the agent (your desktop environment's), then rerun.

## Modes

| Mode | Behavior |
| --- | --- |
| `always-allow` | `sx` for everything — no dialog ever (sudoers NOPASSWD) |
| `review` | prompt decides: `sx` for routine safe commands, `px` (dialog) for sensitive ones |
| `always-ask` | `px` only — every privileged command asks (default polkit, ~5 min cache) |

Modes are enforced where it matters: `px` is gated by polkit itself, and `sx` only works
because setup installs `/etc/sudoers.d/10-rootine` (staged, `visudo -cf` validated, then
installed through one approval dialog). In `review` mode the sx/px choice is prompt
compliance — the dialog on `px` is the enforcement for sensitive operations.

The wrappers never change:

```sh
# px — always asks
if [ $# -lt 1 ]; then echo "usage: px EXECUTABLE [ARG...]" >&2; exit 2; fi
exec pkexec --disable-internal-agent "$@"

# sx — never asks (requires the rootine sudoers entry)
if [ $# -lt 1 ]; then echo "usage: sx EXECUTABLE [ARG...]" >&2; exit 2; fi
exec sudo -- "$@"
```

`--disable-internal-agent` forces the session agent: with no desktop agent, `px` fails loudly
instead of falling back to a text prompt.

## What setup writes

| Path | Purpose |
| --- | --- |
| `~/.local/bin/px` | dialog wrapper (polkit) |
| `~/.local/bin/sx` | silent wrapper (sudo; review and always-allow only) |
| `~/.config/rootine/config.json` | mode |
| `/etc/sudoers.d/10-rootine` | NOPASSWD entry (review and always-allow only) |
| `~/.config/opencode/AGENTS.md` | prompt section for OpenCode (replaced between `<!-- PX_START -->` / `<!-- PX_END -->`) |
| `~/.claude/CLAUDE.md` | prompt section for Claude Code |

The prompt section tells the agent: privileged commands only via the wrappers, never raw
`sudo` or raw `pkexec`, never shell strings, pipes, or redirection, never secrets in args.

## Commands

```sh
rootine setup [--mode always-allow|review|always-ask] [--yes]
rootine doctor
rootine uninstall [--yes]
```

`rootine uninstall` removes the wrappers, the sudoers entry, the prompt sections, and the config.

## Development

```sh
bun run check   # typecheck + build
bun test
```
