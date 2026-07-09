# superset-local

A tiny, standalone terminal UI for orchestrating **Claude Code** agents across
isolated git worktrees — a stripped-down, local-only clone of
[Superset](https://superset.sh). No Docker, Postgres, Electric, Caddy, auth, or
cloud account. Everything lives under `~/.superset-local/`.

It reuses logic copied from Superset (`packages/host-service`, `packages/shared`,
the Claude-hook status scheme) but has **no dependency on the Superset monorepo**.

## Requirements

- **Node 18+** (runtime; the app runs under Node via `tsx`)
- A package manager to install deps — `bun`, `npm`, or `pnpm`
- `git`, `gh`
- The `claude` CLI, already logged in

> Why Node and not Bun? `node-pty` (which spawns the agent terminals) and
> `better-sqlite3` both rely on native bindings that don't load under Bun today,
> so the app runs under Node — the same stack Superset's host-service uses.

## Run

```bash
bun install           # or: npm install
bun run db:generate   # once, to produce the SQLite migrations
bun start             # runs `tsx src/index.tsx` (Node runtime)
```

First run installs Claude Code lifecycle hooks into `~/.claude/settings.json`
(merged, not clobbered) and writes `~/.superset-local/hooks/notify.sh`, so the
dashboard can show live agent status.

## Usage

- **Projects**: `a` add a git repo, `enter` open, `x` remove, `q` quit.
- **Dashboard**: `n` new workspace (creates a worktree + branch and launches
  `claude` with your task prompt), `enter` attach to the agent's terminal
  (`Ctrl-b d` to detach), `d` diff vs base, `m` merge branch back into base,
  `o` open worktree in VS Code, `x` remove worktree, `b` back.

Agent status: `working` (turn running) · `waiting` (needs input) · `review`
(turn finished, unseen) · `idle` · `starting` · `done`.

## What it doesn't do (vs real Superset)

PTYs don't survive app restart (no background daemon); no PR review, cloud sync,
multi-agent presets, or GUI. See `~/.superset-local/host.db` for persisted state.
