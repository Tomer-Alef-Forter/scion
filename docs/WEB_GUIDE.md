# Scion — Web Guide

A browser front end for Scion: a live control tower for **multiple
Claude Code agents in parallel**, each on its own git branch inside an
isolated worktree — with real windows, a mouse, live terminals, diffs, and a
file browser. It's a second, independent client of the exact same engine the
[terminal UI](./USER_GUIDE.md) uses.

---

## 1. What it gives you

Everything the terminal UI gives you, plus:

- **Real live terminals in the browser.** Click a workspace and get an
  actual, typeable `claude` session streamed over WebSocket — not a log
  viewer. Multiple browser tabs can watch the same terminal at once.
- **A pushed, not polled, status dashboard.** Cards update the instant an
  agent's status changes.
- **A proper diff viewer.** Syntax-highlighted, per-file, and each file's
  diff can be collapsed independently.
- **A read-only file browser.** Browse any file in the worktree — not just
  the ones that changed — with syntax highlighting.
- **Dark mode.** Follows your OS setting by default; toggle to override.

---

## 2. Requirements

Same as the [terminal UI](./USER_GUIDE.md#2-requirements), plus a browser.
No separate install — `bun install` at the repo root installs both front
ends' dependencies (the `web/` frontend is its own package with its own
`node_modules`, isolated because it runs React 19 while the terminal UI runs
React 18).

---

## 3. Install & run

```bash
cd ~/Projects/superset-local
bun install
bun run db:generate   # once — produces the SQLite migrations
```

Then, for **development** (hot-reloading frontend):

```bash
bun run web:dev
```

This starts the backend (port `5177`) and the Vite dev server (port `5173`)
together, with labeled output (`[server] …` / `[vite] …`). Open
**http://localhost:5173**.

Or, for a **single-port production-style run** (build once, no separate Vite
process):

```bash
bun run web
```

This builds `web/` and serves the built frontend from the *same* server as
the API — open **http://localhost:5177**.

Either way, first run installs Claude Code lifecycle hooks into
`~/.claude/settings.json` (merged, not clobbered) and writes
`~/.scion/hooks/notify.sh` — exactly like the terminal UI, since it's
the same setup step.

> **Run one front end at a time.** The terminal UI and the web UI are
> separate processes, each with its own in-memory table of live PTYs. A
> workspace's agent is only attachable from whichever process launched it.

---

## 4. The layout

Three columns: **Projects** (left) → **Workspaces** (middle) → a **detail
panel** (right) with **Terminal / Diff / Files** tabs for the selected
workspace.

### 4.1 Projects sidebar

- **+ Add project** — type a repo path (`~` is expanded) and submit.
- Click a project to select it; hover a project for a **✕** to remove it
  from the list (does not touch your repo).
- Gear icon opens **Settings** (see §4.6); sun/moon icon toggles dark mode.

### 4.2 Workspaces (middle column)

One card per workspace: a colored **status dot** (see §6), name, branch,
diff summary (`+insertions`/`-deletions`/`N uncommitted`), and a relative
timestamp. Click a card to open it — if its agent's session has ended,
clicking **resumes** it (see §7) instead of dead-ending.

**+ New** opens a modal — describe the task (optional — leave it blank to
launch with no seed prompt) and an optional custom name, submit, and Scion
creates a worktree + branch and launches whichever agent is set as default in
**Settings** (§4.6), then jumps straight to its live terminal. That agent
choice is captured onto the workspace at creation time — changing the
default afterward doesn't affect it.

### 4.3 Detail panel — Terminal tab

A real, live, typeable `claude` session, streamed over WebSocket. Type
directly into it. Resize the browser window and the PTY resizes too.
Reconnects automatically (with backoff) if the connection drops, and replays
scrollback so you don't lose context.

Header buttons above the tabs: **Merge** (into base branch), **Open** (in
whichever editor is set as default in Settings), **Delete** (remove the
worktree, keep the branch).

### 4.4 Detail panel — Diff tab

Shows the workspace's diff against its base branch, one section per changed
file. Click a file's header (chevron + filename + change type +
`+insertions`/`-deletions`) to **collapse or expand it independently** —
handy when several files changed and you only want to focus on one.

### 4.5 Detail panel — Files tab

