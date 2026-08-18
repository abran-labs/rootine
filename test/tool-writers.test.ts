import { describe, expect, test } from "bun:test"
import { PROMPT_MARKER_END, PROMPT_MARKER_START } from "../src/assets"
import { replaceSection } from "../src/tool-writers"

const section = `${PROMPT_MARKER_START}\n\n# Privileged commands\n\nline one\n\n${PROMPT_MARKER_END}\n`

describe("agent prompt section replacement", () => {
  test("appends to an empty file", () => {
    const replaced = replaceSection("", section)
    expect(replaced).toContain(PROMPT_MARKER_START)
    expect(replaced).toContain("line one")
  })

  test("appends after existing content", () => {
    const replaced = replaceSection("# Existing rules\n\nRule body\n", section)
    expect(replaced.indexOf("Rule body")).toBeLessThan(replaced.indexOf(PROMPT_MARKER_START))
    expect(replaced).toContain("line one")
  })

  test("replaces an existing marked section idempotently", () => {
    const withSection = replaceSection("# Existing\n", section)
    const newSection = `${PROMPT_MARKER_START}\n\n# Privileged commands\n\nline two\n\n${PROMPT_MARKER_END}\n`
    const replaced = replaceSection(withSection, newSection)
    expect(replaced).toContain("line two")
    expect(replaced).not.toContain("line one")
    expect(replaced.indexOf("line two")).toBeGreaterThan(replaced.indexOf("# Existing"))
    expect(replaceSection(replaced, newSection)).toBe(replaced)
  })

  test("removes a marked section and preserves surrounding content", () => {
    const withSection = replaceSection("before\n", section)
    const removed = replaceSection(withSection, "")
    expect(removed).toBe("before\n")
  })

  test("removing a section that is absent leaves the file unchanged", () => {
    const source = "# plain file\n"
    expect(replaceSection(source, "")).toBe(source)
  })
})
