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
cd ~/Projects/scion
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

> **Both front ends can run at once.** A background daemon (auto-spawned the
> first time either one needs a PTY) owns every live agent process
> independently of the terminal UI and the web server — a workspace started
> in one is attachable from the other, and restarting either never kills a
> live agent.

---

## 3a. Security model — localhost by default

The web control surface is powerful: over it you can spawn agents, type
arbitrary input into any live agent's terminal, delete workspaces, and read
any file in a worktree. Agents run auto-approving (the worktree is the safety
boundary, not per-action confirmation), so anyone who can reach this surface
effectively has code execution on your machine. It is therefore locked down by
default.

**Default: localhost only, no auth.** With zero configuration, both the backend
(`5177`) and the Vite dev server (`5173`) bind to `127.0.0.1` — reachable only
from the same machine. Nobody on your Wi-Fi/LAN can reach them. On a
same-machine trust model no token is needed, so the local experience is
unchanged and requires no setup.

**Opt-in: LAN / remote access requires a token.** To reach the UI from another
device, set `SCION_HOST` when starting the server:

```bash
SCION_HOST=0.0.0.0 bun run web        # or a specific interface, e.g. 192.168.1.50
```

Any non-loopback bind switches on authentication automatically:

- On first network-mode run, Scion generates a random shared secret and stores
  it at `~/.scion/web-token` (0600). It's printed to the console on startup.
- Every `/api/*` request and every WebSocket (`/ws/terminal/:id`, `/ws/events`)
  must carry the token, or it's rejected with `401`. The terminal socket — the
  most dangerous surface — is gated the same as everything else.
- Hand the token to the browser once by opening the UI with it in the URL:
  `http://<host>:5177/?token=<token>`. The frontend captures it into
  `localStorage`, strips it from the address bar, and attaches it to every
  request thereafter (as an `x-scion-token` header for HTTP, and as a `token`
  query param on the WebSocket handshake, since browsers can't set custom
  headers there).

To rotate the token, delete `~/.scion/web-token` and restart in network mode; a
new one is generated (all existing browser sessions must re-open with the new
`?token=`).

> **CORS is not the boundary.** The server does check the `Origin` header, but
> that's only a browser convention — it stops a malicious web page from
> scripting the API cross-origin, and does nothing against a direct `curl` or
> raw WebSocket client that omits the header. The real boundary is the loopback
> bind plus the token above. Don't rely on CORS for security.

> The PTY daemon (a Unix-domain socket) and the Claude-hook receiver (bound to
> `127.0.0.1`) are never network-reachable regardless of `SCION_HOST`.

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

Header buttons above the tabs: **Merge** (`m`, into base branch), **Open**
(`o`, in whichever editor is set as default in Settings), **Create PR** (`p`,
push the branch and open a GitHub PR via `gh` — see §8), **Delete** (`x`,
remove the worktree, keep the branch).

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
  CLI**, **Codex**, **Cursor Agent**, **Droid**, **OpenCode**, or **GitHub
  Copilot** (7 presets). Only Claude Code reports live status via its
  lifecycle hooks (§6) — the other six have no equivalent, so their
  workspaces just show **working** for the life of the session instead of
  distinguishing working/waiting/review. This setting is shared with the
  terminal UI (same `~/.scion/host.db`), but the terminal UI has no screen to
  change it — it always launches whatever's set here.
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

Closing or restarting the web server (or the terminal UI) does **not** end a
running agent — a background daemon owns the PTY independently of either
front end. You'll still land on "resume" in one case: if the PTY daemon
itself crashes or is stopped (rare — it's a small, single-purpose process),
that agent's process really does end. The workspace itself (worktree +
branch) is always untouched either way; only the live terminal is gone.

Clicking a card with no live terminal **resumes** it: a fresh `claude` is
launched in the *same* worktree (no new worktree or branch), and if a prior
Claude `session_id` was captured from the lifecycle hook, it's passed via
`--resume` — continuing the same conversation rather than starting over.

---

## 8. Merging back, or opening a PR

**Merge** has the same semantics as the terminal UI's `m` key: merges the
workspace branch into its base branch in your **main repo checkout**, refuses
if the worktree has uncommitted changes, and on conflict aborts the merge and
restores your previous branch — the main checkout is never left in a
conflicted state. Merge is **local only** — it never pushes or touches
GitHub.

**Create PR** (`p`) is the alternative for pushing your work out: it runs
`git push -u origin <branch>` then `gh pr create --fill`, and shows you the
resulting URL. If a PR for that branch already exists (e.g. you clicked it
again after pushing more commits), it falls back to that PR's URL instead of
erroring. This is PR *creation* only — there's no in-app PR review (no diff
comments, no approve/merge-from-PR); once opened, review it on GitHub as
usual. Requires the `gh` CLI to be installed and authenticated. This action
only exists in the web UI — the terminal UI has no equivalent.

---

## 9. Where things live

Same as the terminal UI — see
[User Guide §9](./USER_GUIDE.md#9-where-things-live). The web UI adds no new
state: it's a second client over the same `~/.scion/host.db` and
worktrees.

---

## 10. Limitations (vs the terminal UI)

- Everything in the terminal UI's [Limitations](./USER_GUIDE.md#10-limitations)
  applies here too: a crash of the PTY daemon itself still ends every live
  agent (restarting a front end does not, per §3/§7); no cloud sync; and no
  in-app PR review (only PR *creation*, and only from here — see §8).
- The file browser is **read-only** — editing is the agent's job.
- No mobile/responsive layout; built for a desktop browser window.

Both front ends run at once fine (§3) — there's no "one at a time"
restriction here.

---

## 12. Token usage and estimated cost

Each workspace card shows running usage (e.g. `~$1.23 est. · 656.9k tokens ·
474 turns`) once its Claude Code agent has completed at least one turn — the
estimated cost, the sum of input + output tokens, and the turn count for the
session so far.

Where this comes from: Claude Code's lifecycle hooks (`Stop`, `SessionEnd`,
...) do **not** include token counts, cost, or turn counts in their JSON
payload — we checked the hooks reference and inspected real payloads to
confirm this. What every hook payload *does* include is `transcript_path`,
pointing at that session's own transcript JSONL
(`~/.claude/projects/<slug>/<session_id>.jsonl`). Each assistant message
Claude Code writes there carries a `usage` block (`input_tokens`,
`output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) —
real numbers Claude Code recorded itself. On every `Stop` event Scion
re-reads that file and re-sums those fields (see `src/engine/usage.ts`),
so the count shown is always a real, current total straight from Claude
Code's own record of the session — never an estimate.

**The `$` figure is an estimate, not a bill — hence the `~…est.` label.** No
cost field exists in the hook payload or the transcript, and Claude Code's own
authoritative cost is never exposed to Scion. So Scion estimates it: the model
that produced the session (also read from the transcript) picks a row in a
hardcoded per-model price table (`web/src/lib/pricing.ts`), and the token
counts above are multiplied by those rates — cache reads at 0.1× the input rate
and cache writes at 1.25×, matching Anthropic's published cache pricing. That
table is maintained by hand and **will drift** as pricing changes (it already
encodes Sonnet 5's intro-pricing expiry on 2026-08-31); treat the number as a
ballpark. Keeping the table on the client means updating a rate is a UI change,
not a restart. This is entirely local bookkeeping against your own `~/.claude`
transcripts; nothing is ever sent to Anthropic's usage API or any other
external service.

Only Claude Code workspaces get this — other agents (Gemini CLI, Codex, ...)
don't write a compatible transcript format, so their cards show no usage.

---

## 13. Troubleshooting

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
