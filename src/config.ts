import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Everything Scion owns lives under here. */
export const DATA_DIR = join(homedir(), ".scion");
export const DB_PATH = join(DATA_DIR, "host.db");
export const HOOKS_DIR = join(DATA_DIR, "hooks");
export const NOTIFY_SCRIPT_PATH = join(HOOKS_DIR, "notify.sh");
export const WORKTREES_ROOT = join(DATA_DIR, "worktrees");
export const INSTALLED_MARKER = join(DATA_DIR, ".installed");

/** Localhost port for the Claude-hook receiver (Bun.serve). */
export const HOOK_PORT = 48791;
export const HOOK_URL = `http://127.0.0.1:${HOOK_PORT}/hook`;

/** Localhost port for the web UI's HTTP + WebSocket server. */
export const WEB_PORT = 5177;

/**
 * Unix domain socket for the PTY daemon. NOT under DATA_DIR — a `sun_path` is
 * capped at ~104 bytes on macOS, and the isolated-HOME test dir
 * (/var/folders/.../sl-isolated-home-XXXXXX/.scion/...) can blow past that.
 * Lives in the OS tmpdir instead, short and stable, but still keyed off
 * DATA_DIR so isolated test runs (a different DATA_DIR) get their own daemon
 * instead of colliding with a real one.
 */
export const DAEMON_SOCK = join(
	tmpdir(),
	`scion-${createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 12)}.sock`,
);
export const DAEMON_LOG = join(DATA_DIR, "daemon.log");
