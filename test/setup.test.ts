import { afterEach, describe, expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RootineDependencyReport } from "../src/deps"
import { runSetup, runUninstall } from "../src/install"
import type { RootinePaths } from "../src/paths"

const temporaryPaths: string[] = []
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const healthyDeps: RootineDependencyReport = {
  linux: true,
  polkit: { pkexec: "/usr/bin/pkexec", polkitd: true, agent: true, packageManager: "pacman" },
  sudo: "/usr/bin/sudo",
  desktop: "Hyprland",
}

type FakeRun = { readonly calls: { command: string; args: readonly string[] }[]; readonly failSudoersInstall: boolean }

function paths(root: string): RootinePaths {
  return {
    configFile: join(root, "config", "rootine", "config.json"),
    wrapperDir: join(root, "bin"),
    executableFile: join(root, "bin", "rootine"),
    dialogWrapperFile: join(root, "bin", "px"),
    silentWrapperFile: join(root, "bin", "sx"),
    silentHelperFile: join(root, "rootine-sx"),
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
    if (args[0] === "/usr/bin/install") {
      const source = args.at(-2)!
      const target = args.at(-1)!
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      await chmod(target, Number.parseInt(args[args.indexOf("-m") + 1]!, 8))
    }
    if (args[0] === "/usr/bin/rm") await Promise.all(args.slice(2).map((path) => rm(path, { force: true })))
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
  test("always-allow rejects missing sudo before installing files", async () => {
    // Given a Linux host without sudo.
    const root = await mkdtemp(join(tmpdir(), "rootine-no-sudo-"))
    temporaryPaths.push(root)
    // When silent mode is installed, then its required runner remains mandatory.
    await expect(runSetup({ ...options(root, "always-allow"), dependencies: { ...healthyDeps, sudo: undefined } })).rejects.toThrow("sudo is required")
    expect(await Bun.file(paths(root).silentWrapperFile).exists()).toBe(false)
  })

  test("always-allow installs when the Linux host has no polkit or desktop", async () => {
    // Given a headless VPS with sudo but no polkit components.
    const root = await mkdtemp(join(tmpdir(), "rootine-headless-"))
    temporaryPaths.push(root)
    const fake = fakeRun()
    const dependencies: RootineDependencyReport = {
      linux: true,
      polkit: { pkexec: undefined, polkitd: false, agent: false, packageManager: "apt" },
      sudo: "/usr/bin/sudo",
      desktop: "",
    }

    // When silent approval mode is installed.
    const result = await runSetup({ ...options(root, "always-allow", fake), dependencies })

    // Then silent execution is installed without invoking polkit or a package manager.
    expect(result.status).toBe("applied")
    expect(await Bun.file(paths(root).silentWrapperFile).exists()).toBe(true)
    expect(await Bun.file(paths(root).silentHelperFile).exists()).toBe(true)
    expect(fake.calls.every((call) => call.command === "/usr/bin/visudo" || call.args[0] === "/usr/bin/install")).toBe(true)
  })

  test("review installs both wrappers, the sudoers entry, and prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    const fake = fakeRun()
    const result = await runSetup(options(root, "review", fake))

    expect(result.status).toBe("applied")
    expect(await readFile(join(root, "bin", "px"), "utf8")).toContain("pkexec --disable-internal-agent")
    expect(await readFile(join(root, "bin", "sx"), "utf8")).toContain("exec sudo --")
    expect(JSON.parse(await readFile(join(root, "config", "rootine", "config.json"), "utf8")).mode).toBe("review")
    expect(await readFile(join(root, "config", "opencode", "AGENTS.md"), "utf8")).toContain("sensitive or destructive")
    expect(await readFile(join(root, "home", ".claude", "CLAUDE.md"), "utf8")).toContain("routine and safe")
    // sudoers staged, validated, then installed through terminal sudo
    expect(fake.calls.some((call) => call.command === "/usr/bin/visudo" && call.args[0] === "-cf")).toBe(true)
    const helperInstall = fake.calls.find((call) => call.command === "/usr/bin/sudo" && call.args.includes(paths(root).silentHelperFile))
    expect(helperInstall?.args).toContain("0755")
    const install = fake.calls.find((call) => call.command === "/usr/bin/sudo" && call.args[0] === "/usr/bin/install" && call.args.includes(paths(root).sudoersFile))
    expect(install?.args).toContain(paths(root).sudoersFile)
    expect(install?.command).toBe("/usr/bin/sudo")
  })

  test("always-ask installs only px, no sx and no sudoers", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    const fake = fakeRun()
    await runSetup(options(root, "always-ask", fake))
    expect(await readFile(join(root, "bin", "px"), "utf8")).toContain("pkexec")
    expect(await Bun.file(join(root, "bin", "sx")).exists()).toBe(false)
    expect(fake.calls.some((call) => call.command === "/usr/bin/visudo")).toBe(false)
  })

  test("switching from always-allow to always-ask removes sx and the sudoers entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    const fake = fakeRun()
    await runSetup(options(root, "always-allow", fake))
    const result = await runSetup(options(root, "always-ask", fake))
    expect(result.status).toBe("applied")
    expect(await Bun.file(join(root, "bin", "sx")).exists()).toBe(false)
    expect(await Bun.file(paths(root).silentHelperFile).exists()).toBe(false)
    expect(await Bun.file(paths(root).sudoersFile).exists()).toBe(false)
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

  test("a repeated always-allow setup makes no changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    await runSetup(options(root, "always-allow"))
    const second = await runSetup(options(root, "always-allow"))
    expect(second.status).toBe("applied")
    expect(second.changes).toEqual([])
  })

  test("migrates the legacy unrestricted sudoers rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-setup-"))
    temporaryPaths.push(root)
    await Bun.write(paths(root).sudoersFile, "abran ALL=(ALL) NOPASSWD: ALL\n")
    await runSetup(options(root, "always-allow"))
    const sudoers = await readFile(paths(root).sudoersFile, "utf8")
    expect(sudoers).toContain(`NOPASSWD: ${paths(root).silentHelperFile} *`)
    expect(sudoers).not.toContain("NOPASSWD: ALL")
  })
})

