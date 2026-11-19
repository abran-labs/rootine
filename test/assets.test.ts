import { describe, expect, test } from "bun:test"
import { agentPrompt, dialogWrapperScript, PROMPT_MARKER_END, PROMPT_MARKER_START, silentHelperScript, silentWrapperScript, sudoersFileSource } from "../src/assets"
import { parseConfig, RootineConfigError } from "../src/config"
import { polkitProblems, polkitRemediationSteps, type RootineDependencyReport } from "../src/deps"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("rootine config", () => {
  test("round-trips a valid config", () => {
    expect(parseConfig({ version: 1, mode: "review" })).toEqual({ version: 1, mode: "review" })
  })

  test("rejects malformed config", () => {
    for (const value of [{}, { version: 1, mode: "yolo" }, { version: 2, mode: "always-ask" }, "nope", null]) {
      expect(() => parseConfig(value)).toThrow(RootineConfigError)
    }
  })
})

describe("wrappers", () => {
  test("px always asks through pkexec with the session agent", () => {
    expect(dialogWrapperScript()).toContain('exec pkexec --disable-internal-agent "$@"')
    expect(dialogWrapperScript()).toContain("exit 2")
  })

  test("sx never asks and goes through sudo", () => {
    expect(silentWrapperScript()).toContain('exec sudo -- /usr/local/libexec/rootine-sx "$@"')
    expect(silentWrapperScript()).toContain("NO approval dialog")
  })

  test("root-owned sx helper executes argv without a shell", () => {
    expect(silentHelperScript()).toContain('exec "$@"')
  })
})

describe("sudoers entry", () => {
  test("grants NOPASSWD only for the sx helper", () => {
    expect(sudoersFileSource("abran")).toContain("abran ALL=(root) NOPASSWD: /usr/local/libexec/rootine-sx *\n")
    expect(sudoersFileSource("abran")).not.toContain("NOPASSWD: ALL")
    expect(sudoersFileSource("abran")).toContain("Managed by rootine")
  })
})

describe("agent prompt sections", () => {
  test("carries markers and wrapper discipline", () => {
    const section = agentPrompt("always-ask")
    expect(section).toContain(PROMPT_MARKER_START)
    expect(section).toContain(PROMPT_MARKER_END)
    expect(section).toContain("never raw `sudo` or raw `pkexec`")
  })

  test("always-ask routes everything through the dialog wrapper", () => {
    const section = agentPrompt("always-ask")
    expect(section).toContain("`px <exe> [args...]`")
    expect(section).not.toContain("`sx <exe> [args...]`")
    expect(section).toContain("polkit approval dialog")
  })

  test("review tells the agent when each wrapper applies", () => {
    const section = agentPrompt("review")
    expect(section).toContain("Use `sx <exe> [args...]` when the operation is routine and safe")
    expect(section).toContain("Use `px <exe> [args...]` when the operation is sensitive or destructive")
    expect(section).toContain("When unsure, use `px`")
  })

  test("always-allow routes everything through the silent wrapper", () => {
    const section = agentPrompt("always-allow")
    expect(section).toContain("Use `sx <exe> [args...]` for everything")
    expect(section).toContain("no dialog will appear")
  })
})

describe("macOS", () => {
  test("px asks through the native administrator dialog, never pkexec", () => {
    const script = dialogWrapperScript("darwin")
    expect(script).toContain("with administrator privileges")
    expect(script).toContain("/usr/bin/osascript -e 'on run argv'")
    expect(script).not.toContain("pkexec")
  })

  test("px preserves argv, stdout, stderr, and exit status", async () => {
    // Given the darwin px with a fake osascript that runs its script argument unprivileged.
    const root = await mkdtemp(join(tmpdir(), "rootine-px-darwin-"))
    try {
      const osascript = join(root, "osascript")
      await writeFile(osascript, '#!/bin/sh\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 })
      await writeFile(join(root, "px"), dialogWrapperScript("darwin", osascript), { mode: 0o755 })
      const args = ["x", "it's", "a b", "$(id)", '"q"', "multi\nline", "", "\\"]
      // When
      const child = Bun.spawn([join(root, "px"), "/bin/sh", "-c", 'printf "[%s]" "$@"; echo err >&2; exit 7', "sh", ...args], { env: { PATH: "/usr/bin:/bin", TMPDIR: root }, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      // Then
      expect({ code, stdout, stderr }).toEqual({ code: 7, stdout: args.map((arg) => `[${arg}]`).join(""), stderr: "err\n" })
      expect((await readdir(root)).sort()).toEqual(["osascript", "px"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prompt names the macOS dialog instead of polkit", () => {
    expect(agentPrompt("always-ask", "darwin")).toContain("macOS administrator dialog")
    expect(agentPrompt("always-ask", "darwin")).not.toContain("polkit")
    expect(agentPrompt("review", "darwin")).not.toContain("polkit")
  })

  test("polkit never blocks macOS; osascript does", () => {
    const mac: RootineDependencyReport = { platform: "darwin", polkit: { pkexec: undefined, polkitd: false, agent: false, packageManager: "unknown" }, osascript: "/usr/bin/osascript", sudo: "/usr/bin/sudo", desktop: "" }
    expect(polkitProblems(mac, "review")).toEqual([])
    expect(polkitProblems({ ...mac, osascript: undefined }, "always-ask")[0]).toContain("osascript is missing")
    expect(polkitProblems({ ...mac, osascript: undefined }, "always-allow")).toEqual([])
    expect(polkitRemediationSteps(mac)).toEqual([])
  })
})
