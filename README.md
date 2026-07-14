<img src="assets/scion-logo.svg" alt="" width="64" height="64" />

# Scion

A tiny, standalone tool for orchestrating **Claude Code** agents across
isolated git worktrees. No Docker, Postgres, Electric, Caddy, or cloud account.
Everything lives under `~/.scion/`. The web UI binds to **localhost only** by
default (see [Security](#security)).

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

## Security

The web UI is a full control surface — over it you can spawn agents, drive any
live agent's terminal, delete workspaces, and read worktree files — and agents
run auto-approving (the worktree is the safety boundary, not per-action
prompts). So access is locked down by default:

- **Default — localhost only.** With zero config, both the backend (`5177`) and
  the Vite dev server (`5173`) bind to `127.0.0.1`. Nobody on your LAN can reach
  them, and no token is needed (same-machine trust).
- **LAN/remote access is opt-in and authenticated.** Start with
  `SCION_HOST=0.0.0.0 bun run web` (or a specific interface IP) to expose it.
  Scion then generates a shared-secret token at `~/.scion/web-token` (printed on
  startup) and requires it on every API call and WebSocket — including the
  terminal socket. Open the UI once as `http://<host>:5177/?token=<token>` to
  hand the browser the token.

The `Origin`/CORS check is defense-in-depth only, not a security boundary. Full
details: [Web Guide → Security model](docs/WEB_GUIDE.md#3a-security-model--localhost-by-default).

## What it doesn't do

PTYs don't survive an app restart (no background daemon); no PR review, cloud
sync, or multi-agent presets. **Run one front end at a time** — the terminal UI
and the web UI are separate processes, each with its own in-memory PTY table,
so an agent started in one isn't visible/attachable from the other. See
`~/.scion/host.db` for persisted state.
