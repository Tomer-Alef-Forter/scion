# Contributing to Scion

Thanks for helping improve Scion. This guide covers local setup, the layout of
the code, and what a good change looks like.

## Prerequisites

- **Node 20+** (the app runs under Node via `tsx`, not Bun — `node-pty` and
  `better-sqlite3` need native bindings that don't load under Bun)
- `bun` (or `npm`/`pnpm`) to install dependencies
- `git`, `gh`, and the `claude` CLI (logged in)

## Setup

```bash
bun install
bun install --cwd web       # the web/ frontend is its own package
bun run db:generate         # once, to produce the SQLite migrations
bun run doctor              # preflight: Node/git/gh/claude + native bindings
```

If `doctor` reports the `better-sqlite3` binding failing to load, run
`npm rebuild better-sqlite3` — this happens when deps are installed under Bun
but run under Node.

## Running

```bash
./scion.sh            # web UI, dev mode (hot-reload) — the default
./scion.sh prod       # web UI, built once, served on port 5177
./scion.sh tui        # terminal UI
```

Or the underlying scripts directly: `bun run web:dev`, `bun run web`,
`bun start`. See the [User Guide](docs/USER_GUIDE.md) and
[Web Guide](docs/WEB_GUIDE.md) for usage, and
[docs/RESTARTING.md](docs/RESTARTING.md) for how the daemon relates to the
front ends when you're iterating on code.

## Testing

Everything CI runs, you can run locally:

```bash
bun run typecheck             # tsc --noEmit (root)
bun run --cwd web exec tsc --noEmit   # or: cd web && bunx tsc --noEmit
bun run test                  # unit tests (Vitest) — root + web
bun run smoke                 # end-to-end smoke (isolated $HOME, real fs)
bun run daemon-smoke          # daemon lifecycle
bun run persistence-smoke     # PTY-survives-daemon-restart (supervisor mode)
```

- **Unit tests** are fast and hermetic (no real PTYs, CLIs, or sockets) — put
  new pure-logic tests next to the code as `*.test.ts`.
- **Smoke suites** spawn real processes under a throwaway `$HOME`; use them for
  anything that touches the DB, PTYs, or the hook pipeline.
- A schema change **must** ship with its generated migration — run
  `bun run db:generate` and commit the result, or CI's drift check fails.

## Architecture (where things live)

| Path | What |
|---|---|
| `src/engine/` | Core logic: agent presets/argv, worktree + workspace creation, diff/PR/status, token usage. Pure and unit-tested where possible. |
| `src/daemon/` | The PTY daemon (owns every agent's terminal), its socket protocol, and the opt-in supervisor/pty-host for crash survival. |
| `src/server/` | Hono HTTP + WebSocket backend (the web UI's API), auth, and the hook receiver. |
| `src/store/` | SQLite-backed project/workspace persistence (Drizzle). |
| `src/ui/` | The Ink terminal UI. |
| `src/setup/` | First-run install of Claude Code hooks + `notify.sh`. |
| `web/` | The React/Vite web UI (its own package). |
| `drizzle/` | Generated SQLite migrations — never hand-edit; regenerate. |
| `scripts/` | Dev/ops scripts (smoke suites, doctor, restart-daemon, hook uninstall). |

## Pull requests

- Branch off `main`; keep changes focused.
- CI (`.github/workflows/ci.yml`) must pass: typecheck, unit tests, web build,
  migration-drift check, and the smoke suites.
- Match the surrounding code's style (tabs, double quotes, existing naming).
- Update the relevant doc (`README.md`, `docs/*.md`) when behavior changes, and
  add a `CHANGELOG.md` entry under **Unreleased**.
- Never commit secrets, build output, or local scratch files (`node_modules/`,
  `dist/`, `*.log`, and `exp*.mjs`/`package-lock.json` are gitignored).

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please do not open a public issue for
vulnerabilities.
