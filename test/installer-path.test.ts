import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { installerFixture } from "./installer-fixture"

test.each([".bash_profile", ".bash_login", ".profile"])("configures bashrc and effective login file %s without sourcing contents", async (profile) => {
  // Given
  await using fixture = await installerFixture()
  const original = 'printf executed > "$HOME/sourced"\n# preserved without final newline'
  await writeFile(join(fixture.home, profile), original)
  await writeFile(join(fixture.home, ".bashrc"), original)
  if (profile !== ".profile") await writeFile(join(fixture.home, ".profile"), "# lower priority\n")
  // When
  const result = await fixture.run({ SHELL: "/bin/bash" })
  // Then
  expect(result.code).toBe(0)
  for (const file of [profile, ".bashrc"]) {
    const content = await readFile(join(fixture.home, file), "utf8")
    expect(content.startsWith(`${original}\n`)).toBe(true)
    expect(content).toContain('"$HOME/.local/bin')
    expect(content).not.toContain(fixture.home)
  }
  expect(await Bun.file(join(fixture.home, "sourced")).exists()).toBe(false)
  if (profile !== ".profile") expect(await readFile(join(fixture.home, ".profile"), "utf8")).toBe("# lower priority\n")
})

test("creates bash login fallback and keeps repeated installation byte-identical", async () => {
  // Given
  await using fixture = await installerFixture()
  expect((await fixture.run({ SHELL: "/bin/bash" })).code).toBe(0)
  const files = [".bashrc", ".profile"]
  const before = await Promise.all(files.map((file) => readFile(join(fixture.home, file), "utf8")))
  // When
  const result = await fixture.run({ SHELL: "/bin/bash" })
  // Then
  expect(result.code).toBe(0)
  expect(await Promise.all(files.map((file) => readFile(join(fixture.home, file), "utf8")))).toEqual(before)
})

test.each(["", "/bin/sh"])("uses POSIX profile fallback for shell %s", async (shell) => {
  // Given
  await using fixture = await installerFixture()
  // When
  const result = await fixture.run({ SHELL: shell })
  // Then
  expect(result.code).toBe(0)
  expect(await Bun.file(join(fixture.home, ".profile")).exists()).toBe(true)
  expect(await Bun.file(join(fixture.home, ".bashrc")).exists()).toBe(false)
})

test.each([false, true])("configures zsh startup files with custom ZDOTDIR=%s", async (custom) => {
  // Given
  await using fixture = await installerFixture()
  const directory = custom ? join(fixture.home, "zsh config") : fixture.home
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, ".zshrc"), "# existing zsh\n")
  // When
  const result = await fixture.run({ SHELL: "/usr/bin/zsh", ZDOTDIR: custom ? directory : "" })
  // Then
  expect(result.code).toBe(0)
  expect(await readFile(join(directory, ".zshrc"), "utf8")).toStartWith("# existing zsh\n")
  expect(await readFile(join(directory, ".zprofile"), "utf8")).toContain('"$HOME/.local/bin')
  expect(await Bun.file(join(fixture.home, ".profile")).exists()).toBe(false)
})

test("leaves startup configuration untouched when target is already in PATH", async () => {
  // Given
  await using fixture = await installerFixture()
  await writeFile(join(fixture.home, ".bashrc"), "# original\n")
  // When
  const result = await fixture.run({ SHELL: "/bin/bash", PATH: `${fixture.root}/tools:${fixture.home}/.local/bin:/usr/bin:/bin` })
  // Then
  expect(result.code).toBe(0)
  expect(await readFile(join(fixture.home, ".bashrc"), "utf8")).toBe("# original\n")
  expect(await Bun.file(join(fixture.home, ".profile")).exists()).toBe(false)
})

test("exports PATH for child setup while explaining parent terminal remains unchanged", async () => {
  // Given
  await using fixture = await installerFixture()
  const parentPath = process.env["PATH"]
  // When
  const result = await fixture.run({ SHELL: "/bin/bash", ROOTINE_NO_ONBOARD: "0" }, true)
  // Then
  expect(result.code).toBe(0)
  expect((await readFile(join(fixture.home, "setup-path"), "utf8")).split(":")[0]).toBe(`${fixture.home}/.local/bin`)
  expect(process.env["PATH"]).toBe(parentPath)
  expect(result.output).toMatch(/new shell|reconnect/i)
  expect(result.output).toMatch(/current terminal.*unchanged/i)
})

test("explicitly reports fish unsupported without writing POSIX configuration", async () => {
  // Given
  await using fixture = await installerFixture()
  // When
  const result = await fixture.run({ SHELL: "/usr/bin/fish" })
  // Then
  expect(result.code).toBe(0)
  expect(result.output).toMatch(/fish.*not supported/i)
  expect(await Bun.file(join(fixture.home, ".profile")).exists()).toBe(false)
  expect(await Bun.file(join(fixture.home, ".config/fish/config.fish")).exists()).toBe(false)
})

test("generated profile expands quoted HOME at startup and avoids duplicate PATH entries", async () => {
  // Given
  await using fixture = await installerFixture()
  await fixture.run()
  const home = join(fixture.root, "home with 'quotes' $cash")
  const profile = join(fixture.home, ".profile")
  // When: run only the generated fixture profile, never user configuration.
  const child = Bun.spawn(["/bin/sh", "-c", '. "$PROFILE"; . "$PROFILE"; printf "%s" "$PATH"'], {
    env: { HOME: home, PATH: "/usr/bin:/bin", PROFILE: profile }, stdout: "pipe", stderr: "pipe",
  })
  const path = await new Response(child.stdout).text()
  // Then
  expect(await child.exited).toBe(0)
  expect(path).toBe(`${home}/.local/bin:/usr/bin:/bin`)
})

test("a new interactive Bash shell finds rootine after installation", async () => {
  // Given an ordinary bashrc with its noninteractive early return.
  await using fixture = await installerFixture()
  const bashrc = join(fixture.home, ".bashrc")
  await writeFile(bashrc, 'case $- in *i*) ;; *) return ;; esac\n')
  expect((await fixture.run({ SHELL: "/bin/bash" })).code).toBe(0)
  // When a fresh interactive Bash session reads the configured startup file.
  const child = Bun.spawn(["/bin/bash", "--noprofile", "--rcfile", bashrc, "-ic", "command -v rootine"], {
    env: { HOME: fixture.home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "ignore",
  })
  const command = await new Response(child.stdout).text()
  // Then the installed command is found without a manual PATH edit.
  expect(await child.exited).toBe(0)
  expect(command.trim()).toBe(fixture.target)
})
