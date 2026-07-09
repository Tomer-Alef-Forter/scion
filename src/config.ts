import { homedir } from "node:os";
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