A read-only file browser: a collapsible tree on the left (tracked files plus
untracked-but-not-gitignored ones — the same files `git status` would show
you), and a syntax-highlighted viewer on the right. Click any file to view
it. This covers *every* file in the worktree, not just changed ones — so
**Open** becomes a pure convenience rather than a necessity.

### 4.6 Settings

Gear icon in the sidebar header opens a global preferences modal:

- **Agent** — which CLI new workspaces launch: **Claude Code**, **Gemini
  CLI**, or **Codex**. Only Claude Code reports live status via its
  lifecycle hooks (§6) — the other two have no equivalent, so their
  workspaces just show **working** for the life of the session instead of
  distinguishing working/waiting/review.
- **Editor** — what **Open** launches: **VS Code**, **Cursor**, or **Zed**.

These are defaults for *new* workspaces only — each workspace keeps
whatever agent it was created with, even if you change the default later
(resuming a workspace relaunches the same agent it started with, not
today's default).

---

## 5. Typical workflow

1. **Add your repo** in the Projects sidebar.
2. **Create a task** (**+ New**, describe it, submit) — repeat for parallel
   work. Each gets its own card and live terminal.
3. **Watch the dashboard** — cards update live as agents work.
4. **Click a card** to jump into its terminal and steer it, or check the
   **Diff** tab to see what it's changed so far.
5. **Browse the Files tab** if you want to look at anything else in the
   worktree.
6. **Merge** when you're happy, or **Delete** to discard.

---

## 6. Agent status

Same state machine as the terminal UI:

| Status | Meaning |
|---|---|
| `starting` | Terminal is live but no agent event received yet |
| `working` | A turn is running |
| `waiting` | Agent hit a permission request — needs your input |
| `review` | Turn finished and unseen — ready to review |
| `idle` | Turn finished and seen (opening the terminal marks it seen) |
| `done` | No live terminal (session ended) |

---

## 7. Resuming a workspace

If you close the app (or it crashes) while an agent is running, that agent's
process ends — there's no background daemon keeping PTYs alive across a
restart. The workspace itself (worktree + branch) is untouched; only the live
terminal is gone.

Clicking a card with no live terminal **resumes** it: a fresh `claude` is
launched in the *same* worktree (no new worktree or branch), and if a prior
Claude `session_id` was captured from the lifecycle hook, it's passed via
`--resume` — continuing the same conversation rather than starting over.

---

## 8. Merging back

Same semantics as the terminal UI's `m` key: merges the workspace branch into
its base branch in your **main repo checkout**, refuses if the worktree has
uncommitted changes, and on conflict aborts the merge and restores your
previous branch — the main checkout is never left in a conflicted state.
Merge is **local only** (no PR).

---

## 9. Where things live

Same as the terminal UI — see
[User Guide §9](./USER_GUIDE.md#9-where-things-live). The web UI adds no new
state: it's a second client over the same `~/.scion/host.db` and
worktrees.

---

## 10. Limitations (vs real Superset, and vs the terminal UI)

- Everything in the terminal UI's
  [Limitations](./USER_GUIDE.md#10-limitations-vs-real-superset) applies here
  too (no PTY persistence across a restart, no PR review, no cloud sync, no
  multi-agent presets).
- **One front end at a time** — see the callout in §3.
- The file browser is **read-only** — editing is the agent's job.
- No mobile/responsive layout; built for a desktop browser window.

---

## 11. Troubleshooting

- **Dashboard shows no live status.** Same first check as the terminal UI:
  confirm `~/.scion/hooks/notify.sh` exists and is executable, and
  `~/.claude/settings.json` references it. Restart the backend to reinstall.
- **Clicking a card does nothing / shows an error toast.** If its terminal
  had ended, clicking should resume it — check the toast for the actual error
  (e.g. the worktree was deleted outside Scion).
- **A panel shows "This panel failed to render."** Rendering errors are
  contained to that panel (Terminal/Diff/Files) via an error boundary rather
  than crashing the whole app — click **Retry**, or switch tabs and back. If
  it persists, check the browser console for the underlying error.
- **Terminal says "Connecting…" forever.** Confirm the backend is running
  (`bun run web` / `bun run web:dev`) and reachable — check the browser
  console/network tab for the WebSocket connection to `/ws/terminal/…`.
- **Native module errors on start.** You're likely on Bun for the backend —
  it must run under Node (`bun run web`/`web:dev` already invoke `tsx` under
  Node; don't run `bun src/server/index.ts` directly).
