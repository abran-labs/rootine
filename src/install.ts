import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { userInfo } from "node:os"
import { agentPrompt, dialogWrapperScript, silentWrapperScript, sudoersFileSource } from "./assets"
import { parseConfig, type Mode, type RootineConfig } from "./config"
import { polkitProblems, probeDependencies, polkitRemediationSteps, type RootineDependencyReport } from "./deps"
import { type RootinePaths } from "./paths"
import { removeAgentPrompt, writeAgentPrompt } from "./tool-writers"

export type SetupOptions = {
  readonly mode: Mode
  readonly paths: RootinePaths
  readonly username?: string
  readonly dependencies?: RootineDependencyReport
  readonly confirm: (summary: readonly string[]) => Promise<boolean>
  readonly run: (command: string, args: readonly string[], input?: string) => Promise<{ readonly exitCode: number; readonly stderr: string }>
  readonly quietRun?: (command: string, args: readonly string[], input?: string) => Promise<{ readonly exitCode: number; readonly stderr: string }>
  readonly log: (line: string) => void
}

export type SetupResult = {
  readonly status: "applied" | "cancelled"
  readonly changes: readonly string[]
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const report = options.dependencies ?? await probeDependencies()
  const problems = polkitProblems(report)
  if (problems.length > 0) throw new RootineSetupError(problems.join("; "))
  const username = options.username ?? userInfo().username
  const config: RootineConfig = { version: 1, mode: options.mode }
  const promptSection = agentPrompt(config.mode)
  const needsSudoers = config.mode !== "always-ask"
  if (needsSudoers && report.sudo === undefined) throw new RootineSetupError("sudo is required for sx-based modes (review, always-allow)")
  const sudoersSource = needsSudoers ? sudoersFileSource(username) : undefined
  const current = await readConfig(options.paths.configFile)
  const sudoersChanged = await sudoersStateChanged(options.paths.sudoersFile, sudoersSource, report.sudo)
  const promptChanges = await Promise.all([promptChanged(options.paths.opencodeAgentFile, promptSection), promptChanged(options.paths.claudeAgentFile, promptSection)])
  const dialogWrapperChanged = await wrapperChanged(options.paths.dialogWrapperFile, dialogWrapperScript())
  const silentWrapperChanged = needsSudoers && await wrapperChanged(options.paths.silentWrapperFile, silentWrapperScript())
  const summary = [
    `mode: ${config.mode}`,
    ...(dialogWrapperChanged ? ["wrapper: install ~/.local/bin/px (dialog)"] : ["wrapper px: unchanged"]),
    ...(silentWrapperChanged ? ["wrapper: install ~/.local/bin/sx (silent)"] : needsSudoers ? ["wrapper sx: unchanged"] : ["wrapper sx: remove if present"]),
    ...(sudoersChanged ? [sudoersSource === undefined ? "sudoers: remove" : "sudoers: install (one approval dialog)"] : ["sudoers: unchanged"]),
    ...(promptChanges[0]?.changed === true ? ["prompt: OpenCode AGENTS.md updated"] : []),
    ...(promptChanges[1]?.changed === true ? ["prompt: Claude CLAUDE.md updated"] : []),
  ]
  if (!summary.some((line) => line.includes("updated") || line.includes("install") || line.includes("remove")) && current?.mode === config.mode) return { status: "applied", changes: [] }
  if (!(await options.confirm(summary))) return { status: "cancelled", changes: [] }

  const changes: string[] = []
  await mkdir(options.paths.wrapperDir, { recursive: true })
  if (dialogWrapperChanged) {
    await writeFile(options.paths.dialogWrapperFile, dialogWrapperScript(), { mode: 0o755 })
    changes.push(`wrapper installed: ${options.paths.dialogWrapperFile}`)
  }
  if (silentWrapperChanged === true) {
    await writeFile(options.paths.silentWrapperFile, silentWrapperScript(), { mode: 0o755 })
    changes.push(`wrapper installed: ${options.paths.silentWrapperFile}`)
  }
  if (!needsSudoers) {
    const existing = Bun.file(options.paths.silentWrapperFile)
    if (await existing.exists()) {
      await existing.delete()
      changes.push(`wrapper removed: ${options.paths.silentWrapperFile}`)
    }
  }

  if (sudoersChanged) {
    if (sudoersSource === undefined) {
      const result = await options.run(options.paths.dialogWrapperFile, ["/usr/bin/rm", "-f", options.paths.sudoersFile])
      if (result.exitCode === 0) changes.push("sudoers entry removed")
      else options.log(`could not remove sudoers entry: ${result.stderr.trim() || "polkit dialog cancelled or unavailable"}`)
    } else {
      await applySudoers(options, sudoersSource, report.sudo!)
      changes.push(`sudoers entry installed: ${options.paths.sudoersFile}`)
    }
  }

  await mkdir(dirname(options.paths.configFile), { recursive: true })
  const configText = `${JSON.stringify(config, null, 2)}\n`
  const configFile = Bun.file(options.paths.configFile)
  if (!(await configFile.exists()) || (await configFile.text()) !== configText) {
    await writeFile(options.paths.configFile, configText, { mode: 0o600 })
    changes.push(`config written: ${options.paths.configFile}`)
  }
  for (const target of promptChanges) {
    if (target.changed === false) continue
    const result = await writeAgentPrompt(target.path, promptSection)
    if (result.changed) changes.push(`prompt updated: ${target.path}`)
  }
  return { status: "applied", changes }
}

