import type { Mode } from "./config"
import { polkitProblems, polkitRemediationSteps, probeDependencies, type RootineDependencyReport } from "./deps"
import { RootineSetupError } from "./install"

export async function remediatePolkit(input: {
  readonly mode?: Mode
  readonly report: RootineDependencyReport
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly confirm: (label: string) => Promise<boolean>
  readonly run: (command: string, args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stderr: string }>
  readonly log: (line: string) => void
  readonly probe?: (environment: Readonly<Record<string, string | undefined>>) => Promise<RootineDependencyReport>
}): Promise<RootineDependencyReport> {
  const probe = input.probe ?? probeDependencies
  let report = input.report
  for (;;) {
    const problems = polkitProblems(report, input.mode)
    if (problems.length === 0) return report
    const steps = polkitRemediationSteps(report)
    if (steps.length === 0) throw new RootineSetupError(`cannot remediate automatically: ${problems.join("; ")}`)
    const before = JSON.stringify(report)
    for (const step of steps) {
      if (!(await input.confirm(step.label))) throw new RootineSetupError(`polkit remediation declined: ${step.label}`)
      input.log(`-> ${step.label}`)
      const result = await input.run(step.command, step.args)
      if (result.exitCode !== 0) throw new RootineSetupError(`${step.label} failed: ${result.stderr.trim() || "see output above"}`)
      if (step.startNow !== undefined) {
        input.log(`-> starting the polkit authentication agent: ${[step.startNow.command, ...step.startNow.args].join(" ")}`)
        const started = await input.run(step.startNow.command, step.startNow.args)
        if (started.exitCode !== 0) throw new RootineSetupError(`could not start the polkit authentication agent: ${started.stderr.trim() || "see output above"}`)
      }
    }
    report = await probe(input.environment)
    if (JSON.stringify(report) === before) throw new RootineSetupError(`polkit remediation made no progress: ${problems.join("; ")}`)
  }
}
