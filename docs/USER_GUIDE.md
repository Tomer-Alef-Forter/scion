# Scion — User Guide

A tiny terminal UI for running **multiple Claude Code agents in parallel**, each
on its own git branch inside an isolated worktree. Think of it as a little
control tower: launch an agent with a task, let it work, then review, diff, and
merge — all without ever touching your main checkout.

It's a stripped-down, local-only clone of [Superset](https://superset.sh): no
Docker, Postgres, cloud account, or auth. Everything lives under
`~/.scion/`.

There's also a browser-based [Web Guide](./WEB_GUIDE.md) — same engine,
same underlying state, a second front end with live terminals, a diff viewer,
and a file browser.

---

## 1. What it gives you

- **Parallel agents, zero collisions.** Every task runs in a separate git
  worktree on its own branch (`~/.scion/worktrees/<projectId>/<branch>`),
  so five agents can edit "the same repo" at once without stepping on each other
  or on your working tree.
- **A live status dashboard.** See at a glance which agents are working, which
  are blocked waiting for input, and which have finished and need review.
- **Attach / detach like tmux.** Jump into any agent's terminal to steer it,
  then detach and leave it running.
- **Review before you keep anything.** Diff a worktree against its base branch,
  then merge it back into your main checkout — or throw it away.
- **Nothing hidden.** All state is a single SQLite file (`~/.scion/host.db`)
  and plain worktrees on disk.

---

## 2. Requirements

