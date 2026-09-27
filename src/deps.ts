import type { Mode } from "./config"

export type PolkitStatus = {
  readonly pkexec: string | undefined
  readonly polkitd: boolean
  readonly agent: boolean
  readonly packageManager: "pacman" | "apt" | "dnf" | "zypper" | "unknown"
}

export type RootineDependencyReport = {
  readonly linux: boolean
  readonly polkit: PolkitStatus
  readonly sudo: string | undefined
  readonly desktop: string
}

export type RemediationStep = {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly startNow?: { readonly command: string; readonly args: readonly string[] }
}

export function polkitRemediationSteps(report: RootineDependencyReport): readonly RemediationStep[] {
  if (!report.linux) return []
  const steps: RemediationStep[] = []
  if (report.polkit.pkexec === undefined && report.sudo !== undefined) {
    steps.push({ label: `install polkit (${report.polkit.packageManager})`, command: report.sudo, args: installArgs(report.polkit.packageManager, "polkit") })
  }
  if (!report.polkit.polkitd && report.sudo !== undefined) {
    steps.push({ label: "enable and start polkitd", command: report.sudo, args: ["systemctl", "enable", "--now", "polkit"] })
  }
  if (!report.polkit.agent && report.sudo !== undefined) {
    const agentPackage = agentPackageForDesktop(report.desktop)
    if (agentPackage !== undefined) {
      const startNow = agentStartForDesktop(report.desktop)
      steps.push({
        label: `install a polkit authentication agent (${agentPackage})`,
        command: report.sudo,
        args: installArgs(report.polkit.packageManager, agentPackage),
        ...(startNow === undefined ? {} : { startNow }),
      })
    }
  }
  return steps
}

// hyprpolkitagent ships a systemd user unit: enable --now persists across
// sessions, starts it immediately, and restarts it if it crashes — better
// than an exec-once line in hyprland.conf.
export function agentStartForDesktop(desktop: string): { readonly command: string; readonly args: readonly string[] } | undefined {
  const name = desktop.toLowerCase()
  if (name.includes("hypr")) return { command: "systemctl", args: ["--user", "enable", "--now", "hyprpolkitagent.service"] }
  if (name.includes("kde") || name.includes("plasma")) return { command: "/usr/bin/setsid", args: ["-f", "/usr/lib/polkit-kde-authentication-agent-1"] }
  if (name.includes("gnome") || name.includes("ubuntu") || name.includes("cinnamon") || name.includes("xfce") || name.includes("mate") || name.includes("budgie") || name.includes("pantheon") || name.includes("unity")) return { command: "/usr/bin/setsid", args: ["-f", "/usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1"] }
  if (name.includes("sway") || name.includes("river")) return { command: "/usr/bin/setsid", args: ["-f", "/usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1"] }
  return undefined
}

export function agentPackageForDesktop(desktop: string): string | undefined {
  const name = desktop.toLowerCase()
  if (name.includes("hypr")) return "hyprpolkitagent"
  if (name.includes("kde") || name.includes("plasma")) return "polkit-kde-agent"
  if (name.includes("gnome") || name.includes("ubuntu") || name.includes("cinnamon") || name.includes("xfce") || name.includes("mate") || name.includes("budgie") || name.includes("pantheon") || name.includes("unity")) return "polkit-gnome"
  if (name.includes("sway") || name.includes("river")) return "polkit-gnome"
  return undefined
}

export async function probeDependencies(environment: Readonly<Record<string, string | undefined>> = process.env, mode: Mode = "review"): Promise<RootineDependencyReport> {
  if (mode === "always-allow") return {
    linux: process.platform === "linux",
    polkit: { pkexec: undefined, polkitd: false, agent: false, packageManager: "unknown" },
    sudo: Bun.which("sudo") ?? undefined,
    desktop: desktopName(environment),
  }
  const [pkexec, agent, polkitd, packageManager, sudo] = await Promise.all([Bun.which("pkexec"), probePolkitAgent(), probePolkitd(), detectPackageManager(), Bun.which("sudo")])
  return {
    linux: process.platform === "linux",
    polkit: { pkexec: pkexec ?? undefined, polkitd, agent, packageManager },
    sudo: sudo ?? undefined,
    desktop: desktopName(environment),
  }
}

function desktopName(environment: Readonly<Record<string, string | undefined>>): string {
  return environment["XDG_CURRENT_DESKTOP"] ?? environment["WAYLAND_DESKTOP"] ?? environment["XDG_SESSION_DESKTOP"] ?? ""
}

function installArgs(manager: PolkitStatus["packageManager"], packageName: string): readonly string[] {
  switch (manager) {
    case "pacman":
      return ["pacman", "-S", "--needed", "--noconfirm", packageName]
    case "apt":
      return ["apt", "install", "-y", packageName]
    case "dnf":
      return ["dnf", "install", "-y", packageName]
    case "zypper":
      return ["zypper", "--non-interactive", "install", packageName]
    default:
      return ["echo", `install ${packageName} with your package manager`]
  }
}

export function polkitProblems(report: RootineDependencyReport, mode: Mode = "review"): readonly string[] {
  const problems: string[] = []
  if (!report.linux) problems.push("rootine supports Linux only")
  if (!report.linux) return problems
  if (mode === "always-allow") return problems
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
