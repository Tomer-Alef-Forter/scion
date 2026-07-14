# Scion — Visual Guide

A picture-first tour of Scion: what the screens look like, how data
flows, how agent status changes, and the full lifecycle of a worktree. For the
prose reference see [USER_GUIDE.md](./USER_GUIDE.md).

---

## 1. The big picture

Scion is a terminal UI that spawns Claude Code agents into isolated git
worktrees and listens for their lifecycle events to show live status.

```
  🧑 YOU
   │  press n
   ▼
┌────────────────────┐
│    Scion TUI       │
│    (Ink / React)   │
└──────────┬─────────┘
           │ 1. branch a worktree off base, spawn claude inside it
           ▼
┌────────────────────┐   branched   ┌─────────────────────┐
│  worktree /branch  │◄─────────────│  base branch        │
│  (isolated copy)   │    from      │  (main / develop)   │
└──────────┬─────────┘              └──────────▲──────────┘
           │ 2. agent edits files              │
           ▼                                   │ 5. press m → git merge --no-ff
┌────────────────────┐                         │
│ claude agent (PTY) │─────────────────────────┘
└──────────┬─────────┘
           │ 3. lifecycle events → hooks/notify.sh → POST 127.0.0.1:48791
           ▼
┌────────────────────┐   4. status + diff   ┌─────────────────────┐
│  host.db (SQLite)  │─────────────────────►│  dashboard lights up│
│ projects·workspaces│                      │  [working/review/…] │
└────────────────────┘                      └─────────────────────┘
```

**Read it as:** you press `n` → a worktree is branched off your base → `claude`
is spawned inside it → as the agent works, its hooks POST events to a localhost
receiver → status lands in SQLite → the dashboard lights up → you press `m` to
merge the branch back.

