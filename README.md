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
These hooks are installed globally — `~/.claude/settings.json` applies to
every Claude Code session on the machine — but each installed command is a
no-op unless it's running inside a Scion-launched session, and is tagged
with a `# scion-managed hook` comment so it's identifiable at a glance.

To remove them: `bun run uninstall-hooks`. This deletes exactly the hook
entries Scion added (leaving any hooks you configured yourself untouched)
and removes `~/.scion/hooks/notify.sh`. It's safe to run more than once, and
the next `bun start` / `bun run web` reinstalls cleanly if you run it again
later.

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

A background daemon (auto-spawned the first time either front end needs a
PTY) owns every live agent process independently of the terminal UI and the
web server. That means **both front ends can run at once** against the same
`~/.scion/host.db`, a workspace started in one is attachable from the other,
and restarting either front end never kills a live agent. Real limitations
that remain:

- **A crash of the daemon itself still ends every live agent's process**
  (closing its socket SIGHUPs every PTY it owns) — worktrees, branches, and DB
  state are untouched, but the live terminal is gone and you'll resume rather
  than reattach. Surviving a daemon crash too would need real fd-passing, a
  separate effort.
- **No cloud sync** — everything lives in `~/.scion/host.db` and plain
  worktrees on disk, on one machine.
- **PR creation, not PR review.** The web UI can push a branch and open a
  GitHub PR via `gh` (one click); there's no in-app PR viewing/commenting/
  approval flow. Merging back (`m` / **Merge**) is always local, straight into
  your base branch.
- 7 agent CLI presets exist (Claude Code, Gemini CLI, Codex, Cursor Agent,
  Droid, OpenCode, GitHub Copilot), configurable as the default in the web
  UI's Settings — but only Claude Code reports live `working`/`waiting`/
  `review` status via lifecycle hooks; the others just show `working` for the
  life of the session.
