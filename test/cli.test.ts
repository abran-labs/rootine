import { describe, expect, test } from "bun:test"
import { parseArgs, RootineCliError } from "../src/index"

describe("rootine CLI args", () => {
  test("mode flags map directly to modes", () => {
    expect(parseArgs(["setup", "--always-allow"])).toEqual({ kind: "setup", mode: "always-allow", yes: false })
    expect(parseArgs(["setup", "--review", "--yes"])).toEqual({ kind: "setup", mode: "review", yes: true })
    expect(parseArgs(["setup", "--always-ask"])).toEqual({ kind: "setup", mode: "always-ask", yes: false })
  })

  test("no mode flag means interactive mode selection", () => {
    expect(parseArgs(["setup", "--yes"])).toEqual({ kind: "setup", yes: true })
    expect(parseArgs(["setup"])).toEqual({ kind: "setup", yes: false })
  })

  test("rejects multiple or unknown mode flags", () => {
    expect(() => parseArgs(["setup", "--always-allow", "--review"])).toThrow(RootineCliError)
    expect(() => parseArgs(["setup", "--mode", "review"])).toThrow(RootineCliError)
    expect(() => parseArgs(["setup", "--bogus"])).toThrow(RootineCliError)
  })

  test("doctor and uninstall take only --yes", () => {
    expect(parseArgs(["doctor"])).toEqual({ kind: "doctor" })
    expect(parseArgs(["uninstall", "--yes"])).toEqual({ kind: "uninstall", yes: true })
    expect(() => parseArgs(["uninstall", "--always-allow"])).toThrow(RootineCliError)
  })
})
