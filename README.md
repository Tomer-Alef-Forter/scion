<img src="assets/scion-logo.svg" alt="" width="64" height="64" />

# Scion

A tiny, standalone tool for orchestrating **Claude Code** agents across
isolated git worktrees. No Docker, Postgres, Electric, Caddy, auth, or
cloud account. Everything lives under `~/.scion/`.

Two front ends over the same engine:
- A **terminal UI** (`bun start`) — see the [User Guide](docs/USER_GUIDE.md).
- A **web UI** (`bun run web:dev`) — live terminals, a status dashboard, diffs,
  and a file browser in the browser. See the [Web Guide](docs/WEB_GUIDE.md).

MIT licensed — see [LICENSE](LICENSE).

## Requirements

- **Node 18+** (runtime; the app runs under Node via `tsx`)
- A package manager to install deps — `bun`, `npm`, or `pnpm`
- `git`, `gh`
- The `claude` CLI, already logged in

> Why Node and not Bun? `node-pty` (which spawns the agent terminals) and
> `better-sqlite3` both rely on native bindings that don't load under Bun today,
> so the app runs under Node.

## Run

```bash
bun install           # or: npm install
bun run db:generate   # once, to produce the SQLite migrations
```

Then pick a front end:

```bash
bun start             # terminal UI — runs `tsx src/index.tsx` (Node runtime)

bun run web:dev        # web UI, development — backend + Vite dev server (HMR)
bun run web            # web UI, production   — builds once, serves everything on one port
```

First run (either front end) installs Claude Code lifecycle hooks into
`~/.claude/settings.json` (merged, not clobbered) and writes
`~/.scion/hooks/notify.sh`, so the dashboard can show live agent status.

Full usage: [User Guide](docs/USER_GUIDE.md) (terminal UI) ·
[Web Guide](docs/WEB_GUIDE.md) (web UI).

Agent status: `working` (turn running) · `waiting` (needs input) · `review`
(turn finished, unseen) · `idle` · `starting` · `done`.

## Testing

Unit tests ([Vitest](https://vitest.dev)) cover pure logic — argv building,
branch/slug naming, the path-traversal guard on the file browser, the daemon's
binary frame protocol, and the web terminal's WebSocket reconnect/backoff:

```bash
bun run test        # runs both suites below (root + web)
bun run test:watch  # root suite only, in watch mode
```

Under the hood this is two separate Vitest configs, since `web/` is its own
package with its own dependencies: `vitest.config.ts` (Node environment, for
`src/**/*.test.ts`) and `web/vitest.config.ts` (jsdom, for
`web/src/**/*.test.ts`, run via `bun run --cwd web test`).

These are hermetic and sub-second — no real PTY, CLI process, or network
socket involved (WebSockets are faked, timers are mocked). For end-to-end
coverage of the parts that do spawn real processes (the hook→status pipeline,
the web UI, the daemon), see the manual smoke scripts instead:
`bun run smoke`, `bun run web:smoke`, `bun run daemon-smoke`.

## What it doesn't do

PTYs don't survive an app restart (no background daemon); no PR review, cloud
sync, or multi-agent presets. **Run one front end at a time** — the terminal UI
and the web UI are separate processes, each with its own in-memory PTY table,
so an agent started in one isn't visible/attachable from the other. See
`~/.scion/host.db` for persisted state.
