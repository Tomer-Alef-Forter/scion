# NOTICE

`Scion` is a standalone, local-only terminal UI for orchestrating
Claude Code agents across git worktrees.

It **reuses source code copied from Superset** (https://github.com/superset-sh/superset),
which is licensed under the **Elastic License 2.0 (ELv2)**. Original
copyright for the copied portions belongs to superset-sh / the Superset authors.

### Backend / terminal UI

- Worktree/git helpers, branch-name utilities, the Claude-hook status scheme,
  terminal command assembly, and the SQLite schema shape — adapted from
  `packages/host-service` and `packages/shared` in the Superset monorepo.

### Web UI

- `web/src/components/WebTerminal/WebTerminal.tsx`,
  `web/src/lib/TerminalConnection.ts` — copied from Superset's
  `apps/web/src/app/workspaces/[workspaceId]/components/WebTerminal/{WebTerminal.tsx,TerminalConnection.ts}`.
  Only the connection URL logic was rewritten (no auth/relay — a local,
  single-user server); the binary/JSON framing, reconnect/backoff, and
  visibility-resume behavior are unchanged.
- `web/src/globals.css`, `web/src/lib/utils.ts` — copied from Superset's
  `packages/ui/src/globals.css` and `packages/ui/src/lib/utils.ts` (the
  shadcn/ui "new-york"/neutral Tailwind v4 theme tokens, and the `cn` helper).
- `web/src/components/DiffPane/DiffPane.tsx`,
  `web/src/components/DiffPane/CollapsibleFileDiff.tsx` — adapted from
  Superset's
  `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/LightDiffViewer/LightDiffViewer.tsx`.
  Rewritten to use `@pierre/diffs`' multi-file-aware `parsePatchFiles` +
  `FileDiff` (Superset's version renders one file at a time via a separate
  file-tree selection) and built-in theme names instead of Superset's custom
  shiki-theme-registration system.
- `web/src/components/StatusIndicator/StatusIndicator.tsx` — copied from
  Superset's
  `apps/desktop/src/renderer/screens/main/components/StatusIndicator/StatusIndicator.tsx`
  (the `working`/`permission`→`waiting`/`review` color+pulse config), extended
  with additional states (`starting`/`idle`/`done`) our engine tracks beyond
  Superset's 3-state model.
- `web/src/components/WorkspaceGrid/WorkspaceCard.tsx` — layout cribbed from
  Superset's mock
  `apps/web/src/app/(agents)/components/SessionList/components/SessionCard/SessionCard.tsx`
  (icon + title/subtitle + relative-time row), rewired to our real workspace
  data instead of mock data.

Because this project derives from ELv2-licensed code, ELv2's terms apply to the
derived portions: retain this notice and the license, do not offer the software
to third parties as a hosted/managed service, and do not remove license or
attribution notices. See https://www.elastic.co/licensing/elastic-license for
the full ELv2 text.

This repository is intended for internal, local development use only.
