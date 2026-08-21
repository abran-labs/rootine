import { describe, expect, test } from "bun:test"
import { agentPrompt, dialogWrapperScript, PROMPT_MARKER_END, PROMPT_MARKER_START, silentHelperScript, silentWrapperScript, sudoersFileSource } from "../src/assets"
import { parseConfig, RootineConfigError } from "../src/config"

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
