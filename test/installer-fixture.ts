import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

export const binary = "rootine-linux-x64"
export const payload = '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/args"\nprintf "%s" "$ROOTINE_VERSION" > "$HOME/version"\n'
export const checksum = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex")

export async function installerFixture() {
  const root = await mkdtemp(join(tmpdir(), "rootine-installer-test-"))
  const home = join(root, "home")
  const release = join(root, "releases", "v-test")
  const tools = join(root, "tools")
  const output = join(root, "output")
  const requests = join(root, "requests")
  const target = join(home, ".local/bin/rootine")
  await Promise.all([mkdir(release, { recursive: true }), mkdir(tools), mkdir(join(home, ".local/bin"), { recursive: true })])
  await writeFile(join(release, binary), payload)
  await writeFile(join(release, "SHA256SUMS"), `${checksum(payload)}  ${binary}\n`)
  await writeFile(join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
  await writeFile(join(tools, "curl"), `#!/bin/sh
set -eu
if [ -s "$OUTPUT" ]; then echo feedback >> "$REQUESTS"; else echo silent >> "$REQUESTS"; fi
printf '%s\\n' "$*" >> "$REQUESTS"
for arg do
  case "$arg" in */"\${FAIL_ASSET:-never}") exit 22;; esac
done
exec /usr/bin/curl "$@"
`)
  await Promise.all([chmod(join(tools, "uname"), 0o755), chmod(join(tools, "curl"), 0o755)])
  return {
    root, home, release, target,
    async manifest(contents: string) { await writeFile(join(release, "SHA256SUMS"), contents) },
    async cache(contents = payload, mode = 0o755) { await writeFile(target, contents); await chmod(target, mode) },
    async run(overrides: Readonly<Record<string, string>> = {}, tty = false) {
      const command = `sh "$INSTALLER" > "$OUTPUT" 2>&1`
      const child = Bun.spawn(tty ? ["script", "-qec", 'sh "$INSTALLER"', output] : ["sh", "-c", command], {
        env: { ...process.env, HOME: home, TMPDIR: root, PATH: `${tools}:/usr/bin:/bin`, ROOTINE_VERSION: "v-test", ROOTINE_BASE_URL: `file://${root}/releases`, ROOTINE_NO_ONBOARD: "1", INSTALLER: join(import.meta.dir, "../install.sh"), OUTPUT: output, REQUESTS: requests, ...overrides },
        stdin: "ignore", stdout: "ignore", stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      const code = await child.exited
      return { code, stderr, output: await readFile(output, "utf8"), requests: await Bun.file(requests).text() }
    },
    async [Symbol.asyncDispose]() { await rm(root, { recursive: true, force: true }) },
  }
}
