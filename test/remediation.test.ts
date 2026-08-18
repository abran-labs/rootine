import { describe, expect, test } from "bun:test"
import type { RootineDependencyReport } from "../src/deps"
import { remediatePolkit } from "../src/install"

const healthy: RootineDependencyReport = {
  linux: true,
  polkit: { pkexec: "/usr/bin/pkexec", polkitd: true, agent: true, packageManager: "pacman" },
  sudo: "/usr/bin/sudo",
  desktop: "Hyprland",
}

const broken: RootineDependencyReport = {
  linux: true,
  polkit: { pkexec: undefined, polkitd: false, agent: false, packageManager: "pacman" },
  sudo: "/usr/bin/sudo",
  desktop: "Hyprland",
}

describe("polkit remediation", () => {
  test("does nothing when polkit is complete", async () => {
    const calls: string[] = []
    const report = await remediatePolkit({
      report: healthy,
      environment: {},
      confirm: async () => true,
      run: async (command, args) => { calls.push([command, ...args].join(" ")); return { exitCode: 0, stderr: "" } },
      log: () => undefined,
      probe: async () => healthy,
    })
    expect(report).toBe(healthy)
    expect(calls).toEqual([])
  })

  test("installs polkit, starts polkitd, installs and starts the agent, and persists autostart", async () => {
    const calls: string[] = []
    const environment = { HOME: "/tmp/rootine-remediate-home" }
    const report = await remediatePolkit({
      report: broken,
      environment,
      confirm: async () => true,
      run: async (command, args) => { calls.push([command, ...args].join(" ")); return { exitCode: 0, stderr: "" } },
      log: () => undefined,
      probe: async () => healthy,
    })
    expect(report).toBe(healthy)
    expect(calls).toContain("/usr/bin/sudo pacman -S --needed --noconfirm polkit")
    expect(calls).toContain("/usr/bin/sudo systemctl enable --now polkit")
    expect(calls).toContain("/usr/bin/sudo pacman -S --needed --noconfirm hyprpolkitagent")
    expect(calls).toContain("/usr/bin/setsid -f /usr/bin/hyprpolkitagent")
    expect(await Bun.file(`${environment["HOME"]}/.config/hypr/hyprland.conf`).text()).toContain("exec-once = hyprpolkitagent")
  })

  test("fails when there is nothing left to try", async () => {
    const hopeless: RootineDependencyReport = { ...broken, sudo: undefined, desktop: "unknown-desktop" }
    await expect(
      remediatePolkit({
        report: hopeless,
        environment: {},
        confirm: async () => true,
        run: async () => ({ exitCode: 0, stderr: "" }),
        log: () => undefined,
        probe: async () => hopeless,
      }),
    ).rejects.toThrow("cannot remediate automatically")
  })
})
