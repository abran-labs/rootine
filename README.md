# Rootine

Linux-only thin wrapper around polkit. Install it, pick a mode, and every AI agent on the
machine gets one tiny privileged-command path: `px <exe> [args...]`.

No plugin APIs, no password storage, no custom dialogs. The polkit approval dialog is the
approval boundary; polkit keeps the authorization in memory for ~5 minutes after the first
approval.

## Install

```sh
bun add -g rootine     # or: bunx rootine
rootine setup          # interactive: picks the mode, installs px, writes agent prompts
```

`rootine setup` requires:

- Linux
- polkit installed and `polkitd` running
- a polkit authentication agent in the desktop session (the dialog)

If polkit is missing, setup prints the package-manager command for your distro. Install it,
start the agent (your desktop environment's), then rerun.

## Modes

| Mode | Dialog behavior |
| --- | --- |
| `always-allow` | none — every `px` call runs as root immediately (polkit rule: YES) |
| `review` | allowlisted programs run without a dialog; everything else asks (polkit rule: YES for exact program paths) |
| `always-ask` | every privileged command asks (default polkit behavior, ~5 min cache) |

Modes are enforced by polkit itself, not by the wrapper: the mode writes a polkit rule to
`/etc/polkit-1/rules.d/10-rootine.rules` (installed through one approval dialog). The wrapper
never changes:

```sh
#!/bin/sh
if [ $# -lt 1 ]; then echo "usage: px EXECUTABLE [ARG...]" >&2; exit 2; fi
exec pkexec --disable-internal-agent "$@"
```

`--disable-internal-agent` forces the session agent: with no desktop agent, `px` fails loudly
instead of falling back to a text prompt.

## What setup writes

| Path | Purpose |
| --- | --- |
| `~/.local/bin/px` | the wrapper |
| `~/.config/rootine/config.json` | mode + allowlist |
| `/etc/polkit-1/rules.d/10-rootine.rules` | polkit rule for `always-allow` / `review` (absent for `always-ask`) |
| `~/.config/opencode/AGENTS.md` | prompt section for OpenCode (replaced between `<!-- PX_START -->` / `<!-- PX_END -->`) |
| `~/.claude/CLAUDE.md` | prompt section for Claude Code |

The prompt section tells the agent: privileged commands only via `px`, never `sudo` or raw
`pkexec`, never shell strings, pipes, or redirection, never secrets in args.

## Commands

```sh
rootine setup [--mode always-allow|review|always-ask] [--allowlist PATH,...] [--yes]
rootine doctor
rootine uninstall [--yes]
```

`rootine uninstall` removes the wrapper, the polkit rule, the prompt sections, and the config.

## Development

```sh
bun run check   # typecheck + build
bun test
```