- **Node 18+** — the app runs under Node via `tsx`. (Not Bun: `node-pty` and
  `better-sqlite3` need native bindings that don't load under Bun.)
- A package manager: `bun`, `npm`, or `pnpm`
- `git` and `gh`
- The `claude` CLI, already logged in
- `less` (for the diff viewer) and a `$EDITOR` / VS Code (for "open") — optional

---

## 3. Install & run

```bash
cd ~/Projects/superset-local
bun install           # or: npm install
bun run db:generate   # once — produces the SQLite migrations
bun start             # runs `tsx src/index.tsx` under Node
```

On **first run** it sets up status reporting automatically:

- Writes `~/.scion/hooks/notify.sh`
- Merges Claude Code lifecycle hooks into `~/.claude/settings.json`
  (**merged, not clobbered** — your existing hooks are preserved)

That's what lets the dashboard show live agent status. A localhost receiver
listens on port **48791** for those hook events.

---

## 4. The three screens

The whole app is keyboard-driven. There are three screens: **Projects →
Dashboard → New workspace**, plus two full-screen modes (attach, diff).

### 4.1 Projects screen

The repos you've registered.

| Key       | Action                          |
|-----------|---------------------------------|
| `↑` / `↓` | Move selection                  |
| `a`       | Add a git repo (type its path)  |
| `enter`   | Open the project's dashboard    |
| `x`       | Remove project (from list only) |
| `q`       | Quit                            |

When adding, type a repo path — `~` is expanded, so `~/dev/analytics` works.

### 4.2 Dashboard (workspaces)

One row per workspace. Each row shows: **status** · **name** · **(branch ·
diff summary)**, e.g.:

```
❯ [review]    fix-login-bug (feat/fix-login-bug-a8f3 · 3f +42/-7 · 1 uncommitted)
  [working]   add-tests    (add-tests-9k2p · 1f +18/-0)
```

The diff summary is `<files>f +<insertions>/-<deletions>`, plus a count of
uncommitted files if any. It refreshes on a slow tick.

| Key       | Action                                                       |
|-----------|-------------------------------------------------------------|
| `↑` / `↓` | Move selection                                              |
| `n`       | New workspace (creates worktree + branch, launches `claude`)|
| `enter`   | Attach to the selected agent's terminal                     |
| `d`       | Diff the worktree vs its base branch (opens `less -R`)      |
| `m`       | Merge the branch back into its base                         |
| `o`       | Open the worktree in your editor (VS Code)                  |
| `x`       | Remove the worktree (keeps the branch)                      |
| `b` / esc | Back to Projects                                            |
| `q`       | Quit                                                        |

### 4.3 New workspace

Type a plain-English task. Scion then:

1. Generates a branch name from your task (e.g. `my-new-feature-a8f3`),
   deduplicating if it collides.
2. Creates a branch + worktree off the base branch
   (`git worktree add --no-track -b <branch> <path> <base>`).
3. Records the base branch in git config so diff/merge can find it later.
4. Launches `claude` in that worktree, seeded with your task prompt.

`enter` to create, `esc` to cancel.

---

## 5. Agent status

The colored `[label]` in each dashboard row is derived from Claude Code
lifecycle hook events:

| Status       | Meaning                                                        |
|--------------|---------------------------------------------------------------|
| `starting`   | Terminal is live but no agent event received yet              |
| `working`    | A turn is running                                             |
| `waiting`    | Agent hit a permission request — **it needs your input**      |
| `review`     | Turn finished and you haven't looked yet — **ready to review**|
| `idle`       | Turn finished and you've already attached/seen it             |
| `done`       | No live terminal (session ended)                              |

`review` flips to `idle` once you attach (that marks the workspace "seen").

---

## 6. Typical workflow

1. **Add your repo** on the Projects screen (`a`, type the path, `enter`).
2. **Open it** (`enter`) to reach the dashboard.
3. **Spin up a task** (`n`, describe it, `enter`). Repeat `n` for parallel work.
4. **Let them run.** Watch the status column; `waiting` means an agent is
   blocked on a permission and needs you.
5. **Attach** (`enter`) to steer an agent. Detach with **`Ctrl-b` then `d`** —
   the agent keeps running.
6. **Review** finished work: `d` to read the diff.
7. **Keep it** with `m` (merge back into base) or **discard** with `x`.

---

## 7. Attach & diff modes

**Attach** is a raw tmux-style passthrough. It clears the screen, replays the
agent's scrollback, and forwards your keystrokes straight to the agent. The one
special sequence is the detach chord: **`Ctrl-b` then `d`**. (Press `Ctrl-b`
followed by any other key and both are forwarded to the agent as normal.)

**Diff** renders the worktree's colored diff vs its base branch in `less -R`
(`q` to quit `less`). If `less` isn't installed, it just prints the diff.

Both modes unmount the UI while active and redraw it when you return.

---

## 8. Merging back

Pressing `m` merges the workspace branch into its base branch, in your **main
repo checkout**:

- It **refuses if the worktree has uncommitted changes** — commit or discard
  them first.
- Otherwise it checks out the base branch and runs `git merge --no-ff <branch>`.
- On conflict it **aborts the merge and restores your previous branch**, leaving
  the main repo clean. You then resolve manually.

> Note: this merges **locally**. It does not open or merge a PR (real Superset
> merges via `gh pr merge`; that's out of scope here).

---

## 9. Where things live

| Path                                   | What it is                              |
|----------------------------------------|-----------------------------------------|
| `~/.scion/host.db`                     | SQLite: projects, workspaces, bindings  |
| `~/.scion/worktrees/<proj>/`           | One worktree per workspace              |
| `~/.scion/hooks/notify.sh`             | Status-reporting hook                    |
| `~/.scion/.installed`                  | First-run marker (timestamp)            |
| `~/.claude/settings.json`              | Where the lifecycle hooks are merged in |

---

## 10. Limitations (vs real Superset)

- **PTYs don't survive an app restart** — there's no background daemon. Quitting
  the app ends running agent terminals. Worktrees, branches, and DB state
  persist; the live sessions do not.
- No PR review, no cloud sync, no multi-agent presets, no GUI.
- `x` on the dashboard removes the **worktree** but keeps the branch. `x` on
  Projects removes the project from the list only — it doesn't touch your repo.

---

## 11. Troubleshooting

- **Dashboard shows `starting` forever / no live status.** The Claude hooks
  aren't firing. Confirm `~/.scion/hooks/notify.sh` exists and is
  executable, and that `~/.claude/settings.json` contains a hook command
  referencing `hooks/notify.sh`. Re-run `bun start` to reinstall them.
- **"No running agent to attach (session ended)."** The PTY is gone — usually
  because the app was restarted (see Limitations). Start a new workspace.
- **Merge says "uncommitted changes."** Attach and commit (or discard) inside
  the worktree, then press `m` again.
- **Native module errors on start.** You're likely on Bun — run under Node
  (`bun start` already invokes `tsx` under Node, so use the provided scripts
  rather than `bun src/index.tsx`).
- **Add-project fails.** The path must be an existing git repository. `~` is
  expanded; make sure the path resolves.
```

