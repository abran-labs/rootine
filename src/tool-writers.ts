import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { PROMPT_MARKER_END, PROMPT_MARKER_START } from "./assets"

export type PromptTarget = "opencode" | "claude"

export type PromptWriteResult = {
  readonly path: string
  readonly changed: boolean
}

export async function writeAgentPrompt(path: string, section: string): Promise<PromptWriteResult> {
  await mkdir(dirname(path), { recursive: true })
  const existing = await readIfPresent(path)
  const replaced = replaceSection(existing, section)
  if (replaced === existing) return { path, changed: false }
  await writeFile(path, replaced, { mode: existing === "" ? 0o600 : undefined })
  return { path, changed: true }
}

export async function removeAgentPrompt(path: string): Promise<PromptWriteResult> {
  const existing = await readIfPresent(path)
  if (existing === "") return { path, changed: false }
  const replaced = replaceSection(existing, "")
  if (replaced === existing) return { path, changed: false }
  if (replaced.trim() === "") {
    await Bun.file(path).delete()
    return { path, changed: true }
  }
  await writeFile(path, replaced)
  return { path, changed: true }
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
    throw error
  }
}

export function replaceSection(source: string, section: string): string {
  const start = source.indexOf(PROMPT_MARKER_START)
  if (start < 0) return section.length === 0 ? source : appendSection(source, section)
  const end = source.indexOf(PROMPT_MARKER_END, start)
  const sectionEnd = end < 0 ? source.length : end + PROMPT_MARKER_END.length
  return joinText(source.slice(0, start), source.slice(sectionEnd), section)
}

function appendSection(source: string, section: string): string {
  return joinText(source, "", section)
}

function joinText(before: string, after: string, section: string): string {
  const trimmedBefore = before.replace(/\s+$/, "")
  const trimmedAfter = after.replace(/^\s+/, "")
  const parts = [trimmedBefore, section.length === 0 ? "" : section.trim(), trimmedAfter].filter((part) => part.length > 0)
  if (parts.length === 0) return ""
  return parts.join("\n\n") + "\n"
}
