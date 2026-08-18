import type { Mode, RootineConfig } from "./config"

export const WRAPPER_NAME = "px"
export const RULE_FILE = "/etc/polkit-1/rules.d/10-rootine.rules"
export const PROMPT_MARKER_START = "<!-- PX_START -->"
export const PROMPT_MARKER_END = "<!-- PX_END -->"

export function wrapperScript(): string {
  return `#!/bin/sh
# px — argv-only privileged runner via pkexec (managed by rootine).
# The polkit dialog is the user's approval; no password passes through here.
# Usage: px EXECUTABLE [ARG...]  (no shell strings, no pipes, no redirection)
if [ $# -lt 1 ]; then
  echo "usage: px EXECUTABLE [ARG...]" >&2
  exit 2
fi
exec pkexec --disable-internal-agent "$@"
`
}

export function polkitRuleSource(config: RootineConfig, username: string): string | undefined {
  if (config.mode === "always-ask") return undefined
  const allowlist = config.mode === "review" ? `[${config.allowlist.map((program) => JSON.stringify(program)).join(", ")}]` : undefined
  const body = allowlist === undefined
    ? `  if (action.id !== "org.freedesktop.policykit.exec") return;\n  if (subject.user !== ${JSON.stringify(username)}) return;\n  return polkit.Result.YES;`
    : `  if (action.id !== "org.freedesktop.policykit.exec") return;\n  if (subject.user !== ${JSON.stringify(username)}) return;\n  var allowlist = ${allowlist};\n  if (allowlist.indexOf(action.lookup("program")) === -1) return;\n  return polkit.Result.YES;`
  return `// Managed by rootine; regenerate with \`rootine setup\`.\npolkit.addRule(function (action, subject) {\n${body}\n});\n`
}

export function agentPrompt(mode: Mode, allowlist: readonly string[]): string {
  const rules = [
    "never `sudo` or raw `pkexec`",
    "never shell strings, pipes, or redirection",
    "never secrets in args",
  ]
  const common = rules.map((rule) => `- Run privileged commands ONLY via \`px <exe> [args...]\`: ${rule}.`).join("\n")
  const modeText = promptForMode(mode, allowlist)
  return `${PROMPT_MARKER_START}

# Privileged commands (px)

${common}
${modeText}
${PROMPT_MARKER_END}
`
}

function promptForMode(mode: Mode, allowlist: readonly string[]): string {
  switch (mode) {
    case "always-allow":
      return "- No approval dialog will appear: every `px` call runs as root immediately. The user trusts you with root; use it deliberately."
    case "review":
      return `- Programs in the always-allow list run without a dialog: ${allowlist.length === 0 ? "(none)" : allowlist.join(", ")}\n- All other programs show a polkit approval dialog the user must approve (first approval cached ~5 minutes).\n- No dialog = no polkit agent in this session; stop and tell the user instead of guessing.`
    case "always-ask":
      return "- Every privileged command shows a polkit approval dialog the user must approve (first approval cached ~5 minutes).\n- No dialog = no polkit agent in this session; stop and tell the user instead of guessing."
  }
}
