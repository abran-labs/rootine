import { describe, expect, test } from "bun:test"
import { setupHint, shouldRunSetup } from "../scripts/postinstall"

describe("postinstall onboarding", () => {
  test("runs for a global install on linux with a terminal and polkit", () => {
    expect(shouldRunSetup({ cwd: "/tmp/global-install", linux: true, tty: true, pkexec: true, skipEnv: undefined })).toBe(true)
  })

  test("skips inside the repo, off linux, without a terminal, without polkit, or with the skip env", () => {
    expect(shouldRunSetup({ cwd: "/home/abran/Dev/tools/rootine", linux: true, tty: true, pkexec: true, skipEnv: undefined })).toBe(false)
    expect(shouldRunSetup({ cwd: "/tmp/x", linux: false, tty: true, pkexec: true, skipEnv: undefined })).toBe(false)
    expect(shouldRunSetup({ cwd: "/tmp/x", linux: true, tty: false, pkexec: true, skipEnv: undefined })).toBe(false)
    expect(shouldRunSetup({ cwd: "/tmp/x", linux: true, tty: true, pkexec: false, skipEnv: undefined })).toBe(false)
    expect(shouldRunSetup({ cwd: "/tmp/x", linux: true, tty: true, pkexec: true, skipEnv: "1" })).toBe(false)
  })

  test("hints explain why onboarding was skipped", () => {
    expect(setupHint({ cwd: "/tmp/x", linux: false, tty: true, pkexec: true })).toContain("Linux only")
    expect(setupHint({ cwd: "/tmp/x", linux: true, tty: true, pkexec: false })).toContain("polkit is missing")
    expect(setupHint({ cwd: "/tmp/x", linux: true, tty: false, pkexec: true })).toContain("no terminal")
  })
})