> Simplified: the PTY box above is actually owned by a small background
> daemon (auto-spawned the first time it's needed), not by the TUI process
> itself — so quitting or restarting the TUI never kills a running agent; you
> reattach to the same live session next time. The one thing that *does* end
> a live agent is the daemon itself crashing (rare, single-purpose process) —
> the worktree, branch, and DB state all survive that regardless. See
> [USER_GUIDE.md §10](./USER_GUIDE.md#10-limitations). There's also a second,
> optional front end — a web UI — that's a client of the exact same daemon +
> `host.db`; see [WEB_GUIDE.md](./WEB_GUIDE.md).

---

## 2. Screen map

Three screens plus two full-screen modes. Everything is keyboard-driven.

```
  PROJECTS ──enter──►  DASHBOARD ──n──────►  NEW WORKSPACE ─┐
     ▲                    │ ▲                 enter / esc    │
     │                    │ └───────────────────────────────┘
     └──── b / esc ───────┘
                          │
                          ├──enter──►  ATTACH  ──Ctrl-b d──►  back to DASHBOARD
                          │
                          └──d──────►  DIFF    ──q─────────►  back to DASHBOARD

  q quits from PROJECTS or DASHBOARD.
```

---

## 3. The screens, as you'll see them

### 3.1 Projects

```
┌─ Scion · projects ─────────────────────────────────────────────────┐
│                                                                    │
│  ❯ analytics        /Users/tomeralef/dev/analytics                 │
│    scion            /Users/tomeralef/Projects/scion                │
│                                                                    │
│  ↑/↓ select · enter open · a add · x remove · q quit               │
└────────────────────────────────────────────────────────────────────┘
```

Press `a` to add a repo — an inline prompt appears (`~` is expanded):

```
┌─ Scion · projects ─────────────────────────────────────────────────┐
│                                                                    │
│  ❯ analytics        /Users/tomeralef/dev/analytics                 │
│                                                                    │
│  Repo path: ~/dev/my-service▊                                      │
│                                                                    │
│  ↑/↓ select · enter open · a add · x remove · q quit               │
└────────────────────────────────────────────────────────────────────┘
```

### 3.2 Dashboard (workspaces)

The heart of the app. `❯` marks the selected row; the colored `[status]` is
live; the trailing parens show branch + diff summary.

```
┌─ analytics · workspaces ──────────────────────────────────────────────────┐
│                                                                            │
│  ❯ [review]    fix-login-bug   (feat/fix-login-bug-a8f3 · 3f +42/-7 · 1 …) │
│    [working]   add-tests       (add-tests-9k2p · 1f +18/-0)                │
│    [waiting]   refactor-api    (refactor-api-2m5x · 6f +90/-120)           │
│    [idle]      tidy-readme     (tidy-readme-7q1z · 1f +4/-2)               │
│                                                                            │
│  ↑/↓ · enter attach · n new · d diff · m merge · o open · x remove ·       │
│  b back · q quit                                                           │
└────────────────────────────────────────────────────────────────────────────┘
```

Anatomy of a row:

```
  ❯ [review]    fix-login-bug  (feat/fix-login-bug-a8f3 · 3f +42/-7 · 1 uncommitted)
  │  └ status   └ name          └ branch          │       │      └ uncommitted files
  └ selected                                       │       └ +insertions / -deletions
                                                   └ files changed
```

### 3.3 New workspace

```
┌─ New workspace ───────────────────────────────────────────────────┐
│  Describe the task for Claude. A worktree + branch are created     │
│  and the agent launches with this prompt.                         │
│                                                                    │
│  Task: fix the flaky login redirect test▊                         │
│                                                                    │
│  enter create · esc cancel                                        │
└────────────────────────────────────────────────────────────────────┘
```

While it works:

```
│  Task: creating worktree + launching claude…                      │
```

### 3.4 Attach mode (full screen)

`enter` on a row drops you straight into the agent's live terminal — raw
passthrough, scrollback replayed:

```
════════════════════════════════════════════════════════════════════
 (the agent's real Claude Code session — you type directly to it)

 ● I'll fix the flaky login redirect test. Let me read the test…

 [scion] attached — press Ctrl-b then d to detach
════════════════════════════════════════════════════════════════════
```

Detach with **`Ctrl-b` then `d`** — the agent keeps running in the background.

### 3.5 Diff mode (full screen)

`d` on a row opens the worktree's colored diff vs its base in `less -R`:

```
────────────────────────────────────────────────────────────────────
 diff --git a/login.py b/login.py
 @@ -12,7 +12,7 @@ def redirect(...):
 -    return redirect(next_url)
 +    return redirect(next_url, code=302)
 (END)   ← press q to return to the dashboard
────────────────────────────────────────────────────────────────────
```

---

## 4. Agent status — the state machine

Each dashboard `[label]` is derived from the last lifecycle hook event the agent
sent. Colors match the UI.

```
  [starting] ──Start──►  [working] ──PermissionRequest──►  [waiting]
   (cyan)                 (yellow)  ◄────Start (approved)───(magenta)
                             │
                             │ Stop (turn finished)
                             ▼
                          [review] ──you attach──►  [idle]
                          (green)                   (white)
                             │                         │
                             └──── Start (next turn) ──┴──►  back to [working]

  From ANY state, when the session ends  ──►  [done] (gray)
```

| Label       | Color    | Meaning                                    | Your move                |
|-------------|----------|--------------------------------------------|--------------------------|
| `starting`  | cyan     | terminal live, no event yet                | wait                     |
| `working`   | yellow   | a turn is running                          | let it cook              |
| `waiting`   | magenta  | hit a permission request                   | **attach & approve**     |
| `review`    | green    | turn finished, you haven't looked          | **diff / attach**        |
| `idle`      | white    | finished, already seen                     | merge or move on         |
| `done`      | gray     | no live terminal (session ended)           | remove or restart        |

> `review → idle` happens the moment you attach: attaching marks the workspace
> "seen," so green (needs attention) fades to white (handled).

---

## 5. Worktree lifecycle

From `n` to merged-or-gone.

```
  n new
     │
     ▼
  git worktree add --no-track -b branch   (off base)
     │
     ▼
  spawn claude with your prompt
     │
     ▼
  agent works in the worktree  ◄──────┐
     │                                │ not yet
     ▼                                │
  review  (d = diff)  ────────────────┘
     │
     ├── looks good ──►  m merge --no-ff → base  ──►  ✅ in base branch
     │
     └── discard ─────►  x remove worktree (branch kept)  ──►  🗑️ gone
```

### The merge guardrails (`m`)

```
  press m
     │
     ▼
  worktree clean?  ──no──►  ❌ refuse: commit or discard first
     │
    yes
     ▼
  checkout base in main repo
     │
     ▼
  git merge --no-ff branch
     │
     ├── success ──►  ✅ merged into base
     │
     └── conflict ─►  merge --abort + restore previous branch
                      ⚠️ resolve manually  (main repo left clean)
```

Key safety properties, straight from the code:

- **Uncommitted changes → merge is refused** (nothing partial gets merged).
- **Conflict → merge is aborted and your previous branch is restored** — the
  main checkout is never left in a conflicted state.
- Merge (`m`) is **local only** — it does not push or touch a PR. The web UI
  has a separate **Create PR** action (push + `gh pr create`) that this
  terminal UI has no equivalent for; see
  [WEB_GUIDE.md §8](./WEB_GUIDE.md#8-merging-back-or-opening-a-pr).

---

## 6. Keymap at a glance

```
PROJECTS                         DASHBOARD
┌──────────────────────┐         ┌──────────────────────────────────┐
│ ↑ ↓   move           │         │ ↑ ↓   move                       │
│ a     add repo       │         │ n     new workspace              │
│ enter open           │         │ enter attach agent               │
│ x     remove (list)  │         │ d     diff vs base               │
│ q     quit           │         │ m     merge → base               │
└──────────────────────┘         │ o     open in editor             │
                                 │ x     remove worktree            │
ATTACH MODE                      │ b/esc back                       │
┌──────────────────────┐         │ q     quit                       │
│ Ctrl-b d   detach    │         └──────────────────────────────────┘
│ (all else → agent)   │
└──────────────────────┘         DIFF MODE (less -R):  q  quit
```

---

## 7. What lives where

```
~/.scion/
├── host.db                      ← SQLite: projects, workspaces, agent bindings
├── .installed                   ← first-run marker (timestamp)
├── hooks/
│   └── notify.sh                ← posts agent lifecycle events → :48791
└── worktrees/
    └── <projectId>/
        └── <branch>/            ← one isolated checkout per workspace

~/.claude/settings.json          ← lifecycle hooks merged in here (not clobbered)
```

---

## 8. One-glance mental model

```
   ┌─────────┐   n    ┌───────────┐  spawn  ┌──────────┐
   │ PROJECT │──────► │ WORKTREE  │───────► │  AGENT   │
   │ (repo)  │        │ (branch)  │         │ (claude) │
   └─────────┘        └───────────┘         └────┬─────┘
        ▲                   ▲                     │ hooks
        │ m (merge)         │ d (diff)            ▼
        └───────────────────┴──────────  [status: working/waiting/review]
```

> **One repo → many worktrees → many agents, each on its own branch, all
> visible on one dashboard.** That's Scion.
