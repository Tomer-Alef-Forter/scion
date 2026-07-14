# Restarting Scion & picking up code changes

Scion runs as two decoupled parts:

- A **front end** — the terminal UI (`bun start`) or the web server + Vite
  (`bun run web:dev` / `bun run web`).
- A **daemon** (`src/daemon/index.ts`) that owns every live agent's PTY. It is
  auto-spawned the first time a front end needs a PTY and **deliberately
  outlives the front end**, so restarting the terminal UI or web server never
  kills a running agent.

## Why a front-end restart isn't enough after a code change

Because the daemon is decoupled and long-lived, stopping and relaunching the
front end **does not** restart the daemon. Node/`tsx` loads code at process
start and does not hot-reload, so a daemon that was already running keeps
executing the code it started with.

Anything that runs in the daemon therefore stays on the old code until the
daemon itself is restarted — including hook handling, per-session **token-usage
parsing**, scoped agent shutdown, and the crash-survival machinery. If you pull
new code and only restart the front end, daemon-side features will look
"missing" even though the code is on disk.

Symptom to watch for: the front end (new code) calls an endpoint the old daemon
doesn't implement, or a hook event is accepted (`last_event_type` updates) but a
daemon-side side effect (e.g. token counts) never happens.

## Default restart (single-process daemon)

Run from a terminal **other than** an agent session — restarting the daemon
kills the PTYs it owns.

```bash
cd <scion repo>

# 1. Stop the front end
pkill -f "scripts/web-dev.ts"; pkill -f "tsx src/server/index.ts"

# 2. Stop the daemon (it survives step 1 on its own — kill it explicitly)
pkill -f "src/daemon/index.ts"

# 3. Relaunch; the front end auto-spawns a fresh daemon on new code
bun run web:dev
```

In this mode a daemon crash or restart ends every live agent's PTY. Worktrees,
branches, and DB state are untouched, but the live terminal is gone.

## Crash-survivable restart (supervisor / PTY-host mode, opt-in)

In this mode a durable **PTY host** (`src/daemon/ptyHost.ts`) owns the PTY master
fds, and the daemon is only a thin proxy in front of it. A daemon crash/restart
then leaves the agents running inside the host; the supervisor respawns the
daemon and front ends reconnect and re-attach (scrollback is replayed). This
makes restarting the daemon to pick up new code a non-event for running agents.

```bash
cd <scion repo>

# 1. Stop any existing front end and daemon
pkill -f "scripts/web-dev.ts"; pkill -f "tsx src/server/index.ts"; pkill -f "src/daemon/index.ts"

# 2. Start the supervisor FIRST — it launches the PTY host, then a proxy daemon
#    on the standard socket. (Backgrounded; logs under ~/.scion.)
nohup bun run supervisor > ~/.scion/supervisor.console.log 2>&1 &
sleep 2 && tail -5 ~/.scion/supervisor.console.log   # expect "PTY host ready" then "starting daemon"

# 3. Start the front end — it attaches to the supervised daemon already on the
#    socket instead of spawning a plain one
bun run web:dev
```

Notes and limitations:

- This is fully opt-in and gated on the `SCION_PTY_HOST_SOCK` env var, which the
  supervisor sets on the daemon it spawns. Nothing here runs unless you launch
  the supervisor. The default single-process path is unchanged.
- **Only sessions started under the supervisor are protected.** A PTY created by
  a plain daemon lives inside that daemon's process and cannot be adopted by a
  host after the fact — so an already-running session cannot be carried across
  the switch to supervisor mode.
- The **PTY host becomes the single point of failure**: if it dies, its agents
  die. That is a much narrower surface than the whole daemon, but it is not
  zero. Pure-Node fd-passing (`SCM_RIGHTS`) of a PTY master is infeasible — a TTY
  handle can't be serialized over IPC — which is why a durable peer process holds
  the fds instead.

## Verifying you're on new code

```bash
# Which processes are up:
pgrep -fl "supervisor.ts|ptyHost.ts|src/daemon/index.ts|tsx src/server/index.ts"

# Functional check for a daemon-side feature (token usage): in a Claude
# workspace, send a prompt and let the turn fully finish, then look for the
# "· N tokens" badge on that workspace's card. It stays hidden until a turn
# has completed (turn_count > 0) and only appears for Claude agents.
```

After any restart, hard-refresh the browser tab so the web client isn't left on
a stale hot-reloaded state pointed at a freshly restarted backend.
