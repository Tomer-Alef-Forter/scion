#!/usr/bin/env bash
# Launch Scion, cleanly. Frees the dev-server ports first so a stale,
# long-running instance (old code, or a DB opened before a newer migration
# existed) can't linger — the exact failure mode where the UI silently serves
# outdated behavior. Self-locating, so it works from any directory (symlink it
# onto your PATH: `ln -s "$PWD/scion.sh" /usr/local/bin/scion`).
#
# The background PTY daemon that owns every live agent is on its own socket and
# is NOT touched here — restarting the UI never kills a running agent.
#
# Usage:
#   scion.sh            # web UI, dev mode (hot-reload) — the default
#   scion.sh web        #   "
#   scion.sh prod       # web UI, built once + served on a single port (5177)
#   scion.sh tui        # terminal UI
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

# Kill whatever is LISTENING on a port, if anything (no-op when free). The
# -sTCP:LISTEN filter is important: a bare `lsof -ti tcp:PORT` also returns
# CLIENTS connected to that port (e.g. the browser's own socket), and killing
# those would take down unrelated processes like Chrome's network service.
free_port() {
	local port="$1" pids
	pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
	if [ -n "$pids" ]; then
		echo "scion: freeing port $port (pids: $pids)"
		# shellcheck disable=SC2086
		kill $pids 2>/dev/null || true
	fi
}

MODE="${1:-web}"
case "$MODE" in
	web | dev | web:dev)
		free_port 5173 # vite dev server
		free_port 5177 # backend API + WebSocket (WEB_PORT)
		sleep 1
		echo "scion: starting web UI (dev) — open http://localhost:5173"
		exec bun run web:dev
		;;
	prod | serve)
		free_port 5177
		sleep 1
		echo "scion: building + serving web UI — open http://localhost:5177"
		exec bun run web
		;;
	tui | terminal | start)
		echo "scion: starting terminal UI"
		exec bun run start
		;;
	*)
		echo "usage: scion.sh [web|prod|tui]" >&2
		exit 1
		;;
esac
