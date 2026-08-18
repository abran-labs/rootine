import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type RootinePaths = {
  readonly configFile: string
  readonly wrapperDir: string
  readonly wrapperFile: string
  readonly ruleFile: string
  readonly opencodeAgentFile: string
  readonly claudeAgentFile: string
}

export function rootinePaths(environment: Readonly<Record<string, string | undefined>>): RootinePaths {
  const home = environment["HOME"] ?? homedir()
  const configHome = environment["XDG_CONFIG_HOME"] ?? join(home, ".config")
  const wrapperDir = join(home, ".local", "bin")
  return {
    configFile: join(configHome, "rootine", "config.json"),
    wrapperDir,
    wrapperFile: join(wrapperDir, "px"),
    ruleFile: "/etc/polkit-1/rules.d/10-rootine.rules",
    opencodeAgentFile: join(configHome, "opencode", "AGENTS.md"),
    claudeAgentFile: join(home, ".claude", "CLAUDE.md"),
  }
}

export function configDirectory(paths: RootinePaths): string {
  return dirname(paths.configFile)
}
