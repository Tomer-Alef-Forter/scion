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
const SOCK_KEY = createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 12);
export const DAEMON_SOCK = join(tmpdir(), `scion-${SOCK_KEY}.sock`);
export const DAEMON_LOG = join(DATA_DIR, "daemon.log");

/**
 * Unix domain socket for the (opt-in) durable PTY host — a second, separate
 * process that actually owns the node-pty sessions so the front-end-facing
 * daemon can crash and respawn WITHOUT closing the PTY master fds (and thus
 * WITHOUT SIGHUP-ing the agents). Same tmpdir/`sun_path`-length reasoning as
 * DAEMON_SOCK, keyed off DATA_DIR so isolated test runs don't collide. Only
 * used when the supervisor (src/daemon/supervisor.ts) is running; the default
 * single-process path never touches it.
 */
export const PTY_HOST_SOCK = join(tmpdir(), `scion-ptyhost-${SOCK_KEY}.sock`);
export const PTY_HOST_LOG = join(DATA_DIR, "pty-host.log");
export const SUPERVISOR_LOG = join(DATA_DIR, "supervisor.log");

/**
 * Env var the supervisor sets on the daemon it spawns. Its presence is what
 * flips the daemon from owning PTYs in-process to proxying them to the durable
 * PTY host over PTY_HOST_SOCK. Unset in every default/standalone invocation, so
 * the normal single-process behavior is completely unchanged.
 */
export const PTY_HOST_SOCK_ENV = "SCION_PTY_HOST_SOCK";
