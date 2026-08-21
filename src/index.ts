import { isFailure, onboard, type Node } from "@abran-labs/onboard-kit"
import { dialogWrapperScript, silentWrapperScript } from "./assets"
import type { Mode } from "./config"
import { polkitProblems, polkitRemediationSteps, probeDependencies } from "./deps"
import { defaultWrapperRun, readConfig, readSudoersEntry, remediatePolkit, runSetup, runUninstall, type SetupResult } from "./install"
import { rootinePaths, type RootinePaths } from "./paths"

const HELP = `Usage:
  rootine setup [--always-allow|--review|--always-ask] [--yes]
  rootine doctor
  rootine uninstall [--yes]

Modes:
  always-allow  sx runs everything as root, no dialog ever
  review        sx for routine safe commands, px (dialog) for sensitive ones
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

export function parseArgs(args: readonly string[]): ParsedArgs {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { kind: "help" }
  const [command, ...rest] = args as readonly string[]
  if (command === "doctor") return { kind: "doctor" }
  if (command === "uninstall") {
    const yes = rest.includes("--yes")
    if (rest.some((flag) => flag !== "--yes")) throw new RootineCliError("rootine uninstall accepts only --yes")
    return { kind: "uninstall", yes }
  }
  if (command !== "setup") throw new RootineCliError(`unknown command: ${command ?? ""}`)
  const yes = rest.includes("--yes")
  const modeFlags = rest.filter((token) => token === "--always-allow" || token === "--review" || token === "--always-ask")
  if (modeFlags.length > 1) throw new RootineCliError("setup accepts only one mode flag")
  const mode = modeFlags[0] === "--always-allow" ? "always-allow" : modeFlags[0] === "--review" ? "review" : modeFlags[0] === "--always-ask" ? "always-ask" : undefined
  const unknown = rest.find((token) => token !== "--yes" && token !== "--always-allow" && token !== "--review" && token !== "--always-ask")
  if (unknown !== undefined) throw new RootineCliError(`unknown flag: ${unknown}`)
  return { kind: "setup", ...(mode === undefined ? {} : { mode }), yes }
}


async function setup(paths: RootinePaths, parsed: Extract<ParsedArgs, { kind: "setup" }>, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  if (parsed.mode !== undefined && parsed.yes) {
    const report = await remediatePolkit({ report: await probeDependencies(environment), environment, confirm: async () => true, run: runInherited, log: console.log })
    return reportResult(await runSetup({ mode: parsed.mode, paths, dependencies: report, confirm: async (summary) => { printSummary(summary); return true }, run: runInherited, quietRun: defaultWrapperRun(), log: console.log }))
  }

  type Answers = { mode?: Mode }
  const initial = await probeDependencies(environment)
  const problems = polkitProblems(initial)
  const remediation = polkitRemediationSteps(initial)
  const fixedMode = parsed.mode
  let applied = false
  let report = initial
  const nodes: Node<Answers>[] = [
    { node: "welcome", subtitle: "Safe privileged commands for coding agents." },
    ...(problems.length === 0 ? [] : [{
      node: "note" as const,
      title: "System preparation",
      body: remediation.length > 0 ? remediation.map((step) => `- ${step.label}`).join("\n") : problems.join("\n"),
    }]),
    {
      node: "choice",
      id: "mode",
      label: "Approval mode",
      default: "review",
      options: [
        { value: "review", label: "review", recommended: true },
        { value: "always-ask", label: "always ask" },
        { value: "always-allow", label: "always allow" },
      ],
      when: () => fixedMode === undefined,
    },
    {
      node: "task",
      label: "Preparing system",
      output: "inherit",
      when: () => problems.length > 0,
      run: async () => {
        report = await remediatePolkit({ report, environment, confirm: async () => true, run: runInherited, log: () => undefined })
      },
    },
    {
      node: "task",
      label: "Installing Rootine",
      output: "inherit",
      run: async (answers) => {
        const mode = fixedMode ?? answers.mode
        if (mode === undefined) throw new RootineCliError("privileged-command mode was not selected")
        await runSetup({ mode, paths, dependencies: report, confirm: async () => true, run: runInherited, quietRun: defaultWrapperRun(), log: () => undefined })
        applied = true
      },
    },
    {
      node: "done",
      message: "Rootine is ready.",
      next: [
        { cmd: "rootine setup", desc: "change approval mode" },
        { cmd: "rootine doctor", desc: "inspect installation" },
        { cmd: "rootine uninstall", desc: "remove Rootine" },
      ],
      when: () => applied,
    },
  ]
  const result = await onboard<Answers>({ name: "Rootine", logo: true, state: false, nodes, env: { ...environment } })
  if (isFailure(result)) {
    if (result.status === "cancelled") return 0
    if (result.status === "failed") throw result.error
    return 1
  }
  return 0
}

function runInherited(command: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = Bun.spawn({ cmd: [command, ...args], stdio: ["inherit", "inherit", "inherit"] })
    child.exited.then((exitCode) => resolve({ exitCode, stderr: "" }))
  })
}

async function doctor(paths: RootinePaths): Promise<number> {
  const report = await probeDependencies()
  const problems = polkitProblems(report)
  const config = await readConfig(paths.configFile)
  const dialogWrapper = Bun.file(paths.dialogWrapperFile)
  const silentWrapper = Bun.file(paths.silentWrapperFile)
  const dialogOk = (await dialogWrapper.exists()) && (await dialogWrapper.text()) === dialogWrapperScript()
  const silentOk = (await silentWrapper.exists()) && (await silentWrapper.text()) === silentWrapperScript()
  const sudoersPresent = await readSudoersEntry(paths.sudoersFile, report.sudo) !== undefined
  const lines = [
    `platform: ${report.linux ? "linux" : "unsupported"}`,
    `pkexec: ${report.polkit.pkexec ?? "missing"}`,
    `polkitd: ${report.polkit.polkitd ? "running" : "not running"}`,
    `polkit agent: ${report.polkit.agent ? "detected" : "not detected"}`,
    `sudo: ${report.sudo ?? "missing"}`,
    `wrapper px (dialog): ${dialogOk ? `ready (${paths.dialogWrapperFile})` : "missing or stale"}`,
    `wrapper sx (silent): ${silentOk ? `ready (${paths.silentWrapperFile})` : await silentWrapper.exists() ? "stale" : "absent"}`,
    `config: ${config === undefined ? "missing" : `mode=${config.mode}`}`,
    `sudoers entry: ${sudoersPresent ? "present" : "absent"}`,
    `problems: ${problems.length === 0 ? "none" : problems.join("; ")}`,
  ]
  console.log(lines.join("\n"))
  return 0
}

async function uninstall(paths: RootinePaths, yes: boolean): Promise<number> {
  const sudo = await Bun.which("sudo") ?? undefined
  if (yes) return reportResult(await runUninstall({ paths, sudo, confirm: async () => true, run: runInherited, log: console.log }))
  type Answers = { remove: boolean }
  let removed = false
  const result = await onboard<Answers>({
    name: "Rootine",
    state: false,
    nodes: [
      { node: "welcome", subtitle: "Remove Rootine from this machine." },
      { node: "confirm", id: "remove", label: "Remove Rootine from this machine?", default: false },
      { node: "task", label: "Removing Rootine", output: "inherit", when: (answers) => answers.remove, run: async () => {
        await runUninstall({ paths, sudo, confirm: async () => true, run: runInherited, log: () => undefined })
        removed = true
      } },
      { node: "done", message: "Rootine was removed.", when: () => removed },
      { node: "done", message: "No changes made.", when: (answers) => !answers.remove },
    ],
  })
  if (isFailure(result) && result.status === "failed") throw result.error
  return isFailure(result) && result.status !== "cancelled" ? 1 : 0
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
