import { confirm, intro, outro, select, text } from "@clack/prompts"
import { wrapperScript } from "./assets"
import { MODES, type Mode } from "./config"
import { polkitInstallCommand, polkitProblems, probeDependencies } from "./deps"
import { defaultWrapperRun, readConfig, runSetup, runUninstall, type SetupResult } from "./install"
import { rootinePaths, type RootinePaths } from "./paths"

const HELP = `Usage:
  rootine setup [--mode always-allow|review|always-ask] [--allowlist PATH,...] [--yes]
  rootine doctor
  rootine uninstall [--yes]

Modes:
  always-allow  every px call runs as root, no dialog
  review        allowlisted programs run without a dialog, everything else asks
  always-ask    every privileged command asks (default polkit behavior)
`

type ParsedArgs =
  | { readonly kind: "help" }
  | { readonly kind: "setup"; readonly mode?: Mode; readonly allowlist: readonly string[]; readonly yes: boolean }
  | { readonly kind: "doctor" }
  | { readonly kind: "uninstall"; readonly yes: boolean }

export async function main(args: readonly string[], environment: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const parsed = parseArgs(args)
  if (parsed.kind === "help") {
    console.log(HELP)
    return 0
  }
  const paths = rootinePaths(environment)
  if (parsed.kind === "doctor") return doctor(paths)
  if (parsed.kind === "uninstall") return uninstall(paths, parsed.yes)
  return setup(paths, parsed)
}

function parseArgs(args: readonly string[]): ParsedArgs {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { kind: "help" }
  const [command, ...rest] = args as readonly string[]
  if (command === "doctor") return { kind: "doctor" }
  if (command === "uninstall") {
    const yes = rest.includes("--yes")
    if (rest.some((flag) => flag !== "--yes")) throw new RootineCliError("rootine uninstall accepts only --yes")
    return { kind: "uninstall", yes }
  }
  if (command !== "setup") throw new RootineCliError(`unknown command: ${command ?? ""}`)
  let mode: Mode | undefined
  let allowlist: readonly string[] = []
  const yes = rest.includes("--yes")
  for (const token of rest) {
    if (token === "--yes") continue
    if (token.startsWith("--mode")) {
      const value = flagValue(rest, token, "--mode")
      if (value === undefined || !MODES.includes(value as Mode)) throw new RootineCliError(`--mode must be one of ${MODES.join(", ")}`)
      mode = value as Mode
      continue
    }
    if (token.startsWith("--allowlist")) {
      const value = flagValue(rest, token, "--allowlist")
      allowlist = value === undefined || value === "" ? [] : value.split(",")
      for (const program of allowlist) if (!program.startsWith("/")) throw new RootineCliError("--allowlist entries must be absolute program paths")
      continue
    }
    throw new RootineCliError(`unknown flag: ${token}`)
  }
  return { kind: "setup", ...(mode === undefined ? {} : { mode }), allowlist, yes }
}

function flagValue(args: readonly string[], token: string, flag: string): string | undefined {
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
  const index = args.indexOf(token)
  const next = args[index + 1]
  if (next !== undefined && !next.startsWith("--")) return next
  return undefined
}

async function setup(paths: RootinePaths, parsed: Extract<ParsedArgs, { kind: "setup" }>): Promise<number> {
  const report = await probeDependencies()
  const problems = polkitProblems(report)
  if (problems.length > 0) {
    console.error(`rootine: ${problems.join("; ")}`)
    const install = polkitInstallCommand(report)
    if (install !== undefined) console.error(`Install polkit first, then rerun: ${install}`)
    return 1
  }
  const explicit = parsed.mode !== undefined && parsed.yes
  const mode = parsed.mode ?? await selectMode()
  if (mode === undefined) {
    console.log("Cancelled")
    return 0
  }
  const allowlist = parsed.allowlist.length > 0 || explicit
    ? parsed.allowlist
    : mode === "review"
      ? await askAllowlist()
      : []
  const result = explicit
    ? await runSetup({ mode, allowlist, paths, confirm: async (summary) => { printSummary(summary); return true }, run: defaultWrapperRun(), log: console.log })
    : await runInteractive(paths, mode, allowlist)
  return reportResult(result)
}

