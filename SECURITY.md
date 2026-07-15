# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Scion, please report it responsibly
by emailing **infosec@forter.com** with the details — **do not** open a public
GitHub issue for security vulnerabilities. You can also reach the repo
maintainers directly.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce it
- Any relevant proof-of-concept code or screenshots
- Your contact information for follow-up questions

We will acknowledge receipt within 48 hours and send regular updates on our
progress. If you don't hear back within 48 hours, please follow up to make sure
we received the report.

### Disclosure

We ask that you give us reasonable time to investigate and mitigate before
making anything public, make a good-faith effort to avoid privacy violations
and service disruption, and not access or modify data that isn't yours. With
your permission, we're happy to publicly acknowledge your contribution.

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

### Known, by-design local trust assumptions

These are intentional and low-risk for the local/loopback model, but worth
knowing:

- **The daemon's Unix socket** is created owner-only (`0600`) — its control
  protocol can spawn processes, so it must not be reachable by other local
  users. (Do not loosen this.)
- **The hook receiver** (`127.0.0.1:48791`, always loopback even in LAN mode)
  is unauthenticated. A local process that guesses a live terminal's random id
  could inject fake *status* events — it cannot run code or read data. Same-
  machine trust only.
- **The web auth token** is passed in the WebSocket URL query string (browsers
  can't set handshake headers). It's stripped from the address bar on load and
  traffic is loopback/same-origin, but it would appear in the access logs of
  any proxy you deliberately place in front of Scion.
