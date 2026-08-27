# Changelog

All notable changes to Scion are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-27

### Added

- **Batch launch** — fan one prompt across N worktrees and/or multiple agent
  presets in a single action, with collision-free branch names and
  all-or-nothing rollback per workspace.
- **Read-only PR status view** — each workspace with a PR shows its state,
  review decision, and CI-check status, fetched via `gh` and cached.
- **Per-session token usage + estimated cost** — real token counts read from
  Claude Code's own transcript, shown on the workspace card with a client-side
  cost estimate (`~$… est.`) from a per-model price table.
- **Daemon-survivable PTYs (opt-in)** — a supervisor + durable PTY host let
  running agents survive a daemon crash/restart (`bun run supervisor`).
- **OS notifications** for `waiting`/`review` agent transitions (when the tab
  is unfocused).
- **Hook uninstall** — `bun run uninstall-hooks` removes exactly Scion's
  Claude Code hooks; installed entries are tagged `# scion-managed`.
- **`bun run doctor`** preflight (Node/git/gh/claude + native-binding check).
- **`bun run restart-daemon`** to restart just the daemon onto new code.
- Vitest unit-test suite and a GitHub Actions CI pipeline (typecheck, tests,
  web build, migration-drift gate, smoke suites).
- `CONTRIBUTING.md`, `SECURITY.md`, and this changelog.

### Changed

- **Security: localhost-only by default.** The web backend and Vite dev server
  bind to `127.0.0.1`; LAN/remote access is opt-in via `SCION_HOST` and
  requires a generated shared-secret token on every request and WebSocket.
- Agent shutdown is now scoped per-project/per-workspace instead of always
  killing every agent everywhere.
- Corrected the non-Claude agent launch flags (cursor-agent/droid/opencode were
  missing auto-approval flags and would hang).
- Docs synced with actual daemon/PR/preset behavior; added a restart guide.
- Requires Node 20+ (was 18+).

### Removed

- Dead `"main"` workspace-type scaffolding.

## [0.1.0]

- Initial internal version: terminal UI and web UI over one engine, PTY daemon,
  worktree-per-workspace orchestration, live agent status, diffs, file browser,
  and PR creation.