describe("rootine uninstall", () => {
  test("removes sudoers before user files, including the executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-uninstall-"))
    temporaryPaths.push(root)
    const target = paths(root)
    await mkdir(target.wrapperDir, { recursive: true })
    await mkdir(join(root, "config", "rootine"), { recursive: true })
    for (const path of [target.dialogWrapperFile, target.silentWrapperFile, target.executableFile, target.silentHelperFile, target.sudoersFile, target.configFile]) await Bun.write(path, "installed\n")

    const result = await runUninstall({
      paths: target,
      sudo: "/usr/bin/sudo",
      confirm: async () => true,
      run: async (command, args) => {
        expect(command).toBe("/usr/bin/sudo")
        expect(args).toEqual(["/usr/bin/rm", "-f", target.sudoersFile, target.silentHelperFile])
        expect(await Bun.file(target.dialogWrapperFile).exists()).toBe(true)
        await Promise.all([rm(target.sudoersFile, { force: true }), rm(target.silentHelperFile, { force: true })])
        return { exitCode: 0, stderr: "" }
      },
      log: () => undefined,
    })

    expect(result.status).toBe("applied")
    for (const path of [target.dialogWrapperFile, target.silentWrapperFile, target.executableFile, target.silentHelperFile, target.sudoersFile, target.configFile]) expect(await Bun.file(path).exists()).toBe(false)
  })

  test("keeps user files when sudoers removal fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rootine-uninstall-"))
    temporaryPaths.push(root)
    const target = paths(root)
    await mkdir(target.wrapperDir, { recursive: true })
    for (const path of [target.dialogWrapperFile, target.executableFile, target.silentHelperFile, target.sudoersFile]) await Bun.write(path, "installed\n")

    await expect(runUninstall({ paths: target, sudo: "/usr/bin/sudo", confirm: async () => true, run: async () => ({ exitCode: 1, stderr: "denied" }), log: () => undefined })).rejects.toThrow("sudoers/helper removal failed")
    expect(await Bun.file(target.dialogWrapperFile).exists()).toBe(true)
    expect(await Bun.file(target.executableFile).exists()).toBe(true)
  })
})
