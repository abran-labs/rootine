import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { polkitProblems, type RootineDependencyReport } from "../src/deps"

const temporaryPaths: string[] = []
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const headless: RootineDependencyReport = {
  linux: true,
  sudo: "/usr/bin/sudo",
  desktop: "",
  polkit: { pkexec: undefined, polkitd: false, agent: false, packageManager: "apt" },
}

async function sandbox() {
  const visudo = Bun.which("visudo")
  if (visudo === null) throw new Error("CLI tests require visudo from the sudo package")
  const root = await mkdtemp(join(tmpdir(), "rootine-cli-"))
  temporaryPaths.push(root)
  const bin = join(root, "bin")
  const calls = join(root, "calls")
  await mkdir(bin)
  await writeFile(calls, "")
  for (const command of ["sudo", "visudo", "pgrep", "busctl"]) {
    const file = join(bin, command)
    // Privilege commands are inert; real visudo only validates the temporary policy.
    const action = command === "visudo" ? 'exec "$ROOTINE_TEST_VISUDO" "$@"' : `exit ${command === "sudo" ? 0 : 1}`
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$ROOTINE_TEST_CALLS"\n${action}\n`)
    await chmod(file, 0o755)
  }
  return {
    root,
    calls,
    env: { HOME: root, XDG_CONFIG_HOME: join(root, ".config"), PATH: bin, SHELL: "/bin/sh", TERM: "xterm-256color", ROOTINE_TEST_CALLS: calls, ROOTINE_TEST_VISUDO: visudo },
  }
}

describe("mode-aware dependencies", () => {
  test.each(["review", "always-ask"] as const)("%s still requires polkit on a headless host", (mode) => {
    // Given a headless report, when a dialog mode is checked, then missing pkexec blocks setup.
    expect(polkitProblems(headless, mode)).toContain("pkexec is missing (install polkit)")
  })

  test("always-allow still rejects non-Linux hosts", () => {
    // Given an unsupported platform, when silent mode is checked, then Linux remains required.
    expect(polkitProblems({ ...headless, linux: false }, "always-allow")).toEqual(["rootine supports Linux only"])
  })
})

describe("headless CLI", () => {
  test("noninteractive always-allow uses visudo from PATH without desktop probes", async () => {
    // Given isolated user paths and inert sudo, with no pkexec on PATH.
    const fixture = await sandbox()
    // When the real CLI runs its noninteractive setup.
    const child = Bun.spawn([process.execPath, "src/index.ts", "setup", "--always-allow", "--yes"], { env: fixture.env, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    // Then configuration is saved and only fake privilege-install commands were invoked.
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("mode: always-allow")
    expect(JSON.parse(await readFile(join(fixture.root, ".config/rootine/config.json"), "utf8"))).toEqual({ version: 1, mode: "always-allow" })
    const calls = (await readFile(fixture.calls, "utf8")).split("\n").filter(Boolean)
    expect(calls).toContain("visudo")
    expect(calls.every((call) => call === "sudo" || call === "visudo")).toBe(true)
  })

  test("mode selection appears before probes and interactive always-allow skips them", async () => {
    // Given a real pseudo-terminal with isolated files and fake system tools.
    const fixture = await sandbox()
    const child = Bun.spawn(["/usr/bin/script", "-qefc", `/usr/bin/stty cols 100 rows 30; exec ${process.execPath} src/index.ts setup`, "/dev/null"], { env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 2000 })
    let output = ""
    let callsAtPrompt: string | undefined
    try {
      // When selecting always-allow from the real interactive menu.
      for await (const chunk of child.stdout) {
        output += new TextDecoder().decode(chunk)
        if (callsAtPrompt === undefined && output.includes("Approval mode")) {
          callsAtPrompt = await readFile(fixture.calls, "utf8")
          child.stdin.write("\u001b[B\u001b[B\r")
        }
      }
      const code = await child.exited
      // Then the prompt preceded dependency work and no desktop probes ran afterward.
      expect({ code, output: code === 0 ? "" : output }).toEqual({ code: 0, output: "" })
      expect({ callsAtPrompt, output: callsAtPrompt === undefined ? output : "" }).toEqual({ callsAtPrompt: "", output: "" })
      expect(JSON.parse(await readFile(join(fixture.root, ".config/rootine/config.json"), "utf8"))).toEqual({ version: 1, mode: "always-allow" })
      expect((await readFile(fixture.calls, "utf8")).split("\n").filter(Boolean).every((call) => call === "sudo" || call === "visudo")).toBe(true)
    } finally {
      child.stdin.end()
      child.kill()
    }
  })

  test("doctor treats polkit as optional for configured always-allow", async () => {
    // Given a saved always-allow config on a headless system.
    const fixture = await sandbox()
    const config = join(fixture.root, ".config/rootine")
    await mkdir(config, { recursive: true })
    await writeFile(join(config, "config.json"), JSON.stringify({ version: 1, mode: "always-allow" }))
    // When running the real doctor command.
    const child = Bun.spawn([process.execPath, "src/index.ts", "doctor"], { env: fixture.env, stdout: "pipe", stderr: "pipe" })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    // Then optional polkit is neither probed nor diagnosed as a problem.
    expect(code).toBe(0)
    expect(stdout).toContain("problems: none")
    expect((await readFile(fixture.calls, "utf8")).split("\n").filter(Boolean).every((call) => call === "sudo")).toBe(true)
  })
})