// Stage the sudoers content as a user-owned temp file, validate it with
// visudo -cf, then move it into /etc/sudoers.d through the dialog wrapper.
async function applySudoers(options: SetupOptions, source: string, sudo: string): Promise<void> {
  const stage = join(dirname(options.paths.configFile), "sudoers.stage")
  await mkdir(dirname(stage), { recursive: true })
  await writeFile(stage, source, { mode: 0o600 })
  const validate = await (options.quietRun ?? options.run)("/usr/bin/visudo", ["-cf", stage])
  if (validate.exitCode !== 0) {
    await rm(stage, { force: true })
    throw new RootineSetupError(`sudoers validation failed: ${validate.stderr.trim()}`)
  }
  const install = await options.run(sudo, ["/usr/bin/install", "-m", "0440", stage, options.paths.sudoersFile])
  await rm(stage, { force: true })
  if (install.exitCode !== 0) throw new RootineSetupError(`sudoers install failed (dialog cancelled or no agent): ${install.stderr.trim()}`)
}

export async function runUninstall(options: { readonly paths: RootinePaths; readonly confirm: (summary: readonly string[]) => Promise<boolean>; readonly run: (command: string, args: readonly string[], input?: string) => Promise<{ readonly exitCode: number; readonly stderr: string }>; readonly log: (line: string) => void }): Promise<SetupResult> {
  const confirmed = await options.confirm(["remove wrappers px and sx", "remove sudoers entry (one approval dialog)", "remove agent prompt sections", "remove rootine config"])
  if (!confirmed) return { status: "cancelled", changes: [] }
  const changes: string[] = []
  for (const wrapper of [options.paths.dialogWrapperFile, options.paths.silentWrapperFile]) {
    await rm(wrapper, { force: true })
    changes.push(`wrapper removed: ${wrapper}`)
  }
  const sudoers = Bun.file(options.paths.sudoersFile)
  if (await sudoers.exists()) {
    const result = await options.run(options.paths.dialogWrapperFile, ["/usr/bin/rm", "-f", options.paths.sudoersFile])
    if (result.exitCode === 0) changes.push("sudoers entry removed")
    else options.log(`could not remove sudoers entry: ${result.stderr.trim() || "polkit dialog cancelled or unavailable"}`)
  }
  for (const target of [options.paths.opencodeAgentFile, options.paths.claudeAgentFile]) {
    const result = await removeAgentPrompt(target)
    if (result.changed) changes.push(`prompt removed: ${target}`)
  }
  await rm(dirname(options.paths.configFile), { recursive: true, force: true })
  changes.push("config removed")
  return { status: "applied", changes }
}

