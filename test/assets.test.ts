import { describe, expect, test } from "bun:test"
import { agentPrompt, polkitRuleSource, PROMPT_MARKER_END, PROMPT_MARKER_START, wrapperScript } from "../src/assets"
import { parseConfig, RootineConfigError } from "../src/config"

describe("rootine config", () => {
  test("round-trips a valid config", () => {
    const config = parseConfig({ version: 1, mode: "review", allowlist: ["/usr/bin/journalctl"] })
    expect(config).toEqual({ version: 1, mode: "review", allowlist: ["/usr/bin/journalctl"] })
  })

  test("rejects malformed config", () => {
    for (const value of [{}, { version: 1, mode: "yolo" }, { version: 2, mode: "always-ask" }, { version: 1, mode: "always-ask", allowlist: ["relative"] }, "nope", null]) {
      expect(() => parseConfig(value)).toThrow(RootineConfigError)
    }
  })
})

describe("polkit rule generation", () => {
  test("always-ask generates no rule", () => {
    expect(polkitRuleSource({ version: 1, mode: "always-ask", allowlist: [] }, "abran")).toBeUndefined()
  })

  test("always-allow grants exec for the user only", () => {
    const source = polkitRuleSource({ version: 1, mode: "always-allow", allowlist: [] }, "abran")
    expect(source).toContain('action.id !== "org.freedesktop.policykit.exec"')
    expect(source).toContain('subject.user !== "abran"')
    expect(source).toContain("polkit.Result.YES")
  })

  test("review allowlists exact program paths", () => {
    const source = polkitRuleSource({ version: 1, mode: "review", allowlist: ["/usr/bin/journalctl", "/usr/bin/systemctl"] }, "abran")
    expect(source).toContain('var allowlist = ["/usr/bin/journalctl", "/usr/bin/systemctl"]')
    expect(source).toContain('allowlist.indexOf(action.lookup("program")) === -1')
  })
})

describe("agent prompt sections", () => {
  test("carries markers and mode guidance", () => {
    const section = agentPrompt("always-ask", [])
    expect(section).toContain(PROMPT_MARKER_START)
    expect(section).toContain(PROMPT_MARKER_END)
    expect(section).toContain("polkit approval dialog")
    expect(section).toContain("never `sudo` or raw `pkexec`")
  })

  test("review mode lists the allowlist and the fallback", () => {
    const section = agentPrompt("review", ["/usr/bin/journalctl"])
    expect(section).toContain("/usr/bin/journalctl")
    expect(section).toContain("always-allow list run without a dialog")
  })

  test("always-allow warns that nothing prompts", () => {
    expect(agentPrompt("always-allow", [])).toContain("No approval dialog will appear")
  })
})

describe("wrapper script", () => {
  test("is argv-only and forwards to pkexec with the session agent only", () => {
    const script = wrapperScript()
    expect(script).toContain("exec pkexec --disable-internal-agent \"$@\"")
    expect(script).toContain("exit 2")
  })
})
