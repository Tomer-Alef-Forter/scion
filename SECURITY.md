# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub
issue. Contact the Forter security team through the standard internal channel
(**TODO: fill in the exact Slack channel / email / ticket queue Forter uses**),
or reach the repo maintainers directly. We'll acknowledge receipt and keep you
updated on the fix.

## Security model

Scion runs entirely on your machine and orchestrates local Claude Code agents.
Two boundaries are worth understanding:

### Network exposure — localhost by default

- With zero configuration, both the backend (`5177`) and the Vite dev server
  (`5173`) bind to `127.0.0.1` only. Nothing is reachable from your network,
  and no token is required (same-machine trust).
- LAN/remote access is **opt-in and authenticated**: start with
  `SCION_HOST=0.0.0.0` (or a specific interface IP) and Scion generates a
  shared-secret token at `~/.scion/web-token`, required on every HTTP request
  and WebSocket — including the terminal socket. See
  [docs/WEB_GUIDE.md → Security model](docs/WEB_GUIDE.md#3a-security-model--localhost-by-default).
- The `Origin`/CORS check is defense-in-depth only, **not** a security boundary
  (it doesn't stop a non-browser client). The bind + token is the real control.

### Agent permissions — the worktree is the boundary

Scion launches agents in an auto-approving permission mode (e.g. Claude Code's
`--permission-mode auto`): the agent executes tool calls without a
per-action prompt. The **isolation boundary is the git worktree** — each
workspace is a separate worktree, so an agent's file changes are contained to
that workspace until you explicitly merge or open a PR. Be deliberate about
what you point agents at, and review diffs before merging. If your environment
needs per-action confirmation instead, that is a deliberate configuration
change — raise it with the maintainers.

### What stays local

Token/usage accounting is read from your own `~/.claude` transcripts; the cost
figure shown in the UI is a local estimate. Scion does not send your code,
prompts, or usage to any external service beyond the agents' own CLIs and, when
you ask for it, `gh` (GitHub) for PR operations.