export async function remediatePolkit(input: {
  readonly report: RootineDependencyReport
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly confirm: (label: string) => Promise<boolean>
  readonly run: (command: string, args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stderr: string }>
  readonly log: (line: string) => void
  readonly probe?: (environment: Readonly<Record<string, string | undefined>>) => Promise<RootineDependencyReport>
}): Promise<RootineDependencyReport> {
  const probe = input.probe ?? probeDependencies
  let report = input.report
  for (;;) {
    const problems = polkitProblems(report)
    if (problems.length === 0) return report
    const steps = polkitRemediationSteps(report)
    if (steps.length === 0) throw new RootineSetupError(`cannot remediate automatically: ${problems.join("; ")}`)
    const before = JSON.stringify(report)
    for (const step of steps) {
      if (!(await input.confirm(step.label))) throw new RootineSetupError(`polkit remediation declined: ${step.label}`)
      input.log(`-> ${step.label}`)
      const result = await input.run(step.command, step.args)
      if (result.exitCode !== 0) throw new RootineSetupError(`${step.label} failed: ${result.stderr.trim() || "see output above"}`)
      if (step.startNow !== undefined) {
        input.log(`-> starting the polkit authentication agent: ${[step.startNow.command, ...step.startNow.args].join(" ")}`)
        const started = await input.run(step.startNow.command, step.startNow.args)
        if (started.exitCode !== 0) throw new RootineSetupError(`could not start the polkit authentication agent: ${started.stderr.trim() || "see output above"}`)
      }
    }
    report = await probe(input.environment)
    if (JSON.stringify(report) === before) throw new RootineSetupError(`polkit remediation made no progress: ${problems.join("; ")}`)
  }
}

export async function readConfig(path: string): Promise<RootineConfig | undefined> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  try {
    return parseConfig(JSON.parse(await file.text()))
  } catch (error) {
    if (error instanceof SyntaxError) throw new RootineSetupError(`rootine config is malformed: ${path}`)
    throw error
  }
}

async function wrapperChanged(path: string, expected: string): Promise<boolean> {
  try {
    return await readFile(path, "utf8") !== expected
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true
    throw error
  }
}

async function promptChanged(path: string, section: string): Promise<{ readonly path: string; readonly changed: boolean }> {
  try {
    const source = await readFile(path, "utf8")
    const { replaceSection } = await import("./tool-writers")
    return { path, changed: replaceSection(source, section) !== source }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { path, changed: true }
    throw error
  }
}

async function sudoersStateChanged(sudoersFile: string, source: string | undefined, sudo: string | undefined): Promise<boolean> {
  const current = await readSudoersEntry(sudoersFile, sudo)
  if (source === undefined) return current !== undefined
  return current !== source
}

export async function readSudoersEntry(path: string, sudo: string | undefined): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    if (!(error instanceof Error && "code" in error && error.code === "EACCES")) throw error
  }
  if (sudo === undefined) return undefined
  const child = Bun.spawn([sudo, "-n", "/usr/bin/cat", path], { stdout: "pipe", stderr: "ignore" })
  const [exitCode, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return exitCode === 0 ? text : undefined
}

export class RootineSetupError extends Error {
  readonly name = "RootineSetupError"
}

export function defaultWrapperRun(): SetupOptions["run"] {
  return async (command, args, input) => {
    const child = Bun.spawn({ cmd: [command, ...args], stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
    if (input !== undefined && child.stdin !== undefined) child.stdin.write(input)
    if (child.stdin !== undefined) child.stdin.end()
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { exitCode, stderr }
  }
}
