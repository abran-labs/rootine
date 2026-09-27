import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { userInfo } from "node:os"
import { agentPrompt, dialogWrapperScript, silentHelperScript, silentWrapperScript, sudoersFileSource } from "./assets"
import { parseConfig, type Mode, type RootineConfig } from "./config"
import { polkitProblems, probeDependencies, type RootineDependencyReport } from "./deps"
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
  const report = options.dependencies ?? await probeDependencies(process.env, options.mode)
  const problems = polkitProblems(report, options.mode)
  if (problems.length > 0) throw new RootineSetupError(problems.join("; "))
  const username = options.username ?? userInfo().username
  const config: RootineConfig = { version: 1, mode: options.mode }
  const promptSection = agentPrompt(config.mode)
  const needsSudoers = config.mode !== "always-ask"
  if (needsSudoers && report.sudo === undefined) throw new RootineSetupError("sudo is required for sx-based modes (review, always-allow)")
  const sudoersSource = needsSudoers ? sudoersFileSource(username, options.paths.silentHelperFile) : undefined
  const helperSource = needsSudoers ? silentHelperScript() : undefined
  const current = await readConfig(options.paths.configFile)
  const sudoersChanged = await sudoersStateChanged(options.paths.sudoersFile, sudoersSource, report.sudo, options.paths.silentHelperFile, current?.mode !== undefined && current.mode !== "always-ask")
  const promptChanges = await Promise.all([promptChanged(options.paths.opencodeAgentFile, promptSection), promptChanged(options.paths.claudeAgentFile, promptSection)])
  const dialogWrapperChanged = await wrapperChanged(options.paths.dialogWrapperFile, dialogWrapperScript())
  const silentWrapperChanged = needsSudoers && await wrapperChanged(options.paths.silentWrapperFile, silentWrapperScript(options.paths.silentHelperFile))
  const silentHelperChanged = await privilegedFileChanged(options.paths.silentHelperFile, helperSource)
  const summary = [
    `mode: ${config.mode}`,
    ...(dialogWrapperChanged ? ["wrapper: install ~/.local/bin/px (dialog)"] : ["wrapper px: unchanged"]),
    ...(silentWrapperChanged ? ["wrapper: install ~/.local/bin/sx (silent)"] : needsSudoers ? ["wrapper sx: unchanged"] : ["wrapper sx: remove if present"]),
    ...(silentHelperChanged ? [helperSource === undefined ? "sx helper: remove" : "sx helper: install"] : ["sx helper: unchanged"]),
    ...(sudoersChanged ? [sudoersSource === undefined ? "sudoers: remove" : "sudoers: install"] : ["sudoers: unchanged"]),
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
    await writeFile(options.paths.silentWrapperFile, silentWrapperScript(options.paths.silentHelperFile), { mode: 0o755 })
    changes.push(`wrapper installed: ${options.paths.silentWrapperFile}`)
  }
  if (!needsSudoers) {
    const existing = Bun.file(options.paths.silentWrapperFile)
    if (await existing.exists()) {
      await existing.delete()
      changes.push(`wrapper removed: ${options.paths.silentWrapperFile}`)
    }
  }

  if (sudoersSource !== undefined && helperSource !== undefined && (sudoersChanged || silentHelperChanged)) {
    await applySilentAccess(options, sudoersSource, helperSource, report.sudo!, sudoersChanged, silentHelperChanged)
    if (silentHelperChanged) changes.push(`sx helper installed: ${options.paths.silentHelperFile}`)
    if (sudoersChanged) changes.push(`sudoers entry installed: ${options.paths.sudoersFile}`)
  } else if (sudoersChanged || silentHelperChanged) {
    if (report.sudo === undefined) throw new RootineSetupError("sudo is required to remove sx privileged files")
    const result = await options.run(report.sudo, ["/usr/bin/rm", "-f", options.paths.sudoersFile, options.paths.silentHelperFile])
    if (result.exitCode !== 0) throw new RootineSetupError(`sx privileged-file removal failed: ${result.stderr.trim() || "see output above"}`)
    if (sudoersChanged) changes.push("sudoers entry removed")
    if (silentHelperChanged) changes.push("sx helper removed")
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

// Stage and validate privileged files before installing root-owned copies.
async function applySilentAccess(options: SetupOptions, sudoersSource: string, helperSource: string, sudo: string, installSudoers: boolean, installHelper: boolean): Promise<void> {
  const stage = join(dirname(options.paths.configFile), "sudoers.stage")
  const helperStage = join(dirname(options.paths.configFile), "rootine-sx.stage")
  await mkdir(dirname(stage), { recursive: true })
  await writeFile(stage, sudoersSource, { mode: 0o600 })
  await writeFile(helperStage, helperSource, { mode: 0o700 })
  try {
    const validate = await (options.quietRun ?? options.run)("visudo", ["-cf", stage])
    if (validate.exitCode !== 0) throw new RootineSetupError(`sudoers validation failed: ${validate.stderr.trim()}`)
    if (installHelper) {
      const helperInstall = await options.run(sudo, ["/usr/bin/install", "-D", "-m", "0755", helperStage, options.paths.silentHelperFile])
      if (helperInstall.exitCode !== 0) throw new RootineSetupError(`sx helper install failed: ${helperInstall.stderr.trim() || "see output above"}`)
    }
    if (installSudoers) {
      const sudoersInstall = await options.run(sudo, ["/usr/bin/install", "-m", "0440", stage, options.paths.sudoersFile])
      if (sudoersInstall.exitCode !== 0) throw new RootineSetupError(`sudoers install failed: ${sudoersInstall.stderr.trim() || "see output above"}`)
    }
  } finally {
    await Promise.all([rm(stage, { force: true }), rm(helperStage, { force: true })])
  }
}

export async function runUninstall(options: { readonly paths: RootinePaths; readonly sudo: string | undefined; readonly confirm: (summary: readonly string[]) => Promise<boolean>; readonly run: (command: string, args: readonly string[], input?: string) => Promise<{ readonly exitCode: number; readonly stderr: string }>; readonly log: (line: string) => void }): Promise<SetupResult> {
  const confirmed = await options.confirm(["remove sudoers entry", "remove wrappers px and sx", "remove agent prompt sections", "remove rootine config", "remove rootine executable"])
  if (!confirmed) return { status: "cancelled", changes: [] }
  const changes: string[] = []
  const sudoersPresent = await filePresence(options.paths.sudoersFile) !== false
  const helperPresent = await Bun.file(options.paths.silentHelperFile).exists()
  if (sudoersPresent || helperPresent) {
    if (options.sudo === undefined) throw new RootineSetupError("sudo is required to remove the rootine sudoers entry")
    const result = await options.run(options.sudo, ["/usr/bin/rm", "-f", options.paths.sudoersFile, options.paths.silentHelperFile])
    if (result.exitCode !== 0) throw new RootineSetupError(`sudoers/helper removal failed: ${result.stderr.trim() || "see output above"}`)
    if (sudoersPresent) changes.push("sudoers entry removed")
    if (helperPresent) changes.push("sx helper removed")
  }
  for (const wrapper of [options.paths.dialogWrapperFile, options.paths.silentWrapperFile]) {
    if (await Bun.file(wrapper).exists()) {
      await rm(wrapper, { force: true })
      changes.push(`wrapper removed: ${wrapper}`)
    }
  }
  for (const target of [options.paths.opencodeAgentFile, options.paths.claudeAgentFile]) {
    const result = await removeAgentPrompt(target)
    if (result.changed) changes.push(`prompt removed: ${target}`)
  }
  await rm(dirname(options.paths.configFile), { recursive: true, force: true })
  changes.push("config removed")
  if (await Bun.file(options.paths.executableFile).exists()) {
    await rm(options.paths.executableFile, { force: true })
    changes.push(`executable removed: ${options.paths.executableFile}`)
  }
  return { status: "applied", changes }
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

async function sudoersStateChanged(sudoersFile: string, source: string | undefined, sudo: string | undefined, helper: string, wasManaged: boolean): Promise<boolean> {
  if (source === undefined) {
    const present = await filePresence(sudoersFile)
    return present ?? wasManaged
  }
  const current = await readSudoersEntry(sudoersFile, sudo, helper)
  return current !== source
}

async function filePresence(path: string): Promise<boolean | undefined> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) return undefined
    throw error
  }
}

async function privilegedFileChanged(path: string, source: string | undefined): Promise<boolean> {
  try {
    const current = await readFile(path, "utf8")
    return source === undefined || current !== source
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return source !== undefined
    throw error
  }
}

export async function readSudoersEntry(path: string, sudo: string | undefined, helper?: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    if (!(error instanceof Error && "code" in error && error.code === "EACCES")) throw error
  }
  if (sudo === undefined) return undefined
  const commands = [
    ...(helper === undefined ? [] : [[sudo, "-n", "--", helper, "/usr/bin/cat", path]]),
    [sudo, "-n", "--", "/usr/bin/cat", path],
  ]
  for (const command of commands) {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" })
    const [exitCode, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exitCode === 0) return text
  }
  return undefined
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
