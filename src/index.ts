import { confirm, intro, outro, select } from "@clack/prompts"
import { dialogWrapperScript, silentWrapperScript } from "./assets"
import { MODES, type Mode } from "./config"
import { polkitInstallCommand, polkitProblems, probeDependencies } from "./deps"
import { defaultWrapperRun, readConfig, runSetup, runUninstall, type SetupResult } from "./install"
import { rootinePaths, type RootinePaths } from "./paths"

const HELP = `Usage:
  rootine setup [--mode always-allow|review|always-ask] [--yes]
  rootine doctor
  rootine uninstall [--yes]

Modes:
  always-allow  py runs everything as root, no dialog ever
  review        py for routine safe commands, px (dialog) for sensitive ones
  always-ask    px only; every privileged command shows the approval dialog
`

type ParsedArgs =
  | { readonly kind: "help" }
  | { readonly kind: "setup"; readonly mode?: Mode; readonly yes: boolean }
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
  const yes = rest.includes("--yes")
  let index = 0
  while (index < rest.length) {
    const token = rest[index]
    if (token === undefined) break
    if (token === "--yes") {
      index += 1
      continue
    }
    if (token.startsWith("--mode")) {
      const value = flagValue(rest, token, "--mode")
      if (value === undefined || !MODES.includes(value as Mode)) throw new RootineCliError(`--mode must be one of ${MODES.join(", ")}`)
      mode = value as Mode
      index += token === "--mode" ? 2 : 1
      continue
    }
    throw new RootineCliError(`unknown flag: ${token}`)
  }
  return { kind: "setup", ...(mode === undefined ? {} : { mode }), yes }
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
  const result = explicit
    ? await runSetup({ mode, paths, confirm: async (summary) => { printSummary(summary); return true }, run: defaultWrapperRun(), log: console.log })
    : await runInteractive(paths, mode)
  return reportResult(result)
}

async function runInteractive(paths: RootinePaths, mode: Mode): Promise<SetupResult> {
  intro("rootine setup")
  const approved = await confirm({ message: `Apply this setup? mode: ${mode}` })
  if (approved !== true) return { status: "cancelled", changes: [] }
  return runSetup({ mode, paths, confirm: async () => true, run: defaultWrapperRun(), log: console.log })
}

async function selectMode(): Promise<Mode | undefined> {
  const answer = await select({
    message: "Choose the privileged-command mode",
    options: [
      { value: "always-allow", label: "always-allow — py runs everything as root, no dialog", hint: "yolo" },
      { value: "review", label: "review — py for routine safe commands, px (dialog) for sensitive ones" },
      { value: "always-ask", label: "always-ask — px only; every privileged command asks" },
    ],
  })
  return answer === "always-allow" || answer === "review" || answer === "always-ask" ? answer : undefined
}

async function doctor(paths: RootinePaths): Promise<number> {
  const report = await probeDependencies()
  const problems = polkitProblems(report)
  const config = await readConfig(paths.configFile)
  const dialogWrapper = Bun.file(paths.dialogWrapperFile)
  const silentWrapper = Bun.file(paths.silentWrapperFile)
  const dialogOk = (await dialogWrapper.exists()) && (await dialogWrapper.text()) === dialogWrapperScript()
  const silentOk = (await silentWrapper.exists()) && (await silentWrapper.text()) === silentWrapperScript()
  const sudoers = Bun.file(paths.sudoersFile)
  const lines = [
    `platform: ${report.linux ? "linux" : "unsupported"}`,
    `pkexec: ${report.polkit.pkexec ?? "missing"}`,
    `polkitd: ${report.polkit.polkitd ? "running" : "not running"}`,
    `polkit agent: ${report.polkit.agent ? "detected" : "not detected"}`,
    `sudo: ${report.sudo ?? "missing"}`,
    `wrapper px (dialog): ${dialogOk ? `ready (${paths.dialogWrapperFile})` : "missing or stale"}`,
    `wrapper py (silent): ${silentOk ? `ready (${paths.silentWrapperFile})` : await silentWrapper.exists() ? "stale" : "absent"}`,
    `config: ${config === undefined ? "missing" : `mode=${config.mode}`}`,
    `sudoers entry: ${await sudoers.exists() ? "present" : "absent"}`,
    `problems: ${problems.length === 0 ? "none" : problems.join("; ")}`,
  ]
  console.log(lines.join("\n"))
  return 0
}

async function uninstall(paths: RootinePaths, yes: boolean): Promise<number> {
  const approved = yes || await confirm({ message: "Remove the px/py wrappers, sudoers entry, agent prompt sections, and rootine config?" }) === true
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