async function runInteractive(paths: RootinePaths, mode: Mode, allowlist: readonly string[]): Promise<SetupResult> {
  intro("rootine setup")
  const summaryPreview = [`mode: ${mode}${mode === "review" ? `, always-allow: ${allowlist.length === 0 ? "(none)" : allowlist.join(", ")}` : ""}`]
  const approved = await confirm({ message: `Apply this setup? ${summaryPreview.join("; ")}` })
  if (approved !== true) return { status: "cancelled", changes: [] }
  return runSetup({ mode, allowlist, paths, confirm: async () => true, run: defaultWrapperRun(), log: console.log })
}

async function selectMode(): Promise<Mode | undefined> {
  const answer = await select({
    message: "Choose the privileged-command mode",
    options: [
      { value: "always-allow", label: "always-allow — every px call runs as root, no dialog", hint: "yolo" },
      { value: "review", label: "review — allowlisted programs skip the dialog, everything else asks" },
      { value: "always-ask", label: "always-ask — every privileged command shows the approval dialog" },
    ],
  })
  return answer === "always-allow" || answer === "review" || answer === "always-ask" ? answer : undefined
}

async function askAllowlist(): Promise<readonly string[]> {
  const answer = await text({ message: "Always-allowed programs (comma-separated absolute paths, empty = none)", placeholder: "/usr/bin/journalctl" })
  if (typeof answer !== "string") return []
  const entries = answer.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  for (const entry of entries) if (!entry.startsWith("/")) throw new RootineCliError("allowlist entries must be absolute program paths")
  return entries
}

async function doctor(paths: RootinePaths): Promise<number> {
  const report = await probeDependencies()
  const problems = polkitProblems(report)
  const config = await readConfig(paths.configFile)
  const wrapper = Bun.file(paths.wrapperFile)
  const wrapperOk = (await wrapper.exists()) && (await wrapper.text()) === wrapperScript()
  const rule = Bun.file(paths.ruleFile)
  const lines = [
    `platform: ${report.linux ? "linux" : "unsupported"}`,
    `pkexec: ${report.polkit.pkexec ?? "missing"}`,
    `polkitd: ${report.polkit.polkitd ? "running" : "not running"}`,
    `polkit agent: ${report.polkit.agent ? "detected" : "not detected"}`,
    `wrapper: ${wrapperOk ? `ready (${paths.wrapperFile})` : "missing or stale"}`,
    `config: ${config === undefined ? "missing" : `mode=${config.mode} allowlist=${config.allowlist.length === 0 ? "(none)" : config.allowlist.join(",")}`}`,
    `polkit rule: ${await rule.exists() ? "present" : "absent (default polkit behavior)"}`,
    `problems: ${problems.length === 0 ? "none" : problems.join("; ")}`,
  ]
  console.log(lines.join("\n"))
  return 0
}

async function uninstall(paths: RootinePaths, yes: boolean): Promise<number> {
  const approved = yes || await confirm({ message: "Remove the px wrapper, polkit rule, agent prompt sections, and rootine config?" }) === true
  if (!approved) return 0
  const result = await runUninstall({ paths, confirm: async () => true, run: defaultWrapperRun(), log: console.log })
  return reportResult(result)
}

function reportResult(result: SetupResult): number {
  if (result.status === "cancelled") {
    console.log("Cancelled")
    return 0
  }
  if (result.changes.length === 0) {
    console.log("No changes")
    return 0
  }
  for (const change of result.changes) console.log(change)
  outro("done")
  return 0
}

function printSummary(summary: readonly string[]): void {
  for (const line of summary) console.log(`  ${line}`)
}

export class RootineCliError extends Error {
  readonly name = "RootineCliError"
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`rootine: ${message}`)
      process.exitCode = 1
    },
  )
}
