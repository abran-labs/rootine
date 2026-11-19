import type { Mode } from "./config"
import type { Platform } from "./deps"

export const DIALOG_WRAPPER = "px"
export const SILENT_WRAPPER = "sx"
export const SILENT_HELPER = "/usr/local/libexec/rootine-sx"
export const SUDOERS_FILE = "/etc/sudoers.d/10-rootine"
export const PROMPT_MARKER_START = "<!-- PX_START -->"
export const PROMPT_MARKER_END = "<!-- PX_END -->"

export const OSASCRIPT = "/usr/bin/osascript"

export function dialogWrapperScript(platform: Platform = "linux", osascript = OSASCRIPT): string {
  return platform === "darwin" ? macDialogWrapperScript(osascript) : linuxDialogWrapperScript()
}

function linuxDialogWrapperScript(): string {
  return `#!/bin/sh
# px — argv-only privileged runner that always asks (managed by rootine).
# The polkit approval dialog is the user's approval; no password passes through here.
# Usage: px EXECUTABLE [ARG...]  (no shell strings, no pipes, no redirection)
if [ $# -lt 1 ]; then
  echo "usage: px EXECUTABLE [ARG...]" >&2
  exit 2
fi
exec pkexec --disable-internal-agent "$@"
`
}

// macOS has no pkexec: the native administrator dialog (osascript) approves each call.
// do shell script takes a shell string, so argv is single-quoted here and the
// script reaches AppleScript as an argument, never spliced into AppleScript source.
function macDialogWrapperScript(osascript: string): string {
  return String.raw`#!/bin/sh
# px — argv-only privileged runner that always asks (managed by rootine).
# The macOS administrator dialog is the user's approval; no password passes through here.
# Usage: px EXECUTABLE [ARG...]  (no shell strings, no pipes, no redirection)
if [ $# -lt 1 ]; then
  echo "usage: px EXECUTABLE [ARG...]" >&2
  exit 2
fi
quote() {
  printf '%s\n' "$1" | sed "s/'/'\\\\''/g; 1s/^/'/; \$s/\$/'/"
}
command=
for arg do command="$command $(quote "$arg")"; done
base=$TMPDIR
[ -n "$base" ] || base=/tmp
tmp=$(mktemp -d "$base/rootine-px.XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
script="$command </dev/null >$(quote "$tmp/out") 2>$(quote "$tmp/err"); echo \$? >$(quote "$tmp/status")"
if ! ${osascript} -e 'on run argv' -e 'do shell script (item 1 of argv) with administrator privileges' -e 'end run' "$script" >/dev/null; then
  echo "px: administrator approval was cancelled or denied" >&2
  exit 126
fi
cat "$tmp/out"
cat "$tmp/err" >&2
status=$(cat "$tmp/status" 2>/dev/null)
[ -n "$status" ] || status=1
exit "$status"
`
}

export function silentWrapperScript(helper = SILENT_HELPER): string {
  return `#!/bin/sh
# sx — argv-only privileged runner that never asks (managed by rootine).
# Silent because of the rootine sudoers entry; there is NO approval dialog.
# Usage: sx EXECUTABLE [ARG...]  (no shell strings, no pipes, no redirection)
if [ $# -lt 1 ]; then
  echo "usage: sx EXECUTABLE [ARG...]" >&2
  exit 2
fi
exec sudo -- ${helper} "$@"
`
}

export function silentHelperScript(): string {
  return `#!/bin/sh
# Root-owned executor for sx (managed by rootine).
if [ $# -lt 1 ]; then
  echo "usage: rootine-sx EXECUTABLE [ARG...]" >&2
  exit 2
fi
exec "$@"
`
}

export function sudoersLine(username: string, helper = SILENT_HELPER): string {
  return `${username} ALL=(root) NOPASSWD: ${helper} *\n`
}

export function sudoersFileSource(username: string, helper = SILENT_HELPER): string {
  return `# Managed by rootine; regenerate with \`rootine setup\`.\n${sudoersLine(username, helper)}`
}

export function agentPrompt(mode: Mode, platform: Platform = "linux"): string {
  const rules = [
    "never raw `sudo` or raw `pkexec`",
    "never shell strings, pipes, or redirection",
    "never secrets in args",
  ]
  const common = rules.map((rule) => `- Run privileged commands ONLY via the rootine wrappers: ${rule}.`).join("\n")
  const modeText = promptForMode(mode, platform === "darwin" ? MAC_DIALOG : LINUX_DIALOG)
  return `${PROMPT_MARKER_START}

# Privileged commands (rootine)

${common}
${modeText}
${PROMPT_MARKER_END}
`
}

type DialogText = { readonly ask: string; readonly missing: string }

const LINUX_DIALOG: DialogText = {
  ask: "every privileged command shows a polkit approval dialog the user must approve (first approval cached ~5 minutes)",
  missing: "- No dialog = no polkit agent in this session; stop and tell the user instead of guessing.",
}

const MAC_DIALOG: DialogText = {
  ask: "every privileged command shows the macOS administrator dialog the user must approve; px passes no stdin and runs with a minimal PATH, so use absolute executable paths",
  missing: "- No dialog = no logged-in macOS GUI session (e.g. SSH); stop and tell the user instead of guessing.",
}

function promptForMode(mode: Mode, dialog: DialogText): string {
  switch (mode) {
    case "always-allow":
      return "- Use `sx <exe> [args...]` for everything — no dialog will appear, every call runs as root immediately. The user trusts you with root; use it deliberately."
    case "review":
      return [
        "- Use `sx <exe> [args...]` when the operation is routine and safe: status checks, reading logs, non-destructive inspection. No dialog appears.",
        "- Use `px <exe> [args...]` when the operation is sensitive or destructive — installs, service changes, deletions, firewall/network changes, anything user-visible — so the user must approve the dialog.",
        "- When unsure, use `px`.",
        dialog.missing,
      ].join("\n")
    case "always-ask":
      return `- Use \`px <exe> [args...]\`: ${dialog.ask}.\n${dialog.missing}`
  }
}
