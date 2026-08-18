# Project rules

- Use Bun: `bun test`, `bun run typecheck`, and `bun run build` are required gates.
- Tests must use fakes and temporary paths; never write to `/etc`, real `~/.config`, or a
  real wrapper path, and never spawn real pkexec dialogs.
- Never disclose, log, or commit credentials.
- Generated output (`node_modules/`, `dist/`, coverage) is not source; do not commit it.
