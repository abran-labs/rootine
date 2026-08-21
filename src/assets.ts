import type { Mode } from "./config"

export const DIALOG_WRAPPER = "px"
export const SILENT_WRAPPER = "sx"
export const SILENT_HELPER = "/usr/local/libexec/rootine-sx"
export const SUDOERS_FILE = "/etc/sudoers.d/10-rootine"
export const PROMPT_MARKER_START = "<!-- PX_START -->"
export const PROMPT_MARKER_END = "<!-- PX_END -->"

export function dialogWrapperScript(): string {
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

export function agentPrompt(mode: Mode): string {
  const rules = [
    "never raw `sudo` or raw `pkexec`",
    "never shell strings, pipes, or redirection",
    "never secrets in args",
  ]
  const common = rules.map((rule) => `- Run privileged commands ONLY via the rootine wrappers: ${rule}.`).join("\n")
  const modeText = promptForMode(mode)
  return `${PROMPT_MARKER_START}

# Privileged commands (rootine)

${common}
${modeText}
${PROMPT_MARKER_END}
`
}

function promptForMode(mode: Mode): string {
  switch (mode) {
    case "always-allow":
      return "- Use `sx <exe> [args...]` for everything — no dialog will appear, every call runs as root immediately. The user trusts you with root; use it deliberately."
    case "review":
      return [
        "- Use `sx <exe> [args...]` when the operation is routine and safe: status checks, reading logs, non-destructive inspection. No dialog appears.",
        "- Use `px <exe> [args...]` when the operation is sensitive or destructive — installs, service changes, deletions, firewall/network changes, anything user-visible — so the user must approve the polkit dialog.",
        "- When unsure, use `px`.",
        "- No dialog = no polkit agent in this session; stop and tell the user instead of guessing.",
      ].join("\n")
    case "always-ask":
      return "- Use `px <exe> [args...]`: every privileged command shows a polkit approval dialog the user must approve (first approval cached ~5 minutes).\n- No dialog = no polkit agent in this session; stop and tell the user instead of guessing."
  }
}
