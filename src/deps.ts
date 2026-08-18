export type PolkitStatus = {
  readonly pkexec: string | undefined
  readonly polkitd: boolean
  readonly agent: boolean
  readonly packageManager: "pacman" | "apt" | "dnf" | "zypper" | "unknown"
}

export type RootineDependencyReport = {
  readonly linux: boolean
  readonly polkit: PolkitStatus
}

export async function probeDependencies(): Promise<RootineDependencyReport> {
  const [pkexec, agent, polkitd, packageManager] = await Promise.all([Bun.which("pkexec"), probePolkitAgent(), probePolkitd(), detectPackageManager()])
  return {
    linux: process.platform === "linux",
    polkit: { pkexec: pkexec ?? undefined, polkitd, agent, packageManager },
  }
}

export function polkitInstallCommand(report: RootineDependencyReport): string | undefined {
  switch (report.polkit.packageManager) {
    case "pacman":
      return "sudo pacman -S --needed polkit"
    case "apt":
      return "sudo apt install -y polkitd pkexec"
    case "dnf":
      return "sudo dnf install -y polkit"
    case "zypper":
      return "sudo zypper install -y polkit"
    default:
      return undefined
  }
}

export function polkitProblems(report: RootineDependencyReport): readonly string[] {
  const problems: string[] = []
  if (!report.linux) problems.push("rootine supports Linux only")
  if (!report.linux) return problems
  if (report.polkit.pkexec === undefined) problems.push("pkexec is missing (install polkit)")
  else if (!report.polkit.polkitd) problems.push("polkitd is not running")
  if (report.polkit.pkexec !== undefined && !report.polkit.agent) problems.push("no polkit authentication agent detected in this session; the approval dialog will not appear (desktop sessions need a polkit agent)")
  return problems
}

async function probeProcess(pattern: string): Promise<boolean> {
  // The [x] character-class trick keeps the pattern from matching this probe's own shell.
  try {
    const child = Bun.spawn(["pgrep", "-f", `[${pattern[0]}]${pattern.slice(1)}`], { stdout: "pipe", stderr: "ignore" })
    const output = await new Response(child.stdout).text()
    await child.exited
    return output.trim().length > 0
  } catch {
    return false
  }
}

// A polkit agent registers on the session bus; its process name varies
// (aperture, hyprpolkitagent, polkit-gnome-authentication-agent-1, ...).
// Prefer busctl so any agent is seen regardless of its binary name.
async function probePolkitAgent(): Promise<boolean> {
  try {
    const child = Bun.spawn(["busctl", "--user", "list"], { stdout: "pipe", stderr: "ignore" })
    const output = await new Response(child.stdout).text()
    const exitCode = await child.exited
    if (exitCode === 0 && /polkit|policykit|authenticator/i.test(output)) return true
  } catch {
    // fall through to process-name patterns
  }
  for (const pattern of ["polkit.*agent", "aperture", "hyprpolkitagent"]) {
    if (await probeProcess(pattern)) return true
  }
  return false
}

async function probePolkitd(): Promise<boolean> {
  try {
    const child = Bun.spawn(["pgrep", "-x", "polkitd"], { stdout: "pipe", stderr: "ignore" })
    const output = await new Response(child.stdout).text()
    await child.exited
    return output.trim().length > 0
  } catch {
    return false
  }
}

async function detectPackageManager(): Promise<PolkitStatus["packageManager"]> {
  const candidates = (await Promise.all(["pacman", "apt", "dnf", "zypper"].map(async (name) => Bun.which(name) === null ? undefined : name))).filter((name): name is "pacman" | "apt" | "dnf" | "zypper" => name !== undefined)
  return candidates[0] ?? "unknown"
}
