import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RootineDependencyReport } from "../src/deps"
import { runSetup } from "../src/install"
import type { RootinePaths } from "../src/paths"

const temporaryPaths: string[] = []
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const healthyDeps: RootineDependencyReport = {
  linux: true,
  polkit: { pkexec: "/usr/bin/pkexec", polkitd: true, agent: true, packageManager: "pacman" },
}

type FakeRun = { readonly calls: { command: string; args: readonly string[]; input?: string }[]; readonly failRuleInstall: boolean }

function paths(root: string): RootinePaths {
  return {
    configFile: join(root, "config", "rootine", "config.json"),
    wrapperDir: join(root, "bin"),
    wrapperFile: join(root, "bin", "px"),
    ruleFile: join(root, "10-rootine.rules"),
    opencodeAgentFile: join(root, "config", "opencode", "AGENTS.md"),
    claudeAgentFile: join(root, "home", ".claude", "CLAUDE.md"),
  }
}

function fakeRun(fail = false): FakeRun {
  const calls: FakeRun["calls"] = []
  return { calls, failRuleInstall: fail }
}

function runner(fake: FakeRun, ruleFile: string) {
  return async (command: string, args: readonly string[], input?: string) => {
    fake.calls.push({ command, args, ...(input === undefined ? {} : { input }) })
    if (fake.failRuleInstall && args.includes(ruleFile) && args[0] === "/usr/bin/tee") return { exitCode: 126, stderr: "polkit dialog cancelled" }
    return { exitCode: 0, stderr: "" }
  }
}

function options(root: string, mode: "always-allow" | "review" | "always-ask", allowlist: readonly string[] = [], fake: FakeRun = fakeRun()) {
  return {
    mode,
    allowlist,
    paths: paths(root),
    username: "abran",
    dependencies: healthyDeps,
    confirm: async () => true,
    run: runner(fake, paths(root).ruleFile),
    log: () => undefined,
  }
}

describe("rootine setup", () => {
  test("installs wrapper, config, rule, and agent prompts in review mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    const fake = fakeRun()
    const result = await runSetup(options(root, "review", ["/usr/bin/journalctl"], fake))

    expect(result.status).toBe("applied")
    expect(await readFile(join(root, "bin", "px"), "utf8")).toContain("pkexec --disable-internal-agent")
    const config = JSON.parse(await readFile(join(root, "config", "rootine", "config.json"), "utf8"))
    expect(config.mode).toBe("review")
    expect(await readFile(join(root, "config", "opencode", "AGENTS.md"), "utf8")).toContain("/usr/bin/journalctl")
    expect(await readFile(join(root, "home", ".claude", "CLAUDE.md"), "utf8")).toContain("polkit approval dialog")
    expect(fake.calls.some((call) => call.args.includes(paths(root).ruleFile))).toBe(true)
    const rule = fake.calls.find((call) => call.command.endsWith("px") && call.args[0] === "/usr/bin/tee")
    expect(rule?.input).toContain("polkit.addRule")
    expect(rule?.input).toContain('"abran"')
  })

  test("always-ask writes no rule and removes a stale one", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    await Bun.write(join(root, "config", "rootine", "config.json"), JSON.stringify({ version: 1, mode: "always-allow", allowlist: [] }))
    await Bun.write(paths(root).ruleFile, "stale rule\n")
    const fake = fakeRun()
    const result = await runSetup(options(root, "always-ask", [], fake))
    expect(result.status).toBe("applied")
    expect(fake.calls.some((call) => call.args[0] === "/usr/bin/tee")).toBe(false)
    expect(fake.calls.some((call) => call.args[0] === "/usr/bin/rm" && call.args.includes(paths(root).ruleFile))).toBe(true)
  })

  test("aborts when the polkit rule install is denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    await expect(runSetup(options(root, "always-allow", [], fakeRun(true)))).rejects.toThrow("polkit rule install failed")
  })

  test("a repeated identical setup makes no changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    await runSetup(options(root, "always-ask"))
    const second = await runSetup(options(root, "always-ask"))
    expect(second.status).toBe("applied")
    expect(second.changes).toEqual([])
  })
})
