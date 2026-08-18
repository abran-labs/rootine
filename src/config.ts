export const MODES = ["always-allow", "review", "always-ask"] as const
export type Mode = (typeof MODES)[number]

export type RootineConfig = {
  readonly version: 1
  readonly mode: Mode
  readonly allowlist: readonly string[]
}

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

export function parseConfig(value: unknown): RootineConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RootineConfigError("rootine config must be an object")
  const record = value as Readonly<Record<string, unknown>>
  if (record["version"] !== 1) throw new RootineConfigError("rootine config version must be 1")
  if (!isMode(record["mode"])) throw new RootineConfigError(`mode must be one of ${MODES.join(", ")}`)
  const allowlist = record["allowlist"]
  if (!Array.isArray(allowlist) || allowlist.some((entry) => typeof entry !== "string" || !entry.startsWith("/"))) {
    throw new RootineConfigError("allowlist must be an array of absolute program paths")
  }
  return { version: 1, mode: record["mode"], allowlist }
}

export class RootineConfigError extends Error {
  readonly name = "RootineConfigError"
}
