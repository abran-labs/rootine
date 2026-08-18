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
  sudo: "/usr/bin/sudo",
}

type FakeRun = { readonly calls: { command: string; args: readonly string[] }[]; readonly failSudoersInstall: boolean }

function paths(root: string): RootinePaths {
  return {
    configFile: join(root, "config", "rootine", "config.json"),
    wrapperDir: join(root, "bin"),
    dialogWrapperFile: join(root, "bin", "px"),
    silentWrapperFile: join(root, "bin", "py"),
    sudoersFile: join(root, "10-rootine"),
    opencodeAgentFile: join(root, "config", "opencode", "AGENTS.md"),
    claudeAgentFile: join(root, "home", ".claude", "CLAUDE.md"),
  }
}

function fakeRun(fail = false): FakeRun {
  const calls: FakeRun["calls"] = []
  return { calls, failSudoersInstall: fail }
}

function runner(fake: FakeRun, sudoersFile: string) {
  return async (command: string, args: readonly string[]) => {
    fake.calls.push({ command, args })
    if (fake.failSudoersInstall && args[0] === "/usr/bin/install" && args.includes(sudoersFile)) return { exitCode: 126, stderr: "polkit dialog cancelled" }
    return { exitCode: 0, stderr: "" }
  }
}

function options(root: string, mode: "always-allow" | "review" | "always-ask", fake: FakeRun = fakeRun()) {
  return {
    mode,
    paths: paths(root),
    username: "abran",
    dependencies: healthyDeps,
    confirm: async () => true,
    run: runner(fake, paths(root).sudoersFile),
    log: () => undefined,
  }
}

describe("rootine setup", () => {
  test("review installs both wrappers, the sudoers entry, and prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    const fake = fakeRun()
    const result = await runSetup(options(root, "review", fake))

    expect(result.status).toBe("applied")
    expect(await readFile(join(root, "bin", "px"), "utf8")).toContain("pkexec --disable-internal-agent")
    expect(await readFile(join(root, "bin", "py"), "utf8")).toContain("exec sudo --")
    expect(JSON.parse(await readFile(join(root, "config", "rootine", "config.json"), "utf8")).mode).toBe("review")
    expect(await readFile(join(root, "config", "opencode", "AGENTS.md"), "utf8")).toContain("sensitive or destructive")
    expect(await readFile(join(root, "home", ".claude", "CLAUDE.md"), "utf8")).toContain("routine and safe")
    // sudoers staged, validated, then installed through the dialog wrapper
    const calls = fake.calls.map((call) => call.args[0])
    expect(calls).toContain("/usr/bin/visudo")
    const install = fake.calls.find((call) => call.args[0] === "/usr/bin/install")
    expect(install?.args).toContain(paths(root).sudoersFile)
    expect(install?.command.endsWith("px")).toBe(true)
  })

  test("always-ask installs only px, no py and no sudoers", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    const fake = fakeRun()
    await runSetup(options(root, "always-ask", fake))
    expect(await readFile(join(root, "bin", "px"), "utf8")).toContain("pkexec")
    expect(await Bun.file(join(root, "bin", "py")).exists()).toBe(false)
    expect(fake.calls.some((call) => call.args[0] === "/usr/bin/visudo")).toBe(false)
  })

  test("switching from always-allow to always-ask removes py and the sudoers entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    const fake = fakeRun()
    await runSetup(options(root, "always-allow", fake))
    await Bun.write(paths(root).sudoersFile, "stale entry\n")
    const result = await runSetup(options(root, "always-ask", fake))
    expect(result.status).toBe("applied")
    expect(await Bun.file(join(root, "bin", "py")).exists()).toBe(false)
    expect(fake.calls.some((call) => call.args[0] === "/usr/bin/rm" && call.args.includes(paths(root).sudoersFile))).toBe(true)
  })

  test("aborts when the sudoers install is denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    await expect(runSetup(options(root, "review", fakeRun(true)))).rejects.toThrow("sudoers install failed")
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
