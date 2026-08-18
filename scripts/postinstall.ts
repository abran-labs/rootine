// Runs after `bun add -g rootine`. Starts the interactive `rootine setup` when the
// environment can support it; otherwise prints a pointer and exits cleanly so the
// package install itself never fails.
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const setupEntry = join(packageDir, "dist", "index.js")

export function shouldRunSetup(input: { readonly cwd: string; readonly linux: boolean; readonly tty: boolean; readonly pkexec: boolean; readonly skipEnv: string | undefined }): boolean {
  if (input.skipEnv === "1") return false
  if (existsSync(join(input.cwd, ".git"))) return false // dev install inside the repo
  return input.linux && input.tty && input.pkexec
}

export function setupHint(input: { readonly cwd: string; readonly linux: boolean; readonly tty: boolean; readonly pkexec: boolean }): string {
  if (existsSync(join(input.cwd, ".git"))) return "rootine dev install; skipping onboarding"
  if (!input.linux) return "rootine supports Linux only; skipping onboarding"
  if (!input.pkexec) return "polkit is missing; install it, then run `rootine setup`"
  return "no terminal available; run `rootine setup` to finish onboarding"
}

async function main(): Promise<void> {
  const pkexec = Bun.which("pkexec") !== null
  const state = { cwd: process.cwd(), linux: process.platform === "linux", tty: process.stdin.isTTY === true, pkexec }
  if (!shouldRunSetup({ ...state, skipEnv: process.env["ROOTINE_SKIP_ONBOARD"] })) {
    console.log(setupHint(state))
    return
  }
  console.log("rootine installed — starting setup…")
  const child = Bun.spawn([process.execPath, setupEntry, "setup"], { stdio: ["inherit", "inherit", "inherit"], cwd: packageDir })
  const exitCode = await child.exited
  if (exitCode !== 0) console.log("rootine setup finished with errors; rerun `rootine setup` anytime")
}

if (import.meta.main) await main()
