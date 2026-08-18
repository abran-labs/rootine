import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { userInfo } from "node:os"
import { agentPrompt, polkitRuleSource, wrapperScript } from "./assets"
import { parseConfig, type Mode, type RootineConfig } from "./config"
import { polkitProblems, probeDependencies, type RootineDependencyReport } from "./deps"
import { type RootinePaths } from "./paths"
import { removeAgentPrompt, writeAgentPrompt } from "./tool-writers"

export type SetupOptions = {
  readonly mode: Mode
  readonly allowlist?: readonly string[]
  readonly paths: RootinePaths
  readonly username?: string
  readonly dependencies?: RootineDependencyReport
  readonly confirm: (summary: readonly string[]) => Promise<boolean>
  readonly run: (command: string, args: readonly string[], input?: string) => Promise<{ readonly exitCode: number; readonly stderr: string }>
  readonly log: (line: string) => void
}

export type SetupResult = {
  readonly status: "applied" | "cancelled"
  readonly changes: readonly string[]
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const report = options.dependencies ?? await probeDependencies()
  const problems = polkitProblems(report)
  const username = options.username ?? userInfo().username
  const config: RootineConfig = { version: 1, mode: options.mode, allowlist: options.allowlist ?? [] }
  const promptSection = agentPrompt(config.mode, config.allowlist)
  const ruleSource = polkitRuleSource(config, username)
  const changes: string[] = []
  if (problems.length > 0) throw new RootineSetupError(problems.join("; "))
  const current = await readConfig(options.paths.configFile)
  const ruleChanged = await ruleStateChanged(options.paths.ruleFile, ruleSource)
  const promptChanges = await Promise.all([promptChanged(options.paths.opencodeAgentFile, promptSection), promptChanged(options.paths.claudeAgentFile, promptSection)])
  const wrapperNeedsUpdate = await wrapperChanged(options.paths.wrapperFile)
  const summary = [
    `mode: ${config.mode}${config.mode === "review" ? `, always-allow: ${config.allowlist.length === 0 ? "(none)" : config.allowlist.join(", ")}` : ""}`,
    ...(wrapperNeedsUpdate ? ["wrapper: install ~/.local/bin/px"] : ["wrapper: unchanged"]),
    ...(ruleChanged ? [config.mode === "always-ask" ? "polkit rule: remove" : "polkit rule: install (one approval dialog)"] : ["polkit rule: unchanged"]),
    ...(promptChanges[0]?.changed === true ? ["prompt: OpenCode AGENTS.md updated"] : []),
    ...(promptChanges[1]?.changed === true ? ["prompt: Claude CLAUDE.md updated"] : []),
  ]
  if (!summary.some((line) => line.includes("updated") || line.includes("install") || line.includes("remove")) && current?.mode === config.mode) return { status: "applied", changes: [] }
  if (!(await options.confirm(summary))) return { status: "cancelled", changes: [] }

  if (wrapperNeedsUpdate) {
    await mkdir(options.paths.wrapperDir, { recursive: true })
    await writeFile(options.paths.wrapperFile, wrapperScript(), { mode: 0o755 })
    changes.push(`wrapper installed: ${options.paths.wrapperFile}`)
  }
  await mkdir(dirname(options.paths.configFile), { recursive: true })
  await writeFile(options.paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  changes.push(`config written: ${options.paths.configFile}`)

  if (ruleChanged) {
    if (ruleSource === undefined) {
      const result = await options.run(options.paths.wrapperFile, ["/usr/bin/rm", "-f", options.paths.ruleFile])
      if (result.exitCode === 0) changes.push("polkit rule removed")
      else options.log(`could not remove polkit rule: ${result.stderr.trim() || "polkit dialog cancelled or unavailable"}`)
    } else {
      const result = await options.run(options.paths.wrapperFile, ["/usr/bin/tee", options.paths.ruleFile], ruleSource)
      if (result.exitCode !== 0) throw new RootineSetupError(`polkit rule install failed (dialog cancelled or no agent): ${result.stderr.trim()}`)
      await options.run(options.paths.wrapperFile, ["/usr/bin/chmod", "0644", options.paths.ruleFile])
      changes.push(`polkit rule installed: ${options.paths.ruleFile}`)
    }
  }

  for (const target of promptChanges) {
    if (target.changed === false) continue
    const result = await writeAgentPrompt(target.path, promptSection)
    if (result.changed) changes.push(`prompt updated: ${target.path}`)
  }
  return { status: "applied", changes }
}

export async function runUninstall(options: { readonly paths: RootinePaths; readonly confirm: (summary: readonly string[]) => Promise<boolean>; readonly run: (command: string, args: readonly string[], input?: string) => Promise<{ readonly exitCode: number; readonly stderr: string }>; readonly log: (line: string) => void }): Promise<SetupResult> {
  const confirmed = await options.confirm(["remove wrapper ~/.local/bin/px", "remove polkit rule (one approval dialog)", "remove agent prompt sections", "remove rootine config"])
  if (!confirmed) return { status: "cancelled", changes: [] }
  const changes: string[] = []
  await rm(options.paths.wrapperFile, { force: true })
  changes.push("wrapper removed")
  const rule = Bun.file(options.paths.ruleFile)
  if (await rule.exists()) {
    const result = await options.run(options.paths.wrapperFile, ["/usr/bin/rm", "-f", options.paths.ruleFile])
    if (result.exitCode === 0) changes.push("polkit rule removed")
    else options.log(`could not remove polkit rule: ${result.stderr.trim() || "polkit dialog cancelled or unavailable"}`)
  }
  for (const target of [options.paths.opencodeAgentFile, options.paths.claudeAgentFile]) {
    const result = await removeAgentPrompt(target)
    if (result.changed) changes.push(`prompt removed: ${target}`)
  }
  await rm(dirname(options.paths.configFile), { recursive: true, force: true })
  changes.push("config removed")
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

async function wrapperChanged(path: string): Promise<boolean> {
  try {
    return await readFile(path, "utf8") !== wrapperScript()
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

async function ruleStateChanged(ruleFile: string, ruleSource: string | undefined): Promise<boolean> {
  const file = Bun.file(ruleFile)
  const exists = await file.exists()
  if (ruleSource === undefined) return exists
  if (!exists) return true
  return await file.text() !== ruleSource
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
