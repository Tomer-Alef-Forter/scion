# NOTICE

`superset-local` is a standalone, local-only terminal UI for orchestrating
Claude Code agents across git worktrees.

It **reuses source code copied from Superset** (https://github.com/superset-sh/superset),
which is licensed under the **Elastic License 2.0 (ELv2)**. The copied portions
include worktree/git helpers, branch-name utilities, the Claude-hook status
scheme, terminal command assembly, and the SQLite schema shape. Original
copyright for those portions belongs to superset-sh / the Superset authors.

Because this project derives from ELv2-licensed code, ELv2's terms apply to the
derived portions: retain this notice and the license, do not offer the software
to third parties as a hosted/managed service, and do not remove license or
attribution notices. See https://www.elastic.co/licensing/elastic-license for
the full ELv2 text.

This repository is intended for internal, local development use only.
