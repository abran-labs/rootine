import { expect, test } from "bun:test"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binary, checksum, installerFixture, payload } from "./installer-fixture"

test("prints bootstrap feedback before first downloader and keeps pipes quiet", async () => {
  // Given
  await using fixture = await installerFixture()
  // When
  const result = await fixture.run()
  // Then
  expect(result.code).toBe(0)
  expect(result.requests.split("\n")[0]).toBe("feedback")
  expect(result.requests).not.toContain("--progress-bar")
  expect(await readFile(fixture.target, "utf8")).toBe(payload)
  expect(await Bun.file(join(fixture.home, "args")).exists()).toBe(false)
})

test("reuses checksum-matching executable with only manifest request", async () => {
  // Given
  await using fixture = await installerFixture()
  await fixture.cache()
  // When
  const result = await fixture.run({ FAIL_ASSET: binary })
  // Then
  expect(result.code).toBe(0)
  expect(result.requests.match(/file:\/\//g)).toHaveLength(1)
  expect(result.requests).toContain("/v-test/SHA256SUMS")
})

test.each(["wrong bytes", "non-executable"])("replaces %s cached target", async (condition) => {
  // Given
  await using fixture = await installerFixture()
  await fixture.cache(condition === "wrong bytes" ? "obsolete" : payload, condition === "non-executable" ? 0o644 : 0o755)
  // When
  const result = await fixture.run()
  // Then
  expect(result.code).toBe(0)
  expect(result.requests.match(/file:\/\//g)).toHaveLength(2)
  expect(await readFile(fixture.target, "utf8")).toBe(payload)
})

const valid = `${checksum(payload)}  ${binary}\n`
test.each([
  ["missing", `${checksum(payload)}  unrelated\n`],
  ["malformed hash", `nope  ${binary}\n`],
  ["duplicate", valid + valid],
  ["extra field", `${checksum(payload)}  ${binary} extra\n`],
  ["suffix filename", `${checksum(payload)}  other-${binary}\n`],
  ["malformed gzip", valid + `nope  ${binary}.gz\n`],
  ["duplicate gzip", valid + `${checksum(payload)}  ${binary}.gz\n`.repeat(2)],
])("fails closed for %s manifest", async (_name, manifest) => {
  // Given
  await using fixture = await installerFixture()
  await fixture.cache()
  await fixture.manifest(manifest)
  // When
  const result = await fixture.run()
  // Then
  expect(result.code).not.toBe(0)
  expect(await readFile(fixture.target, "utf8")).toBe(payload)
  expect(result.requests.match(/file:\/\//g)).toHaveLength(1)
})

test.each(["SHA256SUMS", binary])("fails closed when %s fetch fails", async (asset) => {
  // Given
  await using fixture = await installerFixture()
  await fixture.cache("obsolete")
  // When
  const result = await fixture.run({ FAIL_ASSET: asset })
  // Then
  expect(result.code).not.toBe(0)
  expect(await readFile(fixture.target, "utf8")).toBe("obsolete")
})

test("rejects corrupted raw download without replacing target", async () => {
  // Given
  await using fixture = await installerFixture()
  await fixture.cache("obsolete")
  await writeFile(join(fixture.release, binary), "corrupted")
  // When
  const result = await fixture.run()
  // Then
  expect(result.code).not.toBe(0)
  expect(await readFile(fixture.target, "utf8")).toBe("obsolete")
})

test.each(["valid", "compressed mismatch", "decompressed mismatch", "invalid gzip", "fetch failure"])("verifies gzip roundtrip: %s", async (condition) => {
  // Given
  await using fixture = await installerFixture()
  await fixture.cache("obsolete")
  const compressed = condition === "invalid gzip" ? new TextEncoder().encode("invalid") : Bun.gzipSync(payload)
  await writeFile(join(fixture.release, `${binary}.gz`), compressed)
  const rawHash = condition === "decompressed mismatch" ? checksum("wrong") : checksum(payload)
  const gzipHash = condition === "compressed mismatch" ? checksum("wrong") : checksum(compressed)
  await fixture.manifest(`${rawHash}  ${binary}\n${gzipHash}  ${binary}.gz\n`)
  // When
  const result = await fixture.run(condition === "fetch failure" ? { FAIL_ASSET: `${binary}.gz` } : {})
  // Then
  expect(result.code === 0).toBe(condition === "valid")
  expect(result.requests).toContain(`/v-test/${binary}.gz`)
  expect(await readFile(fixture.target, "utf8")).toBe(condition === "valid" ? payload : "obsolete")
})

test("ignores gzip filename lookalikes and downloads legacy raw asset", async () => {
  // Given
  await using fixture = await installerFixture()
  await fixture.manifest(valid + `${checksum(payload)}  ${binary}.gz.extra\n`)
  // When
  const result = await fixture.run()
  // Then
  expect(result.code).toBe(0)
  expect(result.requests).not.toContain(`${binary}.gz`)
  expect(await readFile(fixture.target, "utf8")).toBe(payload)
})

test("shows TTY progress and passes setup argument plus version environment", async () => {
  // Given
  await using fixture = await installerFixture()
  // When
  const result = await fixture.run({ ROOTINE_NO_ONBOARD: "0" }, true)
  // Then
  expect(result.code).toBe(0)
  expect(result.requests).toContain("--progress-bar")
  expect(await readFile(join(fixture.home, "args"), "utf8")).toBe("setup\n")
  expect(await readFile(join(fixture.home, "version"), "utf8")).toBe("v-test")
})

test("release builder preserves raw binaries and includes verified gzip assets", async () => {
  // Given: real packaging script, fake compiler and ELF inspector.
  await using fixture = await installerFixture()
  const scripts = join(fixture.root, "scripts")
  const compiler = join(fixture.root, "cache/rootine/bun-test-linux-x64-baseline/bun")
  const inspector = join(fixture.root, "tools/readelf")
  const out = join(fixture.root, "artifacts")
  await mkdir(scripts)
  await mkdir(join(compiler, ".."), { recursive: true })
  await writeFile(join(fixture.root, "package.json"), '{"packageManager": "bun@test"}\n')
  await writeFile(join(scripts, "build-release.sh"), await readFile(join(import.meta.dir, "../scripts/build-release.sh")))
  await writeFile(compiler, '#!/bin/sh\nwhile [ "$1" != --outfile ]; do shift; done\ncp "$PAYLOAD" "$2"\n')
  await writeFile(inspector, '#!/bin/sh\necho GLIBC_2.17\n')
  await Promise.all([chmod(compiler, 0o755), chmod(inspector, 0o755)])
  // When
  const build = Bun.spawn(["sh", join(scripts, "build-release.sh"), out], {
    env: { ...process.env, HOME: fixture.home, XDG_CACHE_HOME: join(fixture.root, "cache"), PATH: `${fixture.root}/tools:/usr/bin:/bin`, PAYLOAD: join(fixture.release, binary) },
    stdout: "ignore", stderr: "pipe",
  })
  const stderr = await new Response(build.stderr).text()
  const code = await build.exited
  // Then
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  for (const name of [binary, "rootine-linux-arm64"]) {
    expect(await readFile(join(out, name), "utf8")).toBe(payload)
    expect(new TextDecoder().decode(Bun.gunzipSync(await readFile(join(out, `${name}.gz`))))).toBe(payload)
  }
  const verify = Bun.spawn(["sha256sum", "-c", "SHA256SUMS"], { cwd: out, stdout: "pipe", stderr: "pipe" })
  const verified = await new Response(verify.stdout).text()
  expect(await verify.exited).toBe(0)
  expect(verified.match(/: OK/g)).toHaveLength(4)
})
